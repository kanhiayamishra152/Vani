package ai.vani.engine

import java.io.File

/**
 * Which sherpa-onnx ASR architecture a downloaded model uses.
 *
 * The catalog ships three families, and each maps to a different C struct, so the
 * engine has to know the architecture up front rather than probing the files.
 */
sealed interface SttModel {
    /** Streaming transducer (Parakeet, Zipformer transducer). Partial results available. */
    data class OnlineTransducer(
        val tokens: String, val encoder: String, val decoder: String, val joiner: String
    ) : SttModel

    /** Streaming Zipformer2 CTC. Single `.onnx` file. */
    data class OnlineZipformerCtc(val tokens: String, val model: String) : SttModel

    /** Offline Whisper. Whole-utterance decode, higher accuracy, no partials. */
    data class OfflineWhisper(
        val tokens: String, val encoder: String, val decoder: String,
        val language: String = "en"
    ) : SttModel

    companion object {
        /**
         * Resolves a model directory into an [SttModel].
         *
         * Vani's model catalog stores each STT model as a directory of files; this picks
         * the architecture by which files are present so the Kotlin layer does not need
         * to hard-code file names per model.
         */
        fun fromDirectory(dir: File, language: String = "en"): SttModel? {
            if (!dir.exists()) return null
            val files = dir.listFiles()?.associateBy { it.name.lowercase() } ?: return null

            // Whisper: encoder.onnx + decoder.onnx
            val encoder = files.entries.firstOrNull { it.key.startsWith("encoder") }?.value
            val decoder = files.entries.firstOrNull { it.key.startsWith("decoder") }?.value
            val tokens = files.entries.firstOrNull { it.key.contains("tokens") }?.value
            if (encoder != null && decoder != null && tokens != null) {
                return OfflineWhisper(tokens.absolutePath, encoder.absolutePath, decoder.absolutePath, language)
            }

            // Transducer: encoder + decoder + joiner
            val joiner = files.entries.firstOrNull { it.key.contains("joiner") }?.value
            if (encoder != null && decoder != null && joiner != null && tokens != null) {
                return OnlineTransducer(
                    tokens.absolutePath, encoder.absolutePath, decoder.absolutePath, joiner.absolutePath
                )
            }

            // Single-file streaming model (Zipformer2 CTC, Parakeet-tdnn, ...)
            val onnx = files.entries.firstOrNull {
                it.key.endsWith(".onnx") && !it.key.startsWith("encoder") &&
                    !it.key.startsWith("decoder")
            }?.value
            if (onnx != null && tokens != null) {
                return OnlineZipformerCtc(tokens.absolutePath, onnx.absolutePath)
            }
            return null
        }
    }
}

/**
 * Streaming and offline speech recognition over sherpa-onnx.
 *
 * The streaming path is what powers the live transcript: [acceptWaveform] feeds 16 kHz
 * mono samples, [isReady] tells you when enough frames have accumulated, [decodeOnline]
 * advances the model, and [partialText] returns what has been recognised so far.
 *
 * For Whisper (offline only) the same feed-then-decode shape applies, but the result only
 * appears after [decodeOffline] and [finalText].
 */
class SherpaSttEngine(
    private val model: SttModel,
    private val threads: Int = 2,
    private val sampleRate: Int = 16000,
) {
    private var recognizer: Long = 0
    private var isOnline = false
    private var stream: Long = 0

    val isReady: Boolean get() = recognizer != 0L

    fun create(): Boolean {
        recognizer = when (model) {
            is SttModel.OnlineTransducer ->
                NativeBridge.nativeSttCreateOnlineTransducer(
                    model.tokens, model.encoder, model.decoder, model.joiner,
                    threads, sampleRate, enableEndpoint = true
                )

            is SttModel.OnlineZipformerCtc ->
                NativeBridge.nativeSttCreateOnlineZipformerCtc(
                    model.tokens, model.model, threads, sampleRate, enableEndpoint = true
                )

            is SttModel.OfflineWhisper ->
                NativeBridge.nativeSttCreateOfflineWhisper(
                    model.tokens, model.encoder, model.decoder, threads, sampleRate,
                    model.language, "transcribe"
                )
        }
        if (recognizer == 0L) return false
        isOnline = model is SttModel.OnlineTransducer || model is SttModel.OnlineZipformerCtc
        return true
    }

    /** Opens a fresh per-utterance stream. */
    fun createStream(): Long {
        if (recognizer == 0L) return 0L
        destroyStream()
        stream = if (isOnline) NativeBridge.nativeSttCreateStream(recognizer) else 0L
        return stream
    }

    fun acceptWaveform(samples: FloatArray) {
        if (stream == 0L) return
        if (isOnline) {
            NativeBridge.nativeSttAcceptWaveformOnline(stream, samples)
        } else {
            NativeBridge.nativeSttAcceptWaveformOffline(stream, samples)
        }
    }

    /** True once enough audio has accumulated to decode a chunk. */
    fun isReadyToDecode(): Boolean =
        isOnline && stream != 0L && NativeBridge.nativeSttIsOnlineReady(recognizer, stream)

    fun decodeOnline() {
        if (isOnline && stream != 0L) NativeBridge.nativeSttDecodeOnline(recognizer, stream)
    }

    /** Live partial transcript. */
    fun partialText(): String =
        if (isOnline && stream != 0L) NativeBridge.nativeSttGetOnlineText(recognizer, stream) else ""

    fun resetOnline() {
        if (isOnline && stream != 0L) NativeBridge.nativeSttResetOnline(recognizer, stream)
    }

    /** Signals end of input so the streaming model can flush its tail. */
    fun inputFinished() {
        if (isOnline && stream != 0L) NativeBridge.nativeSttInputFinishedOnline(stream)
    }

    fun decodeOffline() {
        if (!isOnline && stream != 0L) NativeBridge.nativeSttDecodeOffline(recognizer, stream)
    }

    /** Final transcript for offline (Whisper) models. */
    fun finalText(): String =
        if (!isOnline && stream != 0L) NativeBridge.nativeSttGetOfflineText(stream) else ""

    fun destroyStream() {
        if (stream != 0L) {
            if (isOnline) NativeBridge.nativeSttDestroyStream(stream)
            else NativeBridge.nativeSttDestroyOfflineStream(stream)
            stream = 0L
        }
    }

    fun close() {
        destroyStream()
        if (recognizer != 0L) {
            if (isOnline) NativeBridge.nativeSttDestroyOnline(recognizer)
            else NativeBridge.nativeSttDestroyOffline(recognizer)
            recognizer = 0L
        }
    }
}
