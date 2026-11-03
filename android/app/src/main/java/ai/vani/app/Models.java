package ai.vani.app;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Locale;
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

    /* ---------------- persistence helpers ---------------- */

    public static void setLastActive(Context ctx, String path) {
        try {
            ctx.getSharedPreferences("vani", Context.MODE_PRIVATE).edit().putString("lastModelPath", path == null ? "" : path).apply();
        } catch (Exception ignored) {}
    }

    public static String getLastActive(Context ctx) {
        try { return ctx.getSharedPreferences("vani", Context.MODE_PRIVATE).getString("lastModelPath", ""); }
        catch (Exception e) { return ""; }
    }

    /* ---------------- startup disk scan / reconciliation ---------------- */

    /**
     * Reconcile the on-disk models directory with the registry. Restores any model
     * files present on disk but missing from the registry (e.g. after a registry
     * loss or a local import), so nothing ever "disappears" between launches.
     */
    public static synchronized JSONArray scan(Context ctx) {
        JSONArray arr = list(ctx);
        java.util.HashSet<String> known = new java.util.HashSet<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject e = arr.optJSONObject(i);
            if (e != null) known.add(new File(e.optString("path")).getAbsolutePath());
        }
        File root = modelsDir(ctx);
        File[] kids = root.listFiles();
        boolean changed = false;
        if (kids != null) {
            for (File f : kids) {
                String name = f.getName();
                if (name.endsWith(".part") || name.equals("installed.json")) continue;
                String abs = f.getAbsolutePath();
                if (known.contains(abs)) continue;
                JSONObject entry = new JSONObject();
                try {
                    if (f.isFile() && name.toLowerCase().endsWith(".gguf")) {
                        if (name.toLowerCase().startsWith("mmproj")) continue; // vision companion
                        entry.put("modelId", "custom");
                        entry.put("name", name.replaceFirst("(?i)\\.gguf$", ""));
                        entry.put("kind", "gguf");
                        entry.put("quant", guessQuant(name));
                        entry.put("fileName", name);
                        entry.put("path", abs);
                        entry.put("dir", false);
                        entry.put("sizeBytes", f.length());
                        entry.put("engine", "llm");
                        entry.put("category", "general");
                    } else if (f.isDirectory() && containsModelFiles(f)) {
                        String engine = guessEngine(f, name);
                        entry.put("modelId", name);
                        entry.put("name", name);
                        entry.put("kind", "dir");
                        entry.put("quant", "");
                        entry.put("fileName", name);
                        entry.put("path", abs);
                        entry.put("dir", true);
                        entry.put("sizeBytes", treeSize(f));
                        entry.put("engine", engine);
                        entry.put("category", isTts(engine) ? "tts" : "asr");
                    } else {
                        continue;
                    }
                    entry.put("source", "scan");
                    entry.put("id", UUID.randomUUID().toString());
                    entry.put("installedAt", System.currentTimeMillis());
                } catch (Exception ignored) { continue; }
                arr.put(entry);
                known.add(abs);
                changed = true;
            }
        }
        if (changed) save(ctx, arr);
        return arr;
    }

    private static boolean isTts(String engine) {
        return engine.equals("vits") || engine.equals("kokoro") || engine.equals("pocket");
    }

    private static boolean containsModelFiles(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return false;
        for (File k : kids) {
            String n = k.getName().toLowerCase();
            if (k.isFile() && (n.endsWith(".onnx") || n.endsWith(".bin") || n.equals("tokens.txt") || n.endsWith(".gguf"))) return true;
        }
        for (File k : kids) if (k.isDirectory() && containsModelFiles(k)) return true;
        return false;
    }

    private static String guessQuant(String name) {
        String u = name.toUpperCase(Locale.ROOT);
        String[] qs = {"Q4_K_M", "Q4_K_S", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0", "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q2_K", "Q3_K_M", "BF16", "F16", "F32"};
        for (String q : qs) if (u.contains(q)) return q;
        return "";
    }

    private static String guessEngine(File dir, String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.contains("whisper")) return "whisper";
        if (n.contains("moonshine")) return "moonshine";
        if (n.contains("sense")) return "sensevoice";
        if (n.contains("zipformer")) return "zipformer";
        if (n.contains("kokoro")) return "kokoro";
        if (n.contains("pocket")) return "pocket";
        if (n.contains("vits") || n.contains("piper") || n.contains("vctk") || n.contains("lessac")) return "vits";
        boolean enc = false, dec = false, join = false, voices = false, flow = false;
        File[] kids = dir.listFiles();
        if (kids != null) for (File k : kids) {
            String kn = k.getName().toLowerCase(Locale.ROOT);
            if (kn.contains("encoder")) enc = true;
            if (kn.contains("decoder")) dec = true;
            if (kn.contains("joiner")) join = true;
            if (kn.equals("voices.bin")) voices = true;
            if (kn.contains("flow")) flow = true;
        }
        if (flow) return "pocket";
        if (voices) return "kokoro";
        if (join) return "zipformer";
        if (enc && dec) return "whisper";
        return "vits";
    }
}
