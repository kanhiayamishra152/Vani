package ai.vani.app;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Vani AI — llama.cpp engine wrapper (JNI).
 * Load / unload run on a serialized executor; generation streams tokens from
 * a dedicated thread so stop() (barge-in) never waits on the WebView thread.
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
    private volatile long handle = 0;
    private volatile String modelPath = null;
    private volatile String modelName = null;
    private volatile String mmprojPath = null;
    private volatile Thread genThread = null;
    private volatile boolean loading = false;
    private volatile boolean loadingOmni = false;
    private volatile boolean omni = false;
    private volatile String loadingPath = null;
    private volatile String loadingName = null;

    LlmEngine(MainActivity act) { this.act = act; }

    static boolean isOmniRequest(JSONObject a) {
        return isOmniIdentity(a.optString("path", ""), a.optString("name", ""));
    }

    private static boolean isOmniIdentity(String path, String name) {
        String identity = ((path == null ? "" : path) + " " + (name == null ? "" : name)).toLowerCase(Locale.ROOT);
        return identity.contains("lfm3-omni") || identity.contains("lfm3_omni");
    }

    /** True both while Omni is allocating and after it becomes ready. */
    boolean isOmni() { return loading ? loadingOmni : (handle != 0 && omni); }

    private static int clamp(int value, int min, int max) { return Math.max(min, Math.min(max, value)); }

    JSONObject status() {
        JSONObject j = new JSONObject();
        try {
            if (loading) {
                j.put("state", "loading");
                j.put("modelPath", loadingPath);
                j.put("name", loadingName);
                j.put("omni", loadingOmni);
                return j;
            }
            if (handle == 0 || !nativeOk) { j.put("state", "idle"); return j; }
            final JSONObject n;
            synchronized (genLock) {
                if (handle == 0) { j.put("state", "idle"); return j; }
                n = new JSONObject(nativeStatus(handle));
            }
            j.put("state", "ready");
            j.put("modelPath", modelPath);
            j.put("name", modelName);
            j.put("omni", omni);
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
        final boolean requestedOmni = isOmniRequest(a);
        final String requestedPath = a.optString("path", "");
        final String requestedName = a.optString("name", new java.io.File(requestedPath).getName());
        loading = true;
        loadingOmni = requestedOmni;
        loadingPath = requestedPath;
        loadingName = requestedName;
        act.emit("llm.status", status().toString());
        exec.submit(() -> {
            try {
                if (!stopGenerationInternal()) {
                    throw new IllegalStateException("The previous generation could not stop; the current model was left loaded");
                }
                synchronized (genLock) {
                    if (handle != 0) { nativeFree(handle); handle = 0; }
                    modelPath = null; modelName = null; mmprojPath = null; omni = false;
                }
                String path = a.getString("path");
                String mmproj = a.optString("mmprojPath", null);
                int nCtx = clamp(a.optInt("nCtx", requestedOmni ? 2048 : 4096), 512, 32768);
                int nBatch = clamp(a.optInt("nBatch", requestedOmni ? 128 : 512), 32, 512);
                int nThreads = clamp(a.optInt("nThreads", 4), 1, 8);
                if (requestedOmni) {
                    // A 2B omni model plus its projector is already a large mobile
                    // allocation. Keep context/batch bounded regardless of UI settings.
                    nCtx = Math.min(nCtx, 2048);
                    nBatch = Math.min(nBatch, 128);
                }
                long h = nativeLoad(path, mmproj == null ? "" : mmproj,
                        nCtx, nThreads, nBatch, a.optBoolean("flashAttn", true));
                if (h == 0) throw new IllegalStateException("Failed to load model (unsupported, corrupt, or insufficient free RAM)");
                synchronized (genLock) {
                    handle = h; modelPath = path; modelName = requestedName;
                    mmprojPath = mmproj; omni = requestedOmni;
                }
                Models.setLastActive(act, path);
                loading = false; loadingOmni = false; loadingPath = null; loadingName = null;
                act.resolve(id, true, status().toString());
            } catch (Exception e) {
                Log.e(TAG, "model load", e);
                fail(id, e.getMessage());
            } finally {
                loading = false;
                loadingOmni = false;
                loadingPath = null;
                loadingName = null;
                act.emit("llm.status", status().toString());
            }
        });
    }

    void unload(String id) {
        exec.submit(() -> {
            if (!stopGenerationInternal()) {
                fail(id, "Generation is still stopping; model memory was not freed unsafely. Try Unload again.");
                act.emit("llm.status", status().toString());
                return;
            }
            synchronized (genLock) {
                if (handle != 0) { nativeFree(handle); handle = 0; }
                modelPath = null; modelName = null; mmprojPath = null; omni = false;
            }
            Models.setLastActive(act, "");
            if (id != null) act.resolve(id, true, status().toString());
            act.emit("llm.status", status().toString());
        });
    }

    void generate(JSONObject a, String id) {
        final long h;
        synchronized (genLock) { h = handle; }
        if (h == 0 || !nativeOk || loading) { fail(id, "No model loaded"); return; }
        if (genThread != null && genThread.isAlive()) {
            synchronized (genLock) { if (handle != 0) nativeStop(handle); }
            try { genThread.join(1500); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            if (genThread != null && genThread.isAlive()) { fail(id, "Already generating"); return; }
        }
        String genId = a.optString("genId", "g0");
        JSONArray messages = a.optJSONArray("messages");
        JSONObject params = a.optJSONObject("params");
        JSONArray images = a.optJSONArray("images");
        String messagesJson = messages == null ? "[]" : messages.toString();
        String paramsJson = params == null ? "{}" : params.toString();
        String imagesJson = images == null ? "[]" : images.toString();
        act.resolve(id, true, "{\"started\":true}");
        final boolean wantsVision = images != null && images.length() > 0 && mmprojPath != null && !mmprojPath.isEmpty();
        genThread = new Thread(() -> {
            boolean attached = false;
            try {
                if (wantsVision) {
                    attached = nativeAttachMmproj(h, mmprojPath);
                    if (!attached) throw new IllegalStateException("Vision projector could not be attached");
                }
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
            } finally {
                if (attached) { try { nativeDetachMmproj(h); } catch (Throwable ignored) {} }
            }
        }, "vani-generate");
        genThread.start();
    }

    void stop(JSONObject a, String id) {
        synchronized (genLock) { if (handle != 0) nativeStop(handle); }
        act.resolve(id, true, "{}");
    }

    /** Returns false rather than freeing a handle still used by native code. */
    private boolean stopGenerationInternal() {
        synchronized (genLock) { if (handle != 0) nativeStop(handle); }
        Thread t = genThread;
        if (t != null && t.isAlive()) {
            try { t.join(8000); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); return false; }
        }
        if (t != null && t.isAlive()) return false;
        genThread = null;
        return true;
    }

    void shutdown() {
        if (stopGenerationInternal()) {
            synchronized (genLock) {
                if (handle != 0) { nativeFree(handle); handle = 0; }
                modelPath = null; modelName = null; mmprojPath = null; omni = false;
            }
        }
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
    private static native boolean nativeAttachMmproj(long handle, String path);
    private static native void nativeDetachMmproj(long handle);
    private static native void nativeStop(long handle);
    private static native void nativeFree(long handle);
}
