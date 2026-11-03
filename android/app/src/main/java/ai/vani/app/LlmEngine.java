package ai.vani.app;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Vani AI — llama.cpp engine wrapper (JNI).
 * Load / unload run on a serialized executor; generation streams tokens from
 * a dedicated thread so stop() (barge-in) is always instant.
 */
public final class LlmEngine {
    private static final String TAG = "VaniLlm";
    private static boolean nativeOk = false;

    static {
        try {
            System.loadLibrary("vani_llama");
            nativeInit();
            nativeOk = true;
        } catch (Throwable t) {
            Log.e(TAG, "native library unavailable", t);
        }
    }

    public interface Callback {
        void onToken(String text);
        void onDone(String statsJson);
        void onError(String error);
    }

    private final MainActivity act;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Object genLock = new Object();
    private long handle = 0;
    private String modelPath = null;
    private String modelName = null;
    private volatile Thread genThread = null;
    private volatile String currentGenId = null;
    private volatile boolean loading = false;

    LlmEngine(MainActivity act) { this.act = act; }

    JSONObject status() {
        JSONObject j = new JSONObject();
        try {
            if (loading) { j.put("state", "loading"); return j; }
            if (handle == 0 || !nativeOk) { j.put("state", "idle"); return j; }
            JSONObject n = new JSONObject(nativeStatus(handle));
            j.put("state", "ready");
            j.put("modelPath", modelPath);
            j.put("name", modelName);
            for (java.util.Iterator<String> it = n.keys(); it.hasNext(); ) {
                String k = it.next();
                j.put(k, n.get(k));
            }
        } catch (Exception e) {
            try { j.put("state", "idle"); } catch (Exception ignored) {}
        }
        return j;
    }

    void load(JSONObject a, String id) {
        if (!nativeOk) { fail(id, "Native engine missing from this build"); return; }
        loading = true;
        act.emit("llm.status", status().toString());
        exec.submit(() -> {
            try {
                stopGenerationInternal();
                synchronized (genLock) {
                    if (handle != 0) { nativeFree(handle); handle = 0; }
                }
                String path = a.getString("path");
                String mmproj = a.optString("mmprojPath", null);
                long h = nativeLoad(path, mmproj == null ? "" : mmproj,
                        a.optInt("nCtx", 4096), a.optInt("nThreads", 4),
                        a.optInt("nBatch", 256), a.optBoolean("flashAttn", true));
                loading = false;
                if (h == 0) {
                    fail(id, "Failed to load model (unsupported or corrupt GGUF)");
                    act.emit("llm.status", status().toString());
                    return;
                }
                synchronized (genLock) { handle = h; modelPath = path; modelName = a.optString("name", new java.io.File(path).getName()); }
                JSONObject st = status();
                act.resolve(id, true, st.toString());
                act.emit("llm.status", st.toString());
            } catch (Exception e) {
                loading = false;
                fail(id, e.getMessage());
                act.emit("llm.status", status().toString());
            }
        });
    }

    void unload(String id) {
        exec.submit(() -> {
            stopGenerationInternal();
            synchronized (genLock) {
                if (handle != 0) { nativeFree(handle); handle = 0; modelPath = null; modelName = null; }
            }
            if (id != null) act.resolve(id, true, "{}");
            act.emit("llm.status", status().toString());
        });
    }

    void generate(JSONObject a, String id) {
        final long h;
        synchronized (genLock) { h = handle; }
        if (h == 0 || !nativeOk) { fail(id, "No model loaded"); return; }
        if (genThread != null && genThread.isAlive()) { fail(id, "Already generating"); return; }
        String genId = a.optString("genId", "g0");
        currentGenId = genId;
        JSONArray messages = a.optJSONArray("messages");
        JSONObject params = a.optJSONObject("params");
        JSONArray images = a.optJSONArray("images");
        String messagesJson = messages == null ? "[]" : messages.toString();
        String paramsJson = params == null ? "{}" : params.toString();
        String imagesJson = images == null ? "[]" : images.toString();
        act.resolve(id, true, "{\"started\":true}");
        genThread = new Thread(() -> {
            try {
                nativeGenerate(h, messagesJson, paramsJson, imagesJson, genId, new Callback() {
                    @Override public void onToken(String text) {
                        try { act.emit("llm.token", new JSONObject().put("genId", genId).put("text", text).toString()); }
                        catch (Exception ignored) {}
                    }
                    @Override public void onDone(String statsJson) {
                        try {
                            JSONObject p = new JSONObject(statsJson);
                            p.put("genId", genId);
                            act.emit("llm.done", p.toString());
                        } catch (Exception ignored) {}
                    }
                    @Override public void onError(String error) {
                        try { act.emit("llm.error", new JSONObject().put("genId", genId).put("error", error).toString()); }
                        catch (Exception ignored) {}
                    }
                });
            } catch (Throwable t) {
                try { act.emit("llm.error", new JSONObject().put("genId", genId).put("error", String.valueOf(t.getMessage())).toString()); }
                catch (Exception ignored) {}
            }
        }, "vani-generate");
        genThread.start();
    }

    void stop(JSONObject a, String id) {
        synchronized (genLock) { if (handle != 0) nativeStop(handle); }
        act.resolve(id, true, "{}");
    }

    private void stopGenerationInternal() {
        synchronized (genLock) { if (handle != 0) nativeStop(handle); }
        Thread t = genThread;
        if (t != null && t.isAlive()) {
            try { t.join(8000); } catch (InterruptedException ignored) {}
        }
        genThread = null;
    }

    void shutdown() {
        stopGenerationInternal();
        synchronized (genLock) { if (handle != 0) { nativeFree(handle); handle = 0; } }
        exec.shutdownNow();
    }

    private void fail(String id, String msg) {
        try { act.resolve(id, false, new JSONObject().put("error", msg == null ? "error" : msg).toString()); }
        catch (Exception e) { act.resolve(id, false, "{\"error\":\"error\"}"); }
    }

    /* ---------------- JNI ---------------- */
    private static native void nativeInit();
    private static native long nativeLoad(String path, String mmproj, int nCtx, int nThreads, int nBatch, boolean flashAttn);
    private static native String nativeStatus(long handle);
    private static native void nativeGenerate(long handle, String messagesJson, String paramsJson, String imagesJson, String genId, Callback cb);
    private static native void nativeStop(long handle);
    private static native void nativeFree(long handle);
}
