package ai.vani.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Vani AI — single-activity WebView host.
 * All app assets are served from https://appassets.androidplatform.net/assets/
 * via androidx.webkit.WebViewAssetLoader (secure context, zero CORS issues,
 * GLTFLoader fetches the bundled OC-Lily VRM fully offline).
 */
public class MainActivity extends Activity {
    private static final String TAG = "VaniAI";
    public static final String ASSET_ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ASSET_ORIGIN + "/assets/www/index.html";

    static volatile MainActivity instance;

    WebView web;
    Bridge bridge;
    LlmEngine llm;
    SpeechEngine speech;
    CrashGuard crashGuard;
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newSingleThreadExecutor();
    /** Serializes cross-engine admission decisions; native work stays off the UI thread. */
    private final Object modelLifecycleLock = new Object();

    private volatile boolean destroyed = false;
    private volatile boolean jsHandlesBack = false;
    volatile String pageOrigin = ASSET_ORIGIN;
    private PermissionRequest pendingPerm;
    private String pendingMicCb;
    private static final int REQ_PERM = 201;
    private static final int REQ_NOTIF = 202;
    private static final int REQ_IMPORT = 203;
    private static final int REQ_MIC = 204;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        destroyed = false;
        instance = this;
        llm = new LlmEngine(this);
        speech = new SpeechEngine(this, (event, payload) -> { emit(event, payload); return kotlin.Unit.INSTANCE; });
        bridge = new Bridge(this);
        // Keep fatal-crash cleanup, but do not run a perpetual watchdog/heartbeat.
        crashGuard = new CrashGuard(this);
        crashGuard.installUncaughtHandler();

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // v1.3.0 security: assets are served ONLY via WebViewAssetLoader over
        // https://appassets.androidplatform.net — never from file:// URLs.
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        web.setBackgroundColor(0xFF000000);
        web.addJavascriptInterface(bridge, "VaniNative");

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                try {
                    Uri u = Uri.parse(url);
                    pageOrigin = u.getScheme() + "://" + u.getHost();
                } catch (Exception ignored) { pageOrigin = ""; }
            }
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (ASSET_ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Only our own asset origin may capture mic/camera.
                if (!ASSET_ORIGIN.equals(request.getOrigin().getScheme() + "://" + request.getOrigin().getHost())) {
                    request.deny();
                    return;
                }
                boolean needAudio = false, needVideo = false;
                for (String r : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) needAudio = true;
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) needVideo = true;
                }
                boolean audioOk = !needAudio || checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                boolean videoOk = !needVideo || checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                if (audioOk && videoOk) { request.grant(request.getResources()); return; }
                pendingPerm = request;
                java.util.ArrayList<String> perms = new java.util.ArrayList<>();
                if (needAudio && !audioOk) perms.add(android.Manifest.permission.RECORD_AUDIO);
                if (needVideo && !videoOk) perms.add(android.Manifest.permission.CAMERA);
                requestPermissions(perms.toArray(new String[0]), REQ_PERM);
            }
        });

        web.loadUrl(START_URL);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERM && pendingPerm != null) {
            boolean allGranted = grantResults.length > 0;
            for (int g : grantResults) if (g != PackageManager.PERMISSION_GRANTED) allGranted = false;
            if (allGranted) pendingPerm.grant(pendingPerm.getResources());
            else pendingPerm.deny();
            pendingPerm = null;
        }
        if (requestCode == REQ_MIC && pendingMicCb != null) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            try { resolve(pendingMicCb, true, new JSONObject().put("granted", granted).toString()); }
            catch (Exception e) { resolve(pendingMicCb, true, "{\"granted\":" + granted + "}"); }
            pendingMicCb = null;
        }
    }

    /* ---------------- strict model-memory admission ---------------- */

    private void rejectModelRequest(String id, String message) {
        try { resolve(id, false, new JSONObject().put("error", message).toString()); }
        catch (Exception e) { resolve(id, false, "{\"error\":\"Model request rejected\"}"); }
    }

    void loadLlm(JSONObject a, String id) {
        synchronized (modelLifecycleLock) {
            boolean wantsOmni = LlmEngine.isOmniRequest(a);
            if (!wantsOmni && llm.isOmni()) {
                rejectModelRequest(id, "LFM3-Omni-2B is active. Unload it before loading another model.");
                return;
            }
            if (wantsOmni) {
                try {
                    // This completes BEFORE nativeLoad allocates the Omni model.
                    if (!speech.unloadAllBlocking()) {
                        rejectModelRequest(id, "Voice models could not be released safely. Omni was not loaded; try again.");
                        return;
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "Omni pre-unload", t);
                    rejectModelRequest(id, "Could not isolate memory for Omni: " + t.getMessage());
                    return;
                }
            }
            llm.load(a, id); // serialized internally: replaces at most one Main LLM
        }
    }

    void configureTts(JSONObject a, String id) {
        synchronized (modelLifecycleLock) {
            String engine = a.optString("engine", "phonon");
            if (!"system".equals(engine) && llm.isOmni()) {
                rejectModelRequest(id, "Omni isolation is active. Unload LFM3-Omni-2B before loading a standalone voice.");
                return;
            }
            speech.configureTts(a, id);
        }
    }

    void loadAsr(JSONObject a, String id, boolean startCapture) {
        synchronized (modelLifecycleLock) {
            String engine = a.optString("engine", startCapture ? "system" : "whisper");
            if (!"system".equals(engine) && llm.isOmni()) {
                rejectModelRequest(id, "Omni isolation is active. Unload LFM3-Omni-2B before loading a standalone ASR model.");
                return;
            }
            if (startCapture) speech.startAsr(a, id);
            else speech.loadAsr(a, id);
        }
    }

    /** v1.3.0 unified mic permission: check RECORD_AUDIO, request if needed,
     *  resolve {granted} so JS can start the native AudioRecord bridge. */
    void ensureMicPermission(String id) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> ensureMicPermission(id));
            return;
        }
        if (destroyed) return;
        if (pendingMicCb != null) {
            rejectModelRequest(id, "Another microphone permission request is already active");
            return;
        }
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            try { resolve(id, true, new JSONObject().put("granted", true).toString()); }
            catch (Exception e) { resolve(id, true, "{\"granted\":true}"); }
            return;
        }
        pendingMicCb = id;
        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_MIC);
    }

    void requestNotifPermission() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(this::requestNotifPermission);
            return;
        }
        if (destroyed) return;
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    void launchImport() {
        if (destroyed) return;
        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            startActivityForResult(i, REQ_IMPORT);
        } catch (Exception e) {
            Log.e(TAG, "import picker", e);
            emitLocalToast("No document picker is available on this device");
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_IMPORT && resultCode == RESULT_OK && data != null) {
            final java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            if (uris.isEmpty() || destroyed) return;
            try { io.submit(() -> importFiles(uris)); }
            catch (java.util.concurrent.RejectedExecutionException e) { emitLocalToast("Import is unavailable while the app is closing"); }
        }
    }

    private String displayName(Uri uri) {
        String name = "imported-" + System.currentTimeMillis();
        try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && c.getString(idx) != null) name = c.getString(idx);
            }
        } catch (Exception ignored) {}
        return name;
    }

    private void copyUri(Uri uri, File out) throws Exception {
        InputStream source = getContentResolver().openInputStream(uri);
        if (source == null) throw new java.io.IOException("The selected document could not be opened");
        try (InputStream in = source;
             FileOutputStream fos = new FileOutputStream(out)) {
            byte[] buf = new byte[65536];
            int n;
            while (in != null && (n = in.read(buf)) > 0) fos.write(buf, 0, n);
        }
    }

    /** Import .gguf (standalone LLM) or a set of .onnx/.bin/.txt files (voice/ASR model). */
    private void importFiles(java.util.ArrayList<Uri> uris) {
        try {
            java.util.ArrayList<String> names = new java.util.ArrayList<>();
            for (Uri u : uris) names.add(displayName(u));

            if (uris.size() == 1 && names.get(0).toLowerCase().endsWith(".gguf")) {
                String name = SafeFilename.clean(names.get(0));
                File out = SafeFilename.safeChild(Models.modelsDir(this), name);
                File part = SafeFilename.safeChild(Models.modelsDir(this), name + ".part");
                copyUri(uris.get(0), part);
                if (out.exists() && !out.delete()) throw new java.io.IOException("Could not replace the existing imported model");
                if (!part.renameTo(out)) throw new java.io.IOException("Could not finalize the imported model");
                JSONObject e = new JSONObject();
                e.put("modelId", "custom");
                e.put("name", name.replaceFirst("(?i)\\.gguf$", ""));
                e.put("kind", "gguf");
                e.put("quant", "");
                e.put("fileName", name);
                e.put("path", out.getAbsolutePath());
                e.put("dir", false);
                e.put("sizeBytes", out.length());
                e.put("engine", "llm");
                e.put("category", "general");
                Models.register(this, e);
                emit("models.changed", "{}");
                emitLocalToast("Imported " + name);
                return;
            }

            // ONNX / bin / tokens: copy the whole selection into one model directory,
            // then let the startup scanner register it with an inferred engine.
            File dir = new File(Models.modelsDir(this), "imported-" + System.currentTimeMillis());
            dir.mkdirs();
            int copied = 0;
            for (int i = 0; i < uris.size(); i++) {
                String n = names.get(i).replaceAll("[^A-Za-z0-9._-]", "_");
                String ln = n.toLowerCase();
                if (!(ln.endsWith(".onnx") || ln.endsWith(".bin") || ln.endsWith(".txt") || ln.endsWith(".json") || ln.endsWith(".gguf"))) continue;
                copyUri(uris.get(i), new File(dir, n));
                copied++;
            }
            if (copied == 0) { Models.deleteTree(dir); emitLocalToast("No .onnx / .bin / .gguf files selected"); return; }
            Models.scan(this);
            emit("models.changed", "{}");
            emitLocalToast("Imported " + copied + " file" + (copied == 1 ? "" : "s"));
        } catch (Exception e) {
            Log.e(TAG, "import failed", e);
            emitLocalToast("Import failed: " + e.getMessage());
        }
    }

    private void emitLocalToast(String msg) {
        try { emit("ui.toast", new JSONObject().put("message", msg).toString()); } catch (Exception ignored) {}
    }

    /** Native -> JS event. payloadJson must be a valid JSON value. */
    public void emit(String event, String payloadJson) {
        if (destroyed) return;
        final String js = "window.VaniBridge&&window.VaniBridge._emit(" + JSONObject.quote(event) + "," + payloadJson + ")";
        main.post(() -> {
            WebView target = web;
            if (destroyed || target == null) return;
            try { target.evaluateJavascript(js, null); } catch (Exception ignored) {}
        });
    }

    /** Native -> JS promise resolution. */
    public void resolve(String id, boolean ok, String payloadJson) {
        if (destroyed) return;
        final String js = "window.VaniBridge&&window.VaniBridge._resolve(" + JSONObject.quote(id) + "," + ok + "," + payloadJson + ")";
        main.post(() -> {
            WebView target = web;
            if (destroyed || target == null) return;
            try { target.evaluateJavascript(js, null); } catch (Exception ignored) {}
        });
    }

    public void setJsHandlesBack(boolean handled) { jsHandlesBack = handled; }

    @Override
    public void onBackPressed() {
        if (jsHandlesBack) emit("system.back", "{}");
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) web.onPause();
        try { if (speech != null) { speech.stopTts(); speech.stopAsr(); } } catch (Exception ignored) {}
        emit("app.background.native", "{}");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        emit("app.foreground.native", "{}");
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        String severity = level >= TRIM_MEMORY_COMPLETE ? "critical" :
                (level >= TRIM_MEMORY_RUNNING_CRITICAL ? "high" : "moderate");
        // Release transient UI/audio buffers, never kill a loaded model mid-task.
        try { if (speech != null) speech.trimMemory(); } catch (Exception ignored) {}
        emit("memory.pressure", "{\"level\":\"" + severity + "\"}");
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        try { if (speech != null) speech.trimMemory(); } catch (Exception ignored) {}
        emit("memory.pressure", "{\"level\":\"critical\"}");
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (instance == this) instance = null;
        try { if (crashGuard != null) crashGuard.stop(); } catch (Exception ignored) {}
        try { if (speech != null) speech.release(); } catch (Exception ignored) {}
        io.shutdownNow();
        // Native generation can take time to stop. Never block the Android UI
        // thread for up to eight seconds while the Activity is being destroyed.
        final LlmEngine engine = llm;
        if (engine != null) {
            Thread cleanup = new Thread(engine::shutdown, "vani-llm-shutdown");
            cleanup.setDaemon(true);
            cleanup.start();
        }
        try {
            if (web != null) {
                web.removeJavascriptInterface("VaniNative");
                web.destroy();
            }
        } catch (Exception ignored) {}
        web = null;
        super.onDestroy();
    }
}
