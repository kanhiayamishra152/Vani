package ai.vani.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;

import org.json.JSONObject;

/** Live hardware telemetry for the Settings panel + auto-tuning. */
public final class DeviceInfo {
    public static JSONObject get(Context ctx) throws Exception {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        JSONObject j = new JSONObject();
        j.put("ramTotalBytes", mi.totalMem);
        j.put("ramAvailBytes", mi.availMem);
        j.put("lowMemory", mi.lowMemory);
        j.put("cores", Runtime.getRuntime().availableProcessors());
        j.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "arm64-v8a");
        j.put("sdk", Build.VERSION.SDK_INT);
        j.put("model", Build.MODEL);
        j.put("manufacturer", Build.MANUFACTURER);
        j.put("gpuHint", Build.HARDWARE);
        if (Build.VERSION.SDK_INT >= 31) j.put("soc", Build.SOC_MODEL);
        return j;
    }
}
