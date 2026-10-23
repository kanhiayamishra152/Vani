package ai.vani.engine

/**
 * JNI surface for the two native engines.
 *
 * Every declaration here must match a `Java_ai_vani_engine_NativeBridge_*` symbol in
 * `app/src/main/cpp/vani_jni.cpp`. The two are kept adjacent in the source tree on
 * purpose - a mismatch is a runtime UnsatisfiedLinkError, not a compile error, so the
 * mapping is documented on both sides.
 */
object NativeBridge {

    init {
        System.loadLibrary("vani_jni")
    }

    /** Registers the Java object that receives llama.cpp model-load progress. */
    external fun nativeInit(): Boolean

    /**
     * Attaches the progress listener. The object must expose a public
     * `fun onProgress(p: Float)` method; the native side resolves it reflectively and
     * calls it from whatever thread is loading the model.
     */
    external fun nativeRegisterProgress(listener: Any)

    external fun nativeLlamaBackendFree()

    /** Last progress value reported to the listener, for UIs that poll instead. */
    external fun nativePollProgress(): Float

    // ---- llama.cpp ----
    external fun nativeLlamaLoadModel(
        path: String, gpuLayers: Int, threads: Int, batch: Int, vocabOnly: Boolean
    ): Long

    external fun nativeLlamaFreeModel(handle: Long)

    external fun nativeLlamaInitContext(
        modelHandle: Long, nCtx: Int, threads: Int, batch: Int, seqMax: Int
    ): Long

    external fun nativeLlamaTokenize(handle: Long, text: String, addBos: Boolean): IntArray

    external fun nativeLlamaDecodeTokens(handle: Long, tokens: IntArray): Int

    /** Returns the next token id, or -1 on failure. */
    external fun nativeLlamaSample(handle: Long): Int

    external fun nativeLlamaTokenToPiece(handle: Long, token: Int): String

    external fun nativeLlamaMemoryClear(handle: Long)

    external fun nativeLlamaModelDesc(handle: Long): String

    /** Model file size in bytes. */
    external fun nativeLlamaModelSize(handle: Long): Long

    /** Number of parameters. */
    external fun nativeLlamaModelNParams(handle: Long): Long

    // ---- sherpa-onnx streaming STT ----
    external fun nativeSttCreateOnlineTransducer(
        tokens: String, encoder: String, decoder: String, joiner: String,
        threads: Int, sampleRate: Int, enableEndpoint: Boolean
    ): Long

    external fun nativeSttCreateOnlineZipformerCtc(
        tokens: String, model: String, threads: Int, sampleRate: Int, enableEndpoint: Boolean
    ): Long

    // ---- sherpa-onnx offline STT (Whisper) ----
    external fun nativeSttCreateOfflineWhisper(
        tokens: String, encoder: String, decoder: String, threads: Int, sampleRate: Int,
        language: String, task: String
    ): Long

    external fun nativeSttDestroyOnline(handle: Long)

    external fun nativeSttDestroyOffline(handle: Long)

    external fun nativeSttCreateStream(recognizer: Long): Long

    external fun nativeSttDestroyStream(stream: Long)

    external fun nativeSttDestroyOfflineStream(stream: Long)

    external fun nativeSttAcceptWaveformOnline(stream: Long, samples: FloatArray)

    external fun nativeSttIsOnlineReady(recognizer: Long, stream: Long): Boolean

    external fun nativeSttDecodeOnline(recognizer: Long, stream: Long)

    /** Live partial transcript accumulated so far. */
    external fun nativeSttGetOnlineText(recognizer: Long, stream: Long): String

    external fun nativeSttResetOnline(recognizer: Long, stream: Long)

    external fun nativeSttInputFinishedOnline(stream: Long)

    external fun nativeSttAcceptWaveformOffline(stream: Long, samples: FloatArray)

    external fun nativeSttDecodeOffline(recognizer: Long, stream: Long)

    external fun nativeSttGetOfflineText(stream: Long): String

    // ---- sherpa-onnx Silero VAD ----
    external fun nativeVadCreate(
        model: String, threshold: Float, minSilence: Float, minSpeech: Float, maxSpeech: Float,
        windowSize: Int, threads: Int
    ): Long

    external fun nativeVadDestroy(handle: Long)

    external fun nativeVadAcceptWaveform(handle: Long, samples: FloatArray)

    /** True when a completed speech segment is ready to be popped. */
    external fun nativeVadProcess(handle: Long): Boolean

    external fun nativeVadPop(handle: Long)

    external fun nativeVadClear(handle: Long)

    external fun nativeVadFlush(handle: Long)

    // ---- sherpa-onnx offline TTS (ONNX Runtime, CPU) ----
    external fun nativeTtsCreateKitten(
        model: String, voices: String, tokens: String, dataDir: String,
        lengthScale: Float, threads: Int
    ): Long

    external fun nativeTtsCreateVits(
        model: String, lexicon: String, tokens: String, dataDir: String,
        noiseScale: Float, noiseScaleW: Float, lengthScale: Float, threads: Int
    ): Long

    external fun nativeTtsDestroy(handle: Long)

    external fun nativeTtsSampleRate(handle: Long): Int

    /** Synthesises [text] into a mono float buffer in [-1, 1]. */
    external fun nativeTtsGenerate(
        handle: Long, text: String, silenceScale: Float, speed: Float, sid: Int
    ): FloatArray

    /** llama.cpp build string. */
    external fun nativeBackendInfo(): String
}

/** Receives llama.cpp model-load progress in the 0.0..1.0 range. */
fun interface LlamaProgressListener {
    fun onProgress(progress: Float)
}
