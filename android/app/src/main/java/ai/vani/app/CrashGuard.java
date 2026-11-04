package ai.vani.app;

import android.util.Log;

/**
 * Fatal diagnostics without a second crash or an automatic process-kill policy.
 *
 * Older watchdog code could block on native teardown from an arbitrary crashing
 * thread and contained explicit killProcess/System.exit paths. Android already
 * owns fatal-process cleanup; this guard only preserves the original handler and
 * adds a useful thread tag. Normal lifecycle and memory-pressure handling live
 * in MainActivity and the individual engines.
 */
public final class CrashGuard {
    private static final String TAG = "VaniCrashGuard";
    private static boolean installed = false;

    CrashGuard(MainActivity ignored) {}

    /** Kept for bridge compatibility; no perpetual heartbeat thread is needed. */
    public void heartbeat() {}
    void start() {}
    void stop() {}

    synchronized void installUncaughtHandler() {
        if (installed) return;
        installed = true;
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        if (previous == null) { installed = false; return; }
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try { Log.e(TAG, "fatal exception on " + thread.getName(), error); }
            catch (Throwable ignored) {}
            // Never join/generate/free native objects on the crashing thread and
            // never replace Android's own fatal handler with System.exit().
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }
}
