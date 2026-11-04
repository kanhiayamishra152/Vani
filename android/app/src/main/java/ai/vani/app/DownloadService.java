package ai.vani.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Vani AI — resumable native model downloader.
 * Streams to getFilesDir()/models/<file>.part with HTTP Range resumption from
 * the exact byte offset, foreground-service notifications with Pause / Resume
 * / Cancel actions, and automatic .tar.bz2 extraction for voice engines.
 */
public class DownloadService extends Service {
    private static final String TAG = "VaniDownload";
    public static final String ACTION_START = "ai.vani.app.START";
    public static final String ACTION_PAUSE = "ai.vani.app.PAUSE";
    public static final String ACTION_RESUME = "ai.vani.app.RESUME";
    public static final String ACTION_CANCEL = "ai.vani.app.CANCEL";
    private static final String CHANNEL = "vani-downloads";

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ConcurrentHashMap<String, String> liveState = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, JSONObject> liveMeta = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, HttpURLConnection> liveConnections = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Thread> liveWorkers = new ConcurrentHashMap<>();
    private PowerManager.WakeLock wakeLock;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean pumping = false;
    private volatile boolean destroyed = false;

    public static void start(Context ctx, JSONObject args) throws Exception {
        Intent i = new Intent(ctx, DownloadService.class);
        i.setAction(ACTION_START);
        i.putExtra("entry", args.toString());
        ctx.startForegroundService(i);
    }

    public static void command(Context ctx, String action, String id) {
        command(ctx, action, id, "");
    }

