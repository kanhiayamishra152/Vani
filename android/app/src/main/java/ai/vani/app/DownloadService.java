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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
    private PowerManager.WakeLock wakeLock;
    private volatile boolean pumping = false;

    public static void start(Context ctx, JSONObject args) throws Exception {
        Intent i = new Intent(ctx, DownloadService.class);
        i.setAction(ACTION_START);
        i.putExtra("entry", args.toString());
        ctx.startForegroundService(i);
    }

    public static void command(Context ctx, String action, String id) {
        Intent i = new Intent(ctx, DownloadService.class);
        i.setAction(action);
        i.putExtra("id", id);
        ctx.startForegroundService(i);
    }

    @Override
    public void onCreate() {
        super.onCreate();
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
            if (st.equals("downloading") || st.equals("queued") || st.equals("extracting")) {
                try { e.put("state", "paused"); e.put("error", "Interrupted — tap Resume"); } catch (Exception ignored) {}
                Downloads.upsert(this, e);
            }
            liveMeta.put(e.optString("id"), e);
            liveState.put(e.optString("id"), e.optString("state"));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        try {
            if (ACTION_START.equals(action)) {
                JSONObject e = new JSONObject(intent.getStringExtra("entry"));
                String id = e.getString("id");
                File part = new File(Models.modelsDir(this), e.getString("fileName") + ".part");
                e.put("received", part.exists() ? part.length() : 0);
                e.put("state", "queued");
                e.put("speed", 0);
                e.put("error", "");
                liveMeta.put(id, e);
                liveState.put(id, "queued");
                Downloads.upsert(this, e);
                startForeground(notifId("summary"), buildSummary("Preparing download…"));
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
                String id = intent.getStringExtra("id");
                liveState.put(id, "cancelled");
                JSONObject e = liveMeta.get(id);
                if (e != null) new File(Models.modelsDir(this), e.optString("fileName") + ".part").delete();
                liveMeta.remove(id);
                Downloads.remove(this, id);
                getSystemService(NotificationManager.class).cancel(notifId(id));
                emit("download.state", new JSONObject().put("id", id).put("state", "cancelled").toString());
                stopIfIdle();
            }
        } catch (Exception e) {
            Log.e(TAG, "command failed", e);
        }
        return START_NOT_STICKY;
    }

    private synchronized void pump() {
        if (pumping) return;
        pumping = true;
        worker.submit(() -> {
            try {
                acquireWake();
                while (true) {
                    JSONObject next = null;
                    for (JSONObject e : liveMeta.values()) {
                        if ("queued".equals(liveState.get(e.optString("id")))) { next = e; break; }
                    }
                    if (next == null) break;
                    downloadWithRetry(next);
                }
            } finally {
                releaseWake();
                pumping = false;
                stopIfIdle();
            }
        });
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
        int retries = 0;
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
                try { Thread.sleep(2000L * retries); } catch (InterruptedException ignored) { return; }
            }
        }
    }

    private void download(JSONObject e) throws Exception {
        String id = e.getString("id");
        String fileName = e.getString("fileName");
        File modelsDir = Models.modelsDir(this);
        File part = new File(modelsDir, fileName + ".part");
        long offset = part.exists() ? part.length() : 0;
        long total = e.optLong("total", 0);

        HttpURLConnection con = (HttpURLConnection) new URL(e.getString("url")).openConnection();
        con.setConnectTimeout(30000);
        con.setReadTimeout(30000);
        con.setInstanceFollowRedirects(true);
        con.setRequestProperty("User-Agent", "VaniAI/1.0.0 (Android)");
        if (offset > 0) con.setRequestProperty("Range", "bytes=" + offset + "-");
        int code = con.getResponseCode();
        boolean append = code == 206;
        if (code == 200 && offset > 0) { offset = 0; append = false; }
        if (code != 200 && code != 206) throw new IOException("HTTP " + code);
        if (total <= 0) {
            long cl = con.getContentLengthLong();
            if (cl > 0) total = cl + offset;
        }

        liveState.put(id, "downloading");
        patchPersist(id, "state", "downloading");
        patchPersist(id, "total", total);
        emitState(id);

        long received = offset;
        long lastEmit = 0, lastBytes = offset;
        double speed = 0;
        try (InputStream in = new BufferedInputStream(con.getInputStream(), 65536);
             FileOutputStream out = new FileOutputStream(part, append)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                String st = liveState.get(id);
                if ("paused".equals(st)) {
                    patchPersist(id, "received", received);
                    patchPersist(id, "state", "paused");
                    emitProgress(id, received, total, 0, "paused");
                    return;
                }
                if ("cancelled".equals(st)) { part.delete(); return; }
                out.write(buf, 0, n);
                received += n;
                long now = System.currentTimeMillis();
                if (now - lastEmit >= 500) {
                    double inst = (received - lastBytes) * 1000.0 / Math.max(1, now - lastEmit);
                    speed = speed == 0 ? inst : speed * 0.7 + inst * 0.3;
                    lastEmit = now; lastBytes = received;
                    emitProgress(id, received, total, speed, "downloading");
                    patchPersist(id, "received", received);
                    notifyProgress(e, received, total, speed);
                }
            }
        } finally {
            con.disconnect();
        }

        // Complete: rename .part -> final, extract archives, register model.
        liveState.put(id, "extracting");
        emitProgress(id, received, total, 0, e.optBoolean("extract") ? "extracting" : "finalizing");
        File fin = new File(modelsDir, fileName);
        if (fin.exists()) fin.delete();
        if (!part.renameTo(fin)) throw new IOException("rename failed");

        String path = fin.getAbsolutePath();
        boolean isDir = false;
        long size = fin.length();
        if (e.optBoolean("extract")) {
            File dir = extractTarBz2(fin, modelsDir);
            path = dir.getAbsolutePath();
            isDir = true;
            size = Models.treeSize(dir);
            fin.delete();
        }

        JSONObject reg = new JSONObject();
        reg.put("modelId", e.optString("modelId"));
        reg.put("name", e.optString("name", fileName));
        reg.put("kind", e.optString("kind"));
        reg.put("quant", e.optString("quant"));
        reg.put("fileName", fileName);
        reg.put("path", path);
        reg.put("dir", isDir);
        reg.put("sizeBytes", size);
        reg.put("engine", engineFor(e.optString("modelId")));
        Models.register(this, reg);

        liveState.put(id, "done");
        liveMeta.remove(id);
        Downloads.remove(this, id);
        getSystemService(NotificationManager.class).cancel(notifId(id));
        notifyDone(e);
        emit("download.done", new JSONObject().put("id", id).put("name", e.optString("name")).toString());
        emit("models.changed", "{}");
    }

    private static String engineFor(String modelId) {
        switch (modelId) {
            case "pocket-tts": return "pocket";
            case "piper-lessac": return "vits";
            case "kokoro": return "kokoro";
            case "whisper-tiny":
            case "whisper-base": return "whisper";
            default: return "";
        }
    }

    /** Extract .tar.bz2 safely; returns the top-level model directory. */
    private File extractTarBz2(File archive, File destRoot) throws IOException {
        String topDir = null;
        try (TarArchiveInputStream tar = new TarArchiveInputStream(
                new BZip2CompressorInputStream(new BufferedInputStream(new FileInputStream(archive), 65536)))) {
            TarArchiveEntry entry;
            byte[] buf = new byte[65536];
            while ((entry = tar.getNextTarEntry()) != null) {
                String name = entry.getName();
                if (name.contains("..")) continue;
                if (topDir == null) {
                    int slash = name.indexOf('/');
                    topDir = slash > 0 ? name.substring(0, slash) : name;
                }
                File out = new File(destRoot, name);
                if (entry.isDirectory()) { out.mkdirs(); continue; }
                out.getParentFile().mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = tar.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
        }
        File dir = topDir != null ? new File(destRoot, topDir) : destRoot;
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /* ---------------- notifications ---------------- */
    private int notifId(String id) { return Math.abs(id.hashCode() % 100000) + 10; }

    private PendingIntent actionIntent(String action, String id) {
        Intent i = new Intent(this, DownloadService.class);
        i.setAction(action);
        i.putExtra("id", id);
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
                .addAction(android.R.drawable.ic_delete, "Cancel", actionIntent(ACTION_CANCEL, id))
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
            if ("queued".equals(st) || "downloading".equals(st) || "extracting".equals(st)) return;
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public void onDestroy() {
        releaseWake();
        worker.shutdownNow();
        super.onDestroy();
    }
}
