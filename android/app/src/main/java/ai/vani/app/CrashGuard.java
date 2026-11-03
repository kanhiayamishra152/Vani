package ai.vani.app;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;

import org.json.JSONObject;

/**
 * Vani AI v1.3.0 — anti-freeze memory watchdog & GPU/thermal circuit breaker.
 *
 * Root cause of the v1.2.0 device lockup: uncompressed 4K VRM textures + a 2.0
 * pixel ratio + MSAA exhausted the Adreno 613's shared VRAM and hung Android's
 * WindowManager. This guard runs a lightweight native thread that samples
 * ActivityManager.MemoryInfo and the WebView heartbeat every 1000 ms:
 *
 *  - availMem < 450 MB (or lowMemory)  -> emit "memory.pressure" so JS unloads
 *    the WebGL avatar + heavy buffers BEFORE the kernel LMKD reacts.
 *  - WebView heartbeat silent > 3.5 s  -> the UI/GPU thread is frozen: release
 *    native llama.cpp / sherpa-onnx / AudioRecord handles immediately.
 *  - critical pressure persists        -> cleanly exit the app process so the
 *    phone OS never locks up (finishAndRemoveTask + System.exit).
 *
 * A global Thread.setDefaultUncaughtExceptionHandler releases the same native
 * handles on any fatal crash before the process dies.
 */
public final class CrashGuard {
    private static final String TAG = "VaniCrashGuard";
    private static final long PRESSURE_BYTES = 450L * 1024 * 1024;   // 450 MB
    private static final long CRITICAL_BYTES = 280L * 1024 * 1024;   // 280 MB
    private static final long FREEZE_MS = 3500;                      // 3.5 s
    private static final long HARD_EXIT_MS = 6000;                   // last resort

    private final MainActivity act;
    private final ActivityManager am;
    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile long lastHeartbeat = System.currentTimeMillis();
    private volatile boolean running = false;
    private volatile boolean released = false;
    private int criticalStreak = 0;
    private Thread thread;

    CrashGuard(MainActivity act) {
        this.act = act;
        this.am = (ActivityManager) act.getSystemService(Context.ACTIVITY_SERVICE);
    }

    /** Called from the JS heartbeat (bridge) ~once per second. */
    public void heartbeat() { lastHeartbeat = System.currentTimeMillis(); }

    void start() {
        if (running) return;
        running = true;
        lastHeartbeat = System.currentTimeMillis();
        thread = new Thread(() -> {
            while (running) {
                try { tick(); } catch (Throwable t) { Log.w(TAG, "watchdog tick", t); }
                try { Thread.sleep(1000); } catch (InterruptedException e) { break; }
            }
        }, "vani-crashguard");
        thread.setDaemon(true);
        thread.start();
    }

    private void tick() {
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        long avail = mi.availMem;
        long now = System.currentTimeMillis();
        long silent = now - lastHeartbeat;

        // --- Hard freeze: the WebView/GPU thread stopped answering. ---
        if (silent > FREEZE_MS) {
            Log.e(TAG, "WebView frozen for " + silent + "ms — releasing native buffers");
            releaseNativeHeavy();
            if (silent > HARD_EXIT_MS) {
                Log.e(TAG, "still frozen after " + silent + "ms — clean exit to protect the OS");
                cleanExit();
                return;
            }
        }

        // --- Memory pressure: tell JS to drop the avatar before LMKD does. ---
        if (avail < PRESSURE_BYTES || mi.lowMemory) {
            emitPressure(avail, mi.lowMemory);
        }

        // --- Sustained critical pressure: exit cleanly rather than lock the OS. ---
        if (avail < CRITICAL_BYTES || mi.lowMemory) {
            criticalStreak++;
            if (criticalStreak >= 3) {
                Log.e(TAG, "critical memory pressure (" + (avail / 1048576) + "MB) x" + criticalStreak + " — clean exit");
                releaseNativeHeavy();
                cleanExit();
            }
        } else {
            criticalStreak = 0;
        }
    }

    private void emitPressure(long avail, boolean low) {
        try {
            JSONObject p = new JSONObject()
                    .put("availBytes", avail).put("availMb", avail / 1048576)
                    .put("lowMemory", low).put("level", avail < CRITICAL_BYTES ? "critical" : "warning");
            act.emit("memory.pressure", p.toString());
        } catch (Exception ignored) {}
    }

    /** Release llama.cpp / sherpa-onnx / AudioRecord without touching the WebView. */
    private void releaseNativeHeavy() {
        if (released) return;
        released = true;
        try { act.llm.shutdown(); } catch (Throwable ignored) {}
        try { act.speech.release(); } catch (Throwable ignored) {}
        try { act.emit("crashguard.released", "{}"); } catch (Throwable ignored) {}
    }

    private void cleanExit() {
        releaseNativeHeavy();
        main.post(() -> {
            try { act.finishAndRemoveTask(); } catch (Throwable ignored) {}
            // Give the UI a moment to finish, then guarantee the process dies so
            // a wedged GPU driver cannot take the whole phone down with it.
            main.postDelayed(() -> { Process.killProcess(Process.myPid()); System.exit(0); }, 400);
        });
        // If the main looper is itself wedged, exit from this thread shortly.
        try { Thread.sleep(1200); } catch (InterruptedException ignored) {}
        Process.killProcess(Process.myPid());
        System.exit(0);
    }

    /** Install the global fatal-crash handler (releases native handles first). */
    void installUncaughtHandler() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            Log.e(TAG, "uncaught exception on " + t.getName() + " — releasing native handles", e);
            try { releaseNativeHeavy(); } catch (Throwable ignored) {}
            try { act.emit("crashguard.fatal", "{}"); } catch (Throwable ignored) {}
            if (prev != null) prev.uncaughtException(t, e);
            else { Process.killProcess(Process.myPid()); System.exit(1); }
        });
    }

    void stop() {
        running = false;
        try { if (thread != null) thread.interrupt(); } catch (Throwable ignored) {}
    }
}