    public static void command(Context ctx, String action, String id, String groupId) {
        Intent i = new Intent(ctx, DownloadService.class);
        i.setAction(action);
        i.putExtra("id", id);
        i.putExtra("groupId", groupId == null ? "" : groupId);
        ctx.startForegroundService(i);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        destroyed = false;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.download_channel), NotificationManager.IMPORTANCE_LOW);
        ch.setDescription(getString(R.string.download_channel_desc));
        nm.createNotificationChannel(ch);
        // Restore interrupted states as paused (resumable from .part offset).
        JSONArray saved = Downloads.list(this);
        for (int i = 0; i < saved.length(); i++) {
            JSONObject e = saved.optJSONObject(i);
            if (e == null) continue;
            String st = e.optString("state");
            if (st.equals("downloading") || st.equals("queued") || st.equals("extracting") || st.equals("finalizing")) {
                long recv = e.optLong("received", 0), tot = e.optLong("total", 0);
                try {
                    if (tot > 0 && recv >= tot) {
                        // Fully downloaded before interruption: auto-finalize, never "Resume at 100%".
                        e.put("state", "queued"); e.put("error", "");
                    } else {
                        e.put("state", "paused"); e.put("error", "Interrupted — tap Resume");
                    }
                } catch (Exception ignored) {}
                Downloads.upsert(this, e);
            }
            liveMeta.put(e.optString("id"), e);
            liveState.put(e.optString("id"), e.optString("state"));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || destroyed) return START_NOT_STICKY;
        String action = intent.getAction();
        // Every command, including commands delivered after recreation, must
        // enter the foreground before doing any other work.
        try {
            startForeground(notifId("summary"), buildSummary("Preparing download…"));
        } catch (Throwable t) {
            Log.e(TAG, "unable to enter foreground", t);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            if (ACTION_START.equals(action)) {
                JSONObject e = new JSONObject(intent.getStringExtra("entry"));
                String id = e.getString("id");
                String cleanFileName = SafeFilename.clean(e.getString("fileName"));
                e.put("fileName", cleanFileName);
                File part = SafeFilename.safeChild(Models.modelsDir(this), cleanFileName + ".part");
                e.put("received", part.exists() ? part.length() : 0);
                e.put("state", "queued");
                e.put("speed", 0);
                e.put("error", "");
                liveMeta.put(id, e);
                liveState.put(id, "queued");
                Downloads.upsert(this, e);
                emit("download.state", e.toString());
                pump();
            } else if (ACTION_PAUSE.equals(action)) {
                String id = intent.getStringExtra("id");
                liveState.put(id, "paused");
                patchPersist(id, "state", "paused");
                emitState(id);
            } else if (ACTION_RESUME.equals(action)) {
                String id = intent.getStringExtra("id");
                liveState.put(id, "queued");
                patchPersist(id, "state", "queued");
                patchPersist(id, "error", "");
                emitState(id);
                pump();
            } else if (ACTION_CANCEL.equals(action)) {
                cancel(intent.getStringExtra("id"), intent.getStringExtra("groupId"));
            }
        } catch (Exception e) {
            Log.e(TAG, "command failed", e);
        }
        // Drain any entries onCreate restored to "queued" (e.g. auto-finalize a
        // fully-downloaded model after an app kill). pump() is idempotent.
        pump();
        return START_NOT_STICKY;
    }

    private synchronized void pump() {
        if (pumping || destroyed || worker.isShutdown()) return;
        pumping = true;
        try {
            worker.submit(() -> {
                try {
                    acquireWake();
                    while (!destroyed) {
                        Thread.interrupted();
                        JSONObject next = null;
                        for (JSONObject e : liveMeta.values()) {
                            if ("queued".equals(liveState.get(e.optString("id")))) { next = e; break; }
                        }
                        if (next == null) break;
                        downloadWithRetry(next);
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "download worker failed", t);
                    for (JSONObject e : liveMeta.values()) {
                        String id = e.optString("id");
                        String st = liveState.get(id);
                        if ("queued".equals(st) || "downloading".equals(st)) {
                            liveState.put(id, "paused");
                            patchPersist(id, "state", "paused");
                            patchPersist(id, "error", "Download interrupted safely — tap Resume");
                            emitState(id);
                        }
                    }
                } finally {
                    releaseWake();
                    synchronized (DownloadService.this) { pumping = false; }
                    // A producer can queue work while this worker is exiting.
                    if (hasQueued()) pump();
                    else main.post(this::stopIfIdle);
                }
            });
        } catch (RejectedExecutionException e) {
            pumping = false;
            Log.e(TAG, "download executor rejected work", e);
        }
    }

    private boolean hasQueued() {
        if (destroyed) return false;
        for (String st : liveState.values()) if ("queued".equals(st)) return true;
        return false;
    }

    private void acquireWake() {
        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vani:download");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(60 * 60 * 1000L);
    }
    private void releaseWake() { try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {} }

    private void downloadWithRetry(JSONObject e) {
        String id = e.optString("id");
        liveWorkers.put(id, Thread.currentThread());
        int retries = 0;
        try {
            while (true) {
                String st = liveState.get(id);
                if (!"queued".equals(st) && !"downloading".equals(st)) return;
                try {
                    download(e);
                    return;
                } catch (Exception ex) {
                    Log.w(TAG, "download error: " + ex.getMessage());
                    String cur = liveState.get(id);
                    if ("paused".equals(cur) || "cancelled".equals(cur)) return;
                    retries++;
                    if (retries > 3) {
                        liveState.put(id, "paused");
                        patchPersist(id, "state", "paused");
                        patchPersist(id, "error", ex.getMessage() + " — tap Resume to continue from the exact byte offset");
                        emitState(id);
                        return;
                    }
                    try { Thread.sleep(2000L * retries); }
                    catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return; }
                }
            }
        } finally {
            liveWorkers.remove(id);
        }
    }

    private static class PauseSignal extends Exception {}
    private static class CancelSignal extends Exception {}

    private static String sanitize(String s) { return s.replaceAll("[^A-Za-z0-9._-]", "_"); }

    /**
     * Download one URL to {@code dest} (final path) via {@code dest.part} + HTTP Range.
     * Emits aggregate progress (baseReceived + received) / totalAll. Idempotent: a
     * complete final file is skipped. Throws PauseSignal / CancelSignal on user action.
     */
    private long downloadOne(JSONObject e, String url, File dest, long expected, long baseReceived, long totalAll) throws Exception {
        String id = e.getString("id");
        if (dest.exists() && expected > 0 && dest.length() == expected) return dest.length();
        File parent = dest.getParentFile();
        if (parent == null || (!parent.exists() && !parent.mkdirs()))
            throw new IOException("Cannot create model directory");
        File part = new File(parent, dest.getName() + ".part");
        long offset = part.exists() ? part.length() : 0;
        if (expected > 0 && offset > expected) {
            if (!part.delete()) throw new IOException("Cannot discard oversized partial file");
            offset = 0;
        }
        if (expected > 0 && offset == expected) {
            if (dest.exists() && !dest.delete()) throw new IOException("Cannot replace old model file");
            if (!part.renameTo(dest)) throw new IOException("Cannot finalize completed partial file");
            return expected;
        }

        // HTTPS + host allowlist is checked on every redirect hop. Redirects are
        // bounded and manually followed so a resume never bypasses this policy.
        if (!SafeFilename.isAllowedUrl(url)) throw new IOException("Blocked download URL (HTTPS + allowlist only)");
        String current = url;
        HttpURLConnection con = null;
        try {
            int code = 0;
            for (int hop = 0; hop < 6; hop++) {
                con = (HttpURLConnection) new URL(current).openConnection();
                liveConnections.put(id, con);
                con.setConnectTimeout(30000);
                con.setReadTimeout(60000);
                con.setInstanceFollowRedirects(false);
                con.setRequestProperty("User-Agent", "VaniAI/1.5.1 (Android)");
                con.setRequestProperty("Accept-Encoding", "identity");
                if (offset > 0) con.setRequestProperty("Range", "bytes=" + offset + "-");
                code = con.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String loc = con.getHeaderField("Location");
                    liveConnections.remove(id, con);
                    con.disconnect();
                    if (loc == null) throw new IOException("redirect without Location");
                    String next = new URL(new URL(current), loc).toString();
                    if (!SafeFilename.isAllowedUrl(next)) throw new IOException("Blocked redirect to disallowed host");
                    current = next;
                    continue;
                }
                break;
            }
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            if ("cancelled".equals(liveState.get(id))) throw new CancelSignal();
            if (code == 206) validateContentRange(con.getHeaderField("Content-Range"), offset, expected);

            boolean append = code == 206;
            // A 200 response ignored Range: truncate, never append a full file to
            // an existing part. A validated 206 starts at exactly our offset.
            if (code == 200 && offset > 0) { offset = 0; append = false; }
            long responseLength = con.getContentLengthLong();
            if (expected > 0 && responseLength >= 0 && responseLength != expected - offset)
                throw new IOException("Unexpected response length; partial file retained for safe retry");

            liveState.put(id, "downloading");
            patchPersist(id, "state", "downloading");
            if (totalAll > 0) patchPersist(id, "total", totalAll);
            emitState(id);

            long received = offset;
            long lastEmit = System.currentTimeMillis(), lastBytes = offset;
            double speed = 0;
            try (InputStream in = new BufferedInputStream(con.getInputStream(), 65536);
                 FileOutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) {
                    String st = liveState.get(id);
                    if ("paused".equals(st)) {
                        patchPersist(id, "received", baseReceived + received);
                        patchPersist(id, "state", "paused");
                        emitProgress(id, baseReceived + received, totalAll, 0, "paused");
                        throw new PauseSignal();
                    }
                    if ("cancelled".equals(st)) { part.delete(); throw new CancelSignal(); }
                    out.write(buf, 0, n);
                    received += n;
                    long now = System.currentTimeMillis();
                    if (now - lastEmit >= 400) {
                        double inst = (received - lastBytes) * 1000.0 / Math.max(1, now - lastEmit);
                        speed = speed == 0 ? inst : speed * 0.7 + inst * 0.3;
                        lastEmit = now; lastBytes = received;
                        emitProgress(id, baseReceived + received, totalAll, speed, "downloading");
                        patchPersist(id, "received", baseReceived + received);
                        notifyProgress(e, baseReceived + received, totalAll, speed);
                    }
                }
                out.getFD().sync();
            }
            if ("cancelled".equals(liveState.get(id))) { part.delete(); throw new CancelSignal(); }
            if (expected > 0 && received != expected)
                throw new IOException("Unexpected EOF (" + received + "/" + expected + " bytes); resume will continue");
            if (expected <= 0 && responseLength >= 0 && received - offset != responseLength)
                throw new IOException("Truncated response; partial file retained");
            if (dest.exists() && !dest.delete()) throw new IOException("Cannot replace old model file");
            if (!part.renameTo(dest)) throw new IOException("rename failed");
            return dest.length();
        } finally {
            if (con != null) con.disconnect();
            liveConnections.remove(id);
        }
    }

    private static void validateContentRange(String value, long offset, long expected) throws IOException {
        String prefix = "bytes " + offset + "-";
        if (value == null || !value.startsWith(prefix))
            throw new IOException("Server returned an invalid Content-Range; partial file retained");
        int slash = value.indexOf('/');
        int dash = value.indexOf('-', 5);
        if (slash < 0 || dash < 0 || slash <= dash + 1) throw new IOException("Malformed Content-Range");
        try {
            long end = Long.parseLong(value.substring(dash + 1, slash).trim());
            if (end < offset) throw new IOException("Invalid Content-Range end");
            String totalText = value.substring(slash + 1).trim();
            if ("*".equals(totalText)) {
                if (expected > 0) throw new IOException("Server did not confirm the resumed file size");
            } else {
                long total = Long.parseLong(totalText);
                if (total <= end || (expected > 0 && total != expected))
                    throw new IOException("Content-Range total does not match the model manifest");
            }
        } catch (NumberFormatException e) {
            throw new IOException("Malformed Content-Range", e);
        }
    }

    private void download(JSONObject e) throws Exception {
        String id = e.getString("id");
        File modelsDir = Models.modelsDir(this);

        // Idempotent finalize: if this exact model+quant is already installed with a
        // valid path, never re-download — just mark done (fixes "Resume at 100%").
        JSONArray installed = Models.list(this);
        for (int i = 0; i < installed.length(); i++) {
            JSONObject m = installed.optJSONObject(i);
            if (m == null) continue;
            if (m.optString("modelId").equals(e.optString("modelId"))
                    && m.optString("kind").equals(e.optString("kind"))
                    && m.optString("quant").equals(e.optString("quant"))
                    && !m.optString("path").isEmpty() && new File(m.optString("path")).exists()) {
                finishDone(e, id);
                return;
            }
        }

        JSONArray files = e.optJSONArray("files");
        String path;
        boolean isDir = false;
        long size;
        try {
            if (files != null && files.length() > 0) {
                // Multi-file standalone model (no archive extraction).
                File targetDir = SafeFilename.safeChild(modelsDir, sanitize(e.optString("modelId", id)));
                targetDir.mkdirs();
                long totalAll = 0;
                for (int i = 0; i < files.length(); i++) totalAll += files.getJSONObject(i).optLong("bytes", 0);
                if (totalAll <= 0) totalAll = e.optLong("total", 0);
                patchPersist(id, "total", totalAll);
                long receivedAll = 0;
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    File dest = SafeFilename.safeChild(targetDir, f.getString("name"));
                    receivedAll += downloadOne(e, f.getString("url"), dest, f.optLong("bytes", 0), receivedAll, totalAll);
                }
                path = targetDir.getAbsolutePath();
                isDir = true;
                size = Models.treeSize(targetDir);
            } else {
                String fileName = e.getString("fileName");
                File fin = SafeFilename.safeChild(modelsDir, fileName);
                long total = e.optLong("total", 0);
                boolean haveComplete = fin.exists() && (total <= 0 || fin.length() == total);
                if (!haveComplete) {
                    downloadOne(e, e.getString("url"), fin, total, 0, total);
                }
                path = fin.getAbsolutePath();
                size = fin.length();
                if (e.optBoolean("extract")) {
                    liveState.put(id, "extracting");
                    patchPersist(id, "state", "extracting");
                    emitProgress(id, total, total, 0, "extracting");
                    File dir = extractTarBz2(fin, modelsDir, id, e);
                    path = dir.getAbsolutePath();
                    isDir = true;
                    size = Models.treeSize(dir);
                    fin.delete();
                }
            }
        } catch (PauseSignal ps) {
            return;
        } catch (CancelSignal cs) {
            return;
        }

        // Register + finalize only if the user did not cancel the group.
        if ("cancelled".equals(liveState.get(id))) { deleteParts(e); return; }
        liveState.put(id, "finalizing");
        emitProgress(id, e.optLong("total", 0), e.optLong("total", 0), 0, "finalizing");
        JSONObject reg = new JSONObject();
        reg.put("modelId", e.optString("modelId"));
        reg.put("name", e.optString("name", e.optString("fileName", "model")));
        reg.put("kind", e.optString("kind"));
        reg.put("quant", e.optString("quant"));
        reg.put("fileName", e.optString("fileName", ""));
        reg.put("path", path);
        reg.put("dir", isDir);
        reg.put("sizeBytes", size);
        reg.put("engine", engineFor(e.optString("modelId"), e.optString("engine")));
        reg.put("category", e.optString("category"));
        Models.register(this, reg);
        finishDone(e, id);
    }

    private void finishDone(JSONObject e, String id) throws Exception {
        if ("cancelled".equals(liveState.get(id))) return;
        liveState.put(id, "done");
        liveMeta.remove(id);
        Downloads.remove(this, id);
        getSystemService(NotificationManager.class).cancel(notifId(id));
        notifyDone(e);
        emit("download.done", new JSONObject().put("id", id).put("name", e.optString("name")).toString());
        emit("models.changed", "{}");
    }

    private static String engineFor(String modelId, String hint) {
        if (hint != null && !hint.isEmpty()) return hint;
        switch (modelId) {
            case "phonon":
            case "piper-lessac": return "vits";
            case "phonon-ultra": return "kokoro";
            case "pocket-tts": return "pocket";
            case "kokoro": return "kokoro";
            case "whisper-tiny":
            case "whisper-base":
            case "whisper-small": return "whisper";
            case "moonshine-tiny":
            case "moonshine-base": return "moonshine";
            case "sensevoice": return "sensevoice";
            case "zipformer": return "zipformer";
            default: return "";
        }
    }

    /** Extract .tar.bz2 safely with live progress; returns the top-level model dir. */
    private File extractTarBz2(File archive, File destRoot, String id, JSONObject e) throws Exception {
        String topDir = null;
        long lastEmit = 0;
        int entries = 0;
        long extracted = 0;
        try (TarArchiveInputStream tar = new TarArchiveInputStream(
                new BZip2CompressorInputStream(new BufferedInputStream(new FileInputStream(archive), 65536)))) {
            TarArchiveEntry entry;
            byte[] buf = new byte[65536];
            while ((entry = tar.getNextTarEntry()) != null) {
                if ("cancelled".equals(liveState.get(id))) throw new CancelSignal();
                String name = entry.getName();
                if (name.contains("..")) continue;
                if (topDir == null) {
                    int slash = name.indexOf('/');
                    topDir = slash > 0 ? name.substring(0, slash) : name;
                }
                File out = new File(destRoot, name);
                // v1.3.0: canonical-path guard — archive entries can never escape
                // the models sandbox (zip-slip / tar-slip protection).
                if (!out.getCanonicalPath().startsWith(destRoot.getCanonicalPath() + File.separator)) continue;
                if (entry.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = tar.read(buf)) > 0) { fos.write(buf, 0, n); extracted += n; }
                }
                entries++;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 400) {
                    lastEmit = now;
                    emitProgress(id, e.optLong("total", 0), e.optLong("total", 0), 0, "extracting");
                    notifyExtracting(e, entries, extracted);
                }
            }
        }
        File dir = topDir != null ? SafeFilename.safeChild(destRoot, topDir) : destRoot;
        if (!dir.getCanonicalPath().equals(destRoot.getCanonicalPath())
                && !dir.getCanonicalPath().startsWith(destRoot.getCanonicalPath() + File.separator)) {
            throw new IOException("archive top-level path escaped model sandbox");
        }
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    private void notifyExtracting(JSONObject e, int entries, long extracted) {
        String id = e.optString("id");
        String mb = String.format(Locale.US, "Extracting… %.0f MB (%d files)", extracted / 1048576.0, entries);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(e.optString("name", "Installing model"))
                .setContentText(mb)
                .setProgress(100, 100, true)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        getSystemService(NotificationManager.class).notify(notifId(id), n);
    }

    /* ---------------- notifications ---------------- */
    private int notifId(String id) { return Math.abs(id.hashCode() % 100000) + 10; }

    private PendingIntent actionIntent(String action, String id) { return actionIntent(action, id, ""); }

    private PendingIntent actionIntent(String action, String id, String groupId) {
        Intent i = new Intent(this, DownloadService.class);
        i.setAction(action);
        i.putExtra("id", id);
        i.putExtra("groupId", groupId == null ? "" : groupId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getService(this, (action + id).hashCode(), i, flags);
    }

    private Notification buildSummary(String text) {
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Vani AI")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void notifyProgress(JSONObject e, long received, long total, double speed) {
        String id = e.optString("id");
        int pct = total > 0 ? (int) (100 * received / total) : 0;
        String mb = String.format(Locale.US, "%.0f / %.0f MB · %.1f MB/s",
                received / 1048576.0, total / 1048576.0, speed / 1048576.0);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(e.optString("name", "Downloading model"))
                .setContentText(mb)
                .setProgress(100, pct, total <= 0)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(android.R.drawable.ic_media_pause, "Pause", actionIntent(ACTION_PAUSE, id))
                .addAction(android.R.drawable.ic_delete, "Cancel", actionIntent(ACTION_CANCEL, id, e.optString("groupId")))
                .build();
        getSystemService(NotificationManager.class).notify(notifId(id), n);
    }

    private void notifyDone(JSONObject e) {
        String id = e.optString("id");
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Download complete")
                .setContentText(e.optString("name", "Model") + " is ready to load")
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(notifId(id), n);
    }

    /** Cancel every segment of a model/projector group without touching other jobs. */
    private void cancel(String id, String groupId) throws Exception {
        ArrayList<JSONObject> affected = new ArrayList<>();
        if (groupId != null && !groupId.isEmpty()) {
            for (JSONObject e : liveMeta.values()) {
                if (groupId.equals(e.optString("groupId"))) affected.add(e);
            }
        }
        if (affected.isEmpty() && id != null) {
            JSONObject e = liveMeta.get(id);
            if (e != null) affected.add(e);
        }
        for (JSONObject e : affected) {
            String partId = e.optString("id");
            liveState.put(partId, "cancelled");
            deleteParts(e);
        }
        for (JSONObject e : affected) {
            String partId = e.optString("id");
            HttpURLConnection con = liveConnections.remove(partId);
            if (con != null) con.disconnect();
            Thread thread = liveWorkers.get(partId);
            if (thread != null) thread.interrupt();
        }
        for (JSONObject e : affected) {
            String partId = e.optString("id");
            liveMeta.remove(partId);
            Downloads.remove(this, partId);
            getSystemService(NotificationManager.class).cancel(notifId(partId));
            emit("download.state", new JSONObject().put("id", partId).put("groupId", e.optString("groupId")).put("state", "cancelled").toString());
        }
        stopIfIdle();
    }

    private void deleteParts(JSONObject e) {
        try {
            File root = Models.modelsDir(this);
            String fileName = e.optString("fileName");
            if (!fileName.isEmpty()) SafeFilename.safeChild(root, fileName + ".part").delete();
            JSONArray files = e.optJSONArray("files");
            if (files != null) {
                File dir = SafeFilename.safeChild(root, sanitize(e.optString("modelId", e.optString("id"))));
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.optJSONObject(i);
                    if (f == null) continue;
                    File dest = SafeFilename.safeChild(dir, f.optString("name"));
                    new File(dest.getParentFile(), dest.getName() + ".part").delete();
                }
            }
        } catch (Exception ignored) {}
    }

    /* ---------------- state helpers ---------------- */
    private void patchPersist(String id, String key, Object val) {
        try {
            JSONObject e = liveMeta.get(id);
            if (e != null) { e.put(key, val); Downloads.upsert(this, e); }
        } catch (Exception ignored) {}
    }

    private void emitState(String id) {
        JSONObject e = liveMeta.get(id);
        if (e == null) return;
        try {
            JSONObject p = new JSONObject(e.toString());
            p.put("state", liveState.getOrDefault(id, e.optString("state")));
            emit("download.state", p.toString());
        } catch (Exception ignored) {}
    }

    private void emitProgress(String id, long received, long total, double speed, String state) {
        try {
            JSONObject p = new JSONObject();
            p.put("id", id);
            p.put("received", received);
            p.put("total", total);
            p.put("speed", (long) speed);
            p.put("state", state);
            emit("download.progress", p.toString());
        } catch (Exception ignored) {}
    }

    private void emit(String event, String payload) {
        MainActivity a = MainActivity.instance;
        if (a != null) a.emit(event, payload);
    }

    private void stopIfIdle() {
        for (String st : liveState.values()) {
            if ("queued".equals(st) || "downloading".equals(st) || "extracting".equals(st) || "finalizing".equals(st)) return;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        destroyed = true;
        for (HttpURLConnection con : liveConnections.values()) con.disconnect();
        liveConnections.clear();
        releaseWake();
        worker.shutdownNow();
        super.onDestroy();
    }
}
