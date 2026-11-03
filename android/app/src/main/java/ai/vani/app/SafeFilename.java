package ai.vani.app;

import java.io.File;
import java.net.URI;
import java.util.Locale;

/**
 * Vani AI v1.3.0 — path-traversal & download-URL hardening.
 *
 * Every model filename (downloaded or imported) is sanitized and the resolved
 * canonical path is verified to stay inside getFilesDir()/models/, so a
 * malicious URL or archive entry can never write outside the model sandbox.
 * All model downloads are HTTPS-only with a strict host allowlist and redirect
 * validation (see DownloadService).
 */
public final class SafeFilename {
    private SafeFilename() {}

    /** Strip directory separators, traversal and control chars; keep a safe basename. */
    public static String clean(String name) {
        if (name == null) return "model";
        // Take only the final path component (defeats ../ and absolute paths).
        String n = name.replace('\\', '/');
        int slash = n.lastIndexOf('/');
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[^A-Za-z0-9._-]", "_");
        n = n.replaceAll("\\.{2,}", ".");
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "model";
        if (n.length() > 180) n = n.substring(n.length() - 180);
        return n;
    }

    /** Resolve a child file and guarantee it stays within parent (canonical). */
    public static File safeChild(File parent, String name) throws SecurityException {
        try {
            File f = new File(parent, clean(name));
            String pc = parent.getCanonicalPath() + File.separator;
            String fc = f.getCanonicalPath();
            if (!fc.startsWith(pc)) throw new SecurityException("path traversal blocked: " + name);
            return f;
        } catch (SecurityException se) {
            throw se;
        } catch (Exception e) {
            throw new SecurityException("invalid path: " + name);
        }
    }

    private static final String[] ALLOWED_HOSTS = {
            "huggingface.co", "hf.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co",
            "cas-bridge.xethub.hf.co", "github.com", "objects.githubusercontent.com",
            "release-assets.githubusercontent.com", "raw.githubusercontent.com",
            "codeload.github.com", "drive.google.com", "drive.usercontent.google.com",
    };

    /** HTTPS-only + strict host allowlist for model downloads. */
    public static boolean isAllowedUrl(String url) {
        try {
            URI u = URI.create(url);
            if (!"https".equalsIgnoreCase(u.getScheme())) return false;
            String host = u.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.ROOT);
            for (String h : ALLOWED_HOSTS) {
                if (host.equals(h) || host.endsWith("." + h)) return true;
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}
