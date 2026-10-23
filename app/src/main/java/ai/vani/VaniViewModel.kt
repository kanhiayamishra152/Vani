package ai.vani

import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import ai.vani.engine.LlamaConfig
import ai.vani.engine.LlamaEngine
import ai.vani.engine.SherpaSttEngine
import ai.vani.engine.TtsEngine
import ai.vani.engine.VadEngine
import ai.vani.model.DownloadSession
import ai.vani.model.ModelCatalog
import ai.vani.model.ModelDownloader
import ai.vani.model.ModelKind
import ai.vani.model.ModelSpec
import ai.vani.model.ModelStore
import ai.vani.selftest.SelfTestRunner
import ai.vani.selftest.Result as SelfTestResult
import ai.vani.voice.VoicePipeline
import ai.vani.voice.VaniUiState
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

enum class PermissionState { GRANTED, DENIED, NOT_DETERMINED }

data class ModelUiState(
    val specs: List<ModelSpec> = ModelCatalog.all,
    val progressByModel: Map<String, Float> = emptyMap(),
    val downloadStateByModel: Map<String, DownloadSession.State> = emptyMap(),
    val errorByModel: Map<String, String> = emptyMap(),
)

sealed interface SelfTestUiState {
    data object Idle : SelfTestUiState
    data class Running(val stage: String, val detail: String) : SelfTestUiState
    data class Done(val message: String, val passed: Boolean) : SelfTestUiState
}

/**
 * Application-wide state for Vani.
 *
 * Owns the three things the UI needs but should not own: scoped-storage model paths,
 * in-flight download sessions, and the voice pipeline. Screens stay dumb and render
 * whatever this emits.
 */
class VaniViewModel(app: Application) : AndroidViewModel(app) {

    private val app: Application = app
    private val store = ModelStore(app)
    private val downloader = ModelDownloader()

    private val _uiState = MutableStateFlow(VaniUiState())
    val uiState: StateFlow<VaniUiState> = _uiState.asStateFlow()

    private val _permission = MutableStateFlow(checkPermission())
    val permission: StateFlow<PermissionState> = _permission.asStateFlow()

    private val _modelUi = MutableStateFlow(ModelUiState())
    val modelUi: StateFlow<ModelUiState> = _modelUi.asStateFlow()

    private val _selfTest = MutableStateFlow<SelfTestUiState>(SelfTestUiState.Idle)
    val selfTest: StateFlow<SelfTestUiState> = _selfTest.asStateFlow()

    private val sessions = mutableMapOf<String, DownloadSession>()

    private var pipeline: VoicePipeline? = null
    private val enginesScope = viewModelScope

    // ------------------------------------------------------------------ permissions

