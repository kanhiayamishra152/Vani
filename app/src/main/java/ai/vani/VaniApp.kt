package ai.vani

import android.app.Application
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Application entry point.
 *
 * The llama.cpp backend is initialised once, here, rather than on first inference:
 * `llama_backend_init()` is not cheap and must not happen on the UI thread. Doing it in
 * `onCreate` on a background scope means the first voice request is not paying for it.
 */
class VaniApp : Application() {

    /** Process-wide scope for engine initialisation. */
    val appScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private var backendInitialised = false

    override fun onCreate() {
        super.onCreate()
        initialiseBackend()
    }

    private fun initialiseBackend() {
        if (backendInitialised) return
        backendInitialised = true
        appScope.launch {
            try {
                // Registering the progress listener here means any model load triggered
                // later still has a place to report progress even if no screen is attached.
                NativeBridgeHolder.initialise()
                Log.i(TAG, "Native backend ready: ${NativeBridgeHolder.backendInfo()}")
            } catch (e: Exception) {
                Log.e(TAG, "Native backend initialisation failed", e)
            }
        }
    }

    companion object {
        private const val TAG = "VaniApp"
    }
}

/**
 * Thin accessor for the JNI bridge.
 *
 * `NativeBridge` is an `object`, so it needs no holder - but keeping the initialisation
 * call in one place means the Activity, the ViewModel and the self-test cannot each
 * decide whether to call it, which is how you get a `UnsatisfiedLinkError` on a cold
 * start of one screen but not another.
 */
object NativeBridgeHolder {
    private var ready = false

    fun initialise() {
        if (ready) return
        ai.vani.engine.NativeBridge.nativeInit()
        ready = true
    }

    fun backendInfo(): String = if (ready) ai.vani.engine.NativeBridge.nativeBackendInfo() else ""
}
