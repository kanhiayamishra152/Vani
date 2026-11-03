package ai.vani.app;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * Vani AI — JS <-> native dispatch. One @JavascriptInterface entry point;
 * every call is JSON in / JSON out, resolved or evented back into the WebView.
 */
public final class Bridge {
    private static final String TAG = "VaniBridge";
    private final MainActivity act;

    Bridge(MainActivity act) { this.act = act; }

    @JavascriptInterface
    public void invoke(String method, String argsJson, String callbackId) {
        // v1.3.0 security: the native bridge is ONLY callable from our own
        // WebViewAssetLoader origin. Any other page (e.g. an injected iframe or
        // an external navigation) is rejected before dispatch.
        if (!MainActivity.ASSET_ORIGIN.equals(act.pageOrigin)) {
            Log.w(TAG, "bridge call from untrusted origin " + act.pageOrigin + " — rejected");
            err(callbackId, "untrusted origin");
            return;
        }
        try {
            JSONObject args = new JSONObject(argsJson == null || argsJson.isEmpty() ? "{}" : argsJson);
            dispatch(method, args, callbackId);
        } catch (Exception e) {
            Log.e(TAG, method + " failed", e);
            err(callbackId, e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    private void ok(String id, JSONObject payload) { act.resolve(id, true, payload == null ? "{}" : payload.toString()); }
    private void okArr(String id, org.json.JSONArray payload) { act.resolve(id, true, payload == null ? "[]" : payload.toString()); }
    private void err(String id, String msg) {
        try { act.resolve(id, false, new JSONObject().put("error", msg).toString()); }
        catch (Exception e) { act.resolve(id, false, "{\"error\":\"unknown\"}"); }
    }

    private void dispatch(String m, JSONObject a, String id) throws Exception {
        switch (m) {
            case "device.info": ok(id, DeviceInfo.get(act)); break;

            case "downloads.list": okArr(id, Downloads.list(act)); break;
            case "downloads.start":
                act.requestNotifPermission();
                DownloadService.start(act, a);
                ok(id, null);
                break;
            case "downloads.pause": DownloadService.command(act, DownloadService.ACTION_PAUSE, a.getString("id")); ok(id, null); break;
            case "downloads.resume": DownloadService.command(act, DownloadService.ACTION_RESUME, a.getString("id")); ok(id, null); break;
            case "downloads.cancel": DownloadService.command(act, DownloadService.ACTION_CANCEL, a.getString("id"), a.optString("groupId", "")); ok(id, null); break;

            case "models.list": okArr(id, Models.scan(act)); break;
            case "models.delete":
                Models.delete(act, a.getString("id"));
                act.emit("models.changed", "{}");
                ok(id, null);
                break;
            case "models.import": act.main.post(act::launchImport); ok(id, null); break;
            case "models.lastActive": ok(id, new JSONObject().put("path", Models.getLastActive(act))); break;
            case "models.setLastActive": Models.setLastActive(act, a.optString("path", "")); ok(id, null); break;

            case "llm.load": act.loadLlm(a, id); break;
            case "llm.unload": act.llm.unload(id); break;
            case "llm.status": ok(id, act.llm.status()); break;
            case "llm.generate": act.llm.generate(a, id); break;
            case "llm.stop": act.llm.stop(a, id); break;

            case "speech.status": ok(id, act.speech.status()); break;
            case "tts.configure": act.configureTts(a, id); break;
            case "tts.unload": act.speech.unloadTts(id); break;
            case "tts.speak": act.speech.speak(a, id); break;
            case "tts.stop": act.speech.stopTts(); ok(id, null); break;

            case "asr.load": act.loadAsr(a, id, false); break;
            case "asr.unload": act.speech.unloadAsr(id); break;
            case "asr.start": act.loadAsr(a, id, true); break;
            case "asr.stop": act.speech.stopAsr(); ok(id, null); break;
            case "asr.feed": act.speech.feed(a.getString("pcm")); ok(id, null); break;
            case "asr.pttRelease": act.speech.pttRelease(); ok(id, null); break;

            // v1.3.0 unified native mic permission + anti-freeze heartbeat.
            case "mic.ensurePermission": act.ensureMicPermission(id); break;
            case "system.heartbeat": act.crashGuard.heartbeat(); ok(id, null); break;
            case "crashguard.state": {
                android.app.ActivityManager am = (android.app.ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
                android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
                am.getMemoryInfo(mi);
                ok(id, new JSONObject().put("availMb", mi.availMem / 1048576).put("lowMemory", mi.lowMemory));
                break;
            }

            case "system.copy": {
                ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("Vani AI", a.getString("text")));
                ok(id, null);
                break;
            }
            case "system.openExternal":
                act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(a.getString("url"))));
                ok(id, null);
                break;
            case "system.setBackState":
                act.setJsHandlesBack(a.optBoolean("handled", false));
                ok(id, null);
                break;
            case "system.exit":
                act.main.post(act::finish);
                ok(id, null);
                break;

            default: err(id, "Unknown method: " + m);
        }
    }
}