    private fun checkPermission(): PermissionState {
        return if (ContextCompat.checkSelfPermission(
                app, android.Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        ) {
            PermissionState.GRANTED
        } else {
            PermissionState.NOT_DETERMINED
        }
    }

    fun onPermissionResult() {
        _permission.value = checkPermission()
        _uiState.value = _uiState.value.copy(micPermissionGranted = _permission.value == PermissionState.GRANTED)
    }

    fun hasMicPermission(): Boolean = _permission.value == PermissionState.GRANTED

    // ------------------------------------------------------------------ models

    /** True when every model in the default English stack is on disk. */
    val isDefaultStackReady: Boolean
        get() = ModelCatalog.defaultStack.all { store.isComplete(it) }

    fun refreshModelState() {
        _modelUi.value = ModelUiState(
            specs = ModelCatalog.all,
            progressByModel = sessions.mapValues { (_, s) -> s.progress.value },
            downloadStateByModel = sessions.mapValues { (_, s) -> s.state.value },
            errorByModel = sessions.mapValues { (_, s) -> s.error.value },
        )
    }

    /** Starts (or resumes) a download for [spec]. */
    fun downloadModel(spec: ModelSpec) {
        if (sessions[spec.id]?.isRunning() == true) return
        val session = DownloadSession(downloader, spec, store.downloadDir(spec), viewModelScope)
        sessions[spec.id] = session

        // Surface this model's progress into the shared UI state.
        viewModelScope.launch {
            session.progress.collect { p ->
                _modelUi.value = _modelUi.value.copy(
                    progressByModel = _modelUi.value.progressByModel + (spec.id to p)
                )
            }
        }
        viewModelScope.launch {
            session.state.collect { s ->
                _modelUi.value = _modelUi.value.copy(
                    downloadStateByModel = _modelUi.value.downloadStateByModel + (spec.id to s)
                )
            }
        }
        viewModelScope.launch {
            session.error.collect { e ->
                _modelUi.value = _modelUi.value.copy(
                    errorByModel = if (e == null) {
                        _modelUi.value.errorByModel - spec.id
                    } else {
                        _modelUi.value.errorByModel + (spec.id to e)
                    }
                )
            }
        }

        session.start()
    }

    fun pauseModel(spec: ModelSpec) {
        sessions[spec.id]?.pause()
        refreshModelState()
    }

    fun resumeModel(spec: ModelSpec) {
        sessions[spec.id]?.resume()
        refreshModelState()
    }

    fun cancelModel(spec: ModelSpec) {
        sessions.remove(spec.id)?.cancel()
        refreshModelState()
    }

    fun deleteModel(spec: ModelSpec) {
        sessions.remove(spec.id)?.cancel()
        store.delete(spec)
        refreshModelState()
    }

    /** Resolves the engine bundle for the currently downloaded stack. */
    fun buildEngines(): Triple<LlamaEngine, SherpaSttEngine, TtsEngine>? {
        val llmSpec = ModelCatalog.llmModels.firstOrNull { store.isComplete(it) } ?: return null
        val sttSpec = ModelCatalog.sttModels.firstOrNull { store.isComplete(it) } ?: return null
        val ttsSpec = ModelCatalog.ttsModels.firstOrNull { store.isComplete(it) } ?: return null

        val llm = LlamaEngine(LlamaConfig(nThreads = 4, nBatch = 512, nCtx = 4096))
        val stt = SherpaSttEngine(store.sttModel(sttSpec) ?: return null)
        val tts = TtsEngine(store.ttsModel(ttsSpec) ?: return null)
        return Triple(llm, stt, tts)
    }

    // ------------------------------------------------------------------ voice

    fun startVoice() {
        if (!hasMicPermission()) {
            _uiState.value = _uiState.value.copy(error = "Microphone permission is required")
            return
        }
        val engines = buildEngines()
        if (engines == null) {
            _uiState.value = _uiState.value.copy(
                error = "Download the default models from the Model Hub first"
            )
            return
        }
        val (llm, stt, tts) = engines
        if (!llm.isReady) {
            enginesScope.launch {
                llm.load(store.llmFile(ModelCatalog.llmModels.first { store.isComplete(it) }).absolutePath)
            }
        }
        if (!stt.isReady) stt.create()
        if (!tts.isReady) tts.create()

        val vad = VadEngine(store.modelDir(ModelCatalog.vadModel).resolve("silero_vad.onnx").absolutePath)
        if (!vad.isReady) {
            _uiState.value = _uiState.value.copy(error = "Voice activity detector failed to start")
            return
        }

        pipeline?.close()
        pipeline = VoicePipeline(
            stt = stt, vad = vad, llm = llm, tts = tts,
            scope = enginesScope,
            onState = { _uiState.value = it },
        )
        pipeline?.start()
    }

    fun stopVoice() {
        pipeline?.stop()
    }

    fun toggleVoice() {
        if (_uiState.value.listening) stopVoice() else startVoice()
    }

    override fun onCleared() {
        pipeline?.close()
        pipeline = null
        sessions.values.forEach { it.cancel() }
        sessions.clear()
    }

    // ------------------------------------------------------------------ self test

    /**
     * Runs the on-device hardware self-test.
     *
     * Result is published to [selfTest] and to logcat, so the outcome is visible both in
     * the app and in `adb logcat -s VaniSelfTest`.
     */
    fun runSelfTest() {
        _selfTest.value = SelfTestUiState.Running("Starting", "Preparing")
        viewModelScope.launch {
            val runner = SelfTestRunner(store, downloader)
            val result = runner.run { stage, detail ->
                _selfTest.value = SelfTestUiState.Running(stage, detail)
            }
            val message = result.asMessage()
            android.util.Log.i("VaniSelfTest", message)
            _selfTest.value = SelfTestUiState.Done(
                message,
                passed = result is SelfTestResult.Passed,
            )
        }
    }

    companion object {
        /** Minimum free space Vani insists on before starting a download. */
        const val MIN_FREE_BYTES = 1L * 1024 * 1024 * 1024
    }
}

/** Convenience so callers can ask "is this model kind downloaded" without the store. */
fun ModelSpec.isDownloaded(store: ModelStore): Boolean = store.isComplete(this)

/** Filters the catalogue for a screen that only shows one engine kind. */
fun List<ModelSpec>.ofKind(kind: ModelKind): List<ModelSpec> = filter { it.kind == kind }
