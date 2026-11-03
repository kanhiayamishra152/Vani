package ai.vani.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Download-state persistence (survives process death; .part files resume). */
public final class Downloads {
    private static File file(Context ctx) { return new File(ctx.getFilesDir(), "downloads.json"); }

    public static synchronized JSONArray list(Context ctx) {
        try {
            File f = file(ctx);
            if (!f.exists()) return new JSONArray();
            return new JSONArray(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
        } catch (Exception e) { return new JSONArray(); }
    }

    public static synchronized void save(Context ctx, JSONArray arr) {
        try { Files.write(file(ctx).toPath(), arr.toString().getBytes(StandardCharsets.UTF_8)); }
        catch (Exception ignored) {}
    }

    public static synchronized void upsert(Context ctx, JSONObject entry) {
        JSONArray arr = list(ctx);
        JSONArray next = new JSONArray();
        boolean found = false;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e == null) continue;
            if (e.optString("id").equals(entry.optString("id"))) { next.put(entry); found = true; }
            else next.put(e);
        }
        if (!found) next.put(entry);
        save(ctx, next);
    }

    public static synchronized JSONObject get(Context ctx, String id) {
        JSONArray arr = list(ctx);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e != null && e.optString("id").equals(id)) return e;
        }
        return null;
    }

    public static synchronized void remove(Context ctx, String id) {
        JSONArray arr = list(ctx);
        JSONArray next = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e != null && !e.optString("id").equals(id)) next.put(e);
        }
        save(ctx, next);
    }
}
