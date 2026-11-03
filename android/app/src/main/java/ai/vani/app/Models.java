package ai.vani.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

/** Installed-model registry persisted at filesDir/models/installed.json. */
public final class Models {
    public static File modelsDir(Context ctx) {
        File d = new File(ctx.getFilesDir(), "models");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    private static File registry(Context ctx) { return new File(modelsDir(ctx), "installed.json"); }

    public static synchronized JSONArray list(Context ctx) {
        JSONArray out = new JSONArray();
        try {
            File f = registry(ctx);
            if (!f.exists()) return out;
            JSONArray arr = new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject e = arr.getJSONObject(i);
                if (new File(e.getString("path")).exists()) out.put(e);
            }
        } catch (Exception ignored) {}
        return out;
    }

    private static synchronized void save(Context ctx, JSONArray arr) {
        try { Files.write(registry(ctx).toPath(), arr.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception ignored) {}
    }

    public static synchronized void register(Context ctx, JSONObject entry) throws Exception {
        JSONArray arr = list(ctx);
        JSONArray next = new JSONArray();
        // Replace any previous install of the same model+kind+quant.
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.getJSONObject(i);
            boolean same = e.optString("modelId").equals(entry.optString("modelId"))
                    && e.optString("kind").equals(entry.optString("kind"))
                    && e.optString("quant").equals(entry.optString("quant"));
            if (same) { deleteTree(new File(e.getString("path"))); continue; }
            next.put(e);
        }
        entry.put("id", UUID.randomUUID().toString());
        entry.put("installedAt", System.currentTimeMillis());
        next.put(entry);
        save(ctx, next);
    }

    public static synchronized void delete(Context ctx, String id) {
        JSONArray arr = list(ctx);
        JSONArray next = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e == null) continue;
            if (e.optString("id").equals(id)) { deleteTree(new File(e.optString("path"))); continue; }
            next.put(e);
        }
        save(ctx, next);
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    public static long treeSize(File f) {
        if (!f.exists()) return 0;
        if (f.isFile()) return f.length();
        long s = 0;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) s += treeSize(k);
        return s;
    }
}
