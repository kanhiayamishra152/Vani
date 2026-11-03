package ai.vani.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
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
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService io = Executors.newCachedThreadPool();

    private volatile boolean jsHandlesBack = false;
    private PermissionRequest pendingPerm;
    private static final int REQ_PERM = 201;
    private static final int REQ_NOTIF = 202;
    private static final int REQ_IMPORT = 203;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        llm = new LlmEngine(this);
        speech = new SpeechEngine(this, (event, payload) -> { emit(event, payload); return kotlin.Unit.INSTANCE; });
        bridge = new Bridge(this);

        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
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
    }

    void requestNotifPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }
    }

    void launchImport() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        startActivityForResult(i, REQ_IMPORT);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_IMPORT && resultCode == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            io.submit(() -> {
                try {
                    String name = "imported-" + System.currentTimeMillis() + ".gguf";
                    try (android.database.Cursor c = getContentResolver().query(uri, null, null, null, null)) {
                        if (c != null && c.moveToFirst()) {
                            int idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                            if (idx >= 0) name = c.getString(idx);
                        }
                    }
                    if (!name.toLowerCase().endsWith(".gguf")) name += ".gguf";
                    File dir = Models.modelsDir(this);
                    File out = new File(dir, name);
                    try (InputStream in = getContentResolver().openInputStream(uri);
                         FileOutputStream fos = new FileOutputStream(out)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
                    }
                    JSONObject e = new JSONObject();
                    e.put("modelId", "custom");
                    e.put("name", name.replace(".gguf", ""));
                    e.put("kind", "llm");
                    e.put("quant", "");
                    e.put("fileName", name);
                    e.put("path", out.getAbsolutePath());
                    e.put("dir", false);
                    e.put("sizeBytes", out.length());
                    Models.register(this, e);
                    emit("models.changed", "{}");
                    emitLocalToast("Imported " + name);
                } catch (Exception e) {
                    Log.e(TAG, "import failed", e);
                    emitLocalToast("Import failed: " + e.getMessage());
                }
            });
        }
    }

    private void emitLocalToast(String msg) {
        try { emit("ui.toast", new JSONObject().put("message", msg).toString()); } catch (Exception ignored) {}
    }

    /** Native -> JS event. payloadJson must be a valid JSON value. */
    public void emit(String event, String payloadJson) {
        final String js = "window.VaniBridge&&window.VaniBridge._emit(" + JSONObject.quote(event) + "," + payloadJson + ")";
        main.post(() -> {
            try { if (web != null) web.evaluateJavascript(js, null); } catch (Exception ignored) {}
        });
    }

    /** Native -> JS promise resolution. */
    public void resolve(String id, boolean ok, String payloadJson) {
        final String js = "window.VaniBridge&&window.VaniBridge._resolve(" + JSONObject.quote(id) + "," + ok + "," + payloadJson + ")";
        main.post(() -> {
            try { if (web != null) web.evaluateJavascript(js, null); } catch (Exception ignored) {}
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
        emit("app.background.native", "{}");
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        emit("app.foreground.native", "{}");
    }

    @Override
    protected void onDestroy() {
        instance = null;
        try { speech.release(); } catch (Exception ignored) {}
        try { llm.shutdown(); } catch (Exception ignored) {}
        try { if (web != null) web.destroy(); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
