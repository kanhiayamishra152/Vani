package ai.vani.engine

import java.io.File

/**
 * Silero voice-activity detection over sherpa-onnx.
 *
 * Feed 16 kHz mono samples with [acceptWaveform]; [hasSpeechSegment] reports whether a
 * complete utterance has been segmented and is ready to be consumed with [pop]. This is
 * what turns "the mic is open" into "the user finished speaking" without a fixed timeout,
 * which is what makes barge-in feel instant.
 */
class VadEngine(
    modelPath: String,
    threshold: Float = 0.5f,
    minSilenceSeconds: Float = 0.5f,
    minSpeechSeconds: Float = 0.25f,
    maxSpeechSeconds: Float = 20f,
    windowSize: Int = 512,
    threads: Int = 2,
) {
    private val handle: Long = NativeBridge.nativeVadCreate(
        modelPath, threshold, minSilenceSeconds, minSpeechSeconds, maxSpeechSeconds,
        windowSize, threads
    )

    val isReady: Boolean get() = handle != 0L

    fun acceptWaveform(samples: FloatArray) {
        if (handle != 0L) NativeBridge.nativeVadAcceptWaveform(handle, samples)
    }

    /** True when a completed speech segment is waiting to be consumed. */
    fun hasSpeechSegment(): Boolean = handle != 0L && NativeBridge.nativeVadProcess(handle)

    fun pop() {
        if (handle != 0L) NativeBridge.nativeVadPop(handle)
    }

    /** Drops queued segments without consuming them (used when audio is discarded). */
    fun clear() {
        if (handle != 0L) NativeBridge.nativeVadClear(handle)
    }

    /** Flushes buffered audio; call before final decoding so trailing speech is kept. */
    fun flush() {
        if (handle != 0L) NativeBridge.nativeVadFlush(handle)
    }

    fun close() {
        if (handle != 0L) NativeBridge.nativeVadDestroy(handle)
    }
}

/** Which TTS architecture a model directory contains. */
sealed interface TtsModel {
    /** Kitten TTS - the English default in Vani's catalog. */
    data class Kitten(
        val model: String, val voices: String, val tokens: String, val dataDir: String
    ) : TtsModel

    /** VITS - the broadest fallback, used by most community TTS releases. */
    data class Vits(
        val model: String, val lexicon: String, val tokens: String, val dataDir: String
    ) : TtsModel

    companion object {
        fun fromDirectory(dir: File): TtsModel? {
            if (!dir.exists()) return null
            val files = dir.listFiles()?.associateBy { it.name.lowercase() } ?: return null

            fun first(vararg prefixes: String): File? =
                files.entries.firstOrNull { e ->
                    e.key.endsWith(".onnx") && prefixes.any { e.key.startsWith(it) }
                }?.value

            // Kitten ships model.onnx + voices.txt + tokens.txt in a data dir.
            val kitten = files.entries.firstOrNull { it.key.contains("kitten") }?.value
            if (kitten != null) {
                val voices = files.entries.firstOrNull { it.key.contains("voices") }?.value
                val tokens = files.entries.firstOrNull { it.key.contains("tokens") }?.value
                return Kitten(
                    kitten.absolutePath,
                    voices?.absolutePath ?: "",
                    tokens?.absolutePath ?: "",
                    dir.absolutePath
                )
            }

            val onnx = files.entries.firstOrNull { it.key.endsWith(".onnx") }?.value ?: return null
            val lexicon = files.entries.firstOrNull { it.key.contains("lexicon") }?.value
            val tokens = files.entries.firstOrNull { it.key.contains("tokens") }?.value
            return Vits(
                onnx.absolutePath,
                lexicon?.absolutePath ?: "",
                tokens?.absolutePath ?: "",
                dir.absolutePath
            )
        }
    }
}

/**
 * Offline TTS synthesis over sherpa-onnx / ONNX Runtime, CPU only.
 *
 * Vani calls [synthesize] once per sentence rather than once per reply. That is what
 * allows the first sentence to start speaking while the LLM is still generating the
 * next one - the overlap is the whole point of the pipeline.
 */
class TtsEngine(
    private val model: TtsModel,
    private val threads: Int = 2,
    private val lengthScale: Float = 1.0f,
) {
    private var handle: Long = 0

    val isReady: Boolean get() = handle != 0L

    val sampleRate: Int get() = if (handle != 0L) NativeBridge.nativeTtsSampleRate(handle) else 0

    fun create(): Boolean {
        handle = when (model) {
            is TtsModel.Kitten ->
                NativeBridge.nativeTtsCreateKitten(
                    model.model, model.voices, model.tokens, model.dataDir, lengthScale, threads
                )

            is TtsModel.Vits ->
                NativeBridge.nativeTtsCreateVits(
                    model.model, model.lexicon, model.tokens, model.dataDir,
                    0.668f, 0.5f, lengthScale, threads
                )
        }
        return handle != 0L
    }

    /**
     * Synthesises [text] to a mono float buffer in [-1, 1].
     *
     * @return the samples, or null if synthesis failed. The audio is then queued by the
     *         pipeline and rendered by the audio player.
     */
    fun synthesize(text: String, silenceScale: Float = 0.2f, speed: Float = 1.0f): FloatArray? {
        if (handle == 0L || text.isBlank()) return null
        val samples = NativeBridge.nativeTtsGenerate(handle, text, silenceScale, speed, 0)
        return if (samples.isEmpty()) null else samples
    }

    fun close() {
        if (handle != 0L) {
            NativeBridge.nativeTtsDestroy(handle)
            handle = 0
        }
    }
}
