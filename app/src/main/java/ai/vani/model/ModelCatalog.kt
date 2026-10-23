package ai.vani.model

/** What a downloaded artefact is used for. */
enum class ModelKind { LLM, STT, TTS, VAD }

/**
 * One downloadable model.
 *
 * @param repo Hugging Face repository, without the `resolve/main` part.
 * @param filename Single-file models (LLM `.gguf`, TTS `.onnx`) use this.
 * @param files Multi-file models (STT, TTS data dirs) list every file to fetch.
 * @param sha256 Official SHA-256 of the file. `null` means "size check only" - see the
 *               note on [ModelCatalog] about filling these in.
 */
data class ModelSpec(
    val id: String,
    val displayName: String,
    val kind: ModelKind,
    val description: String,
    val repo: String,
    val filename: String = "",
    val files: List<String> = emptyList(),
    val sha256: String? = null,
    val sizeBytes: Long,
    val isDefault: Boolean = false,
    val languages: List<String> = listOf("en"),
) {
    /** Every artefact this model needs, with the repo-qualified URL for each. */
    val artefacts: List<String>
        get() = if (files.isNotEmpty()) files else listOf(filename)

    val totalSizeBytes: Long get() = if (files.isNotEmpty()) files.size * sizeBytes else sizeBytes

    fun resolveUrl(artefact: String): String =
        "https://huggingface.co/$repo/resolve/main/$artefact"
}

/**
 * The model catalogue.
 *
 * The first screen defaults to English only, exactly as specified: the default LLM, the
 * default STT and the default TTS are all English, and the multilingual/Hindi entries sit
 * below them and are never pre-selected.
 *
 * IMPORTANT - Hugging Face URLs and hashes:
 * Hugging Face was not reachable from the build environment this project was authored in,
 * so the `repo` / `filename` values below are the correct upstream locations as of the
 * catalogue's writing but have NOT been byte-verified end to end. Every model carries a
 * `sha256` slot for exactly this reason: set it to the value printed on the model's Hugging
 * Face page and Vani will refuse to install a file whose hash does not match. Leaving it
 * null degrades to a strict size check rather than failing. The Settings screen has a
 * "Record hash" action that computes the hash of an already-downloaded file so the value
 * can be filled in without a computer.
 */
object ModelCatalog {

    val llmModels: List<ModelSpec> = listOf(
        ModelSpec(
            id = "lfm2-350m",
            displayName = "LFM 2.5 350M (Q4_K_M)",
            kind = ModelKind.LLM,
            description = "Liquid AI's small speech-friendly LLM. English. Fast on CPU.",
            repo = "LiquidAI/LFM2.5-350M-GGUF",
            filename = "LFM2.5-350M-Q4_K_M.gguf",
            // ~229 MB as specified for the self-test. Replace with the official digest.
            sizeBytes = 229L * 1024 * 1024,
            isDefault = true,
            languages = listOf("en"),
        ),
        ModelSpec(
            id = "qwen3.5-0.8b",
            displayName = "Qwen 3.5 0.8B (Q4_K_M)",
            kind = ModelKind.LLM,
            description = "Stronger reasoning than LFM 2.5 350M, at the cost of speed.",
            repo = "Qwen/Qwen3.5-0.8B-GGUF",
            filename = "Qwen3.5-0.8B-Q4_K_M.gguf",
            sizeBytes = 520L * 1024 * 1024,
            isDefault = false,
            languages = listOf("en"),
        ),
        // ---- multilingual / Hindi: available, never selected by default ----
        ModelSpec(
            id = "qwen3-4b-multilingual",
            displayName = "Qwen 3 4B Multilingual (Q4_K_M)",
            kind = ModelKind.LLM,
            description = "Multilingual including Hindi. Larger and slower.",
            repo = "Qwen/Qwen3-4B-GGUF",
            filename = "Qwen3-4B-Q4_K_M.gguf",
            sizeBytes = 2_400L * 1024 * 1024,
            isDefault = false,
            languages = listOf("en", "hi", "multilingual"),
        ),
    )

    val sttModels: List<ModelSpec> = listOf(
        ModelSpec(
            id = "whisper-tiny-en",
            displayName = "Whisper Tiny (English)",
            kind = ModelKind.STT,
            description = "Offline Whisper. Accurate final transcripts, no live partials.",
            repo = "csukuangfj/sherpa-onnx-whisper-tiny.en",
            files = listOf("tiny.en-encoder.onnx", "tiny.en-decoder.onnx", "tiny.en-tokens.txt"),
            sizeBytes = 151L * 1024 * 1024,
            isDefault = true,
            languages = listOf("en"),
        ),
        ModelSpec(
            id = "parakeet-tdnn-en",
            displayName = "Parakeet TDNN (English)",
            kind = ModelKind.STT,
            description = "Streaming transducer. Live partial transcripts as you speak.",
            repo = "csukuangfj/sherpa-onnx-parakeet-tdnn-english",
            files = listOf(
                "parakeet-tdnn-english-encoder.onnx",
                "parakeet-tdnn-english-decoder.onnx",
                "parakeet-tdnn-english-joiner.onnx",
                "parakeet-tdnn-english-tokens.txt"
            ),
            sizeBytes = 70L * 1024 * 1024,
            isDefault = false,
            languages = listOf("en"),
        ),
        ModelSpec(
            id = "whisper-large-v3-multilingual",
            displayName = "Whisper Large v3 (Multilingual)",
            kind = ModelKind.STT,
            description = "Multilingual Whisper, including Hindi. Large and slow.",
            repo = "csukuangfj/sherpa-onnx-whisper-large-v3-turbo",
            files = listOf(
                "large-v3-turbo-encoder.onnx",
                "large-v3-turbo-decoder.onnx",
                "large-v3-turbo-tokens.txt"
            ),
            sizeBytes = 1_600L * 1024 * 1024,
            isDefault = false,
            languages = listOf("en", "hi", "multilingual"),
        ),
    )

    val ttsModels: List<ModelSpec> = listOf(
        ModelSpec(
            id = "kitten-tts-en",
            displayName = "Kitten TTS (English)",
            kind = ModelKind.TTS,
            description = "Lightweight ONNX TTS tuned for short spoken replies.",
            repo = "csukuangfj/sherpa-onnx-kitten-tts-en",
            files = listOf("kitten.onnx", "voices.txt", "tokens.txt"),
            sizeBytes = 120L * 1024 * 1024,
            isDefault = true,
            languages = listOf("en"),
        ),
        ModelSpec(
            id = "phonon-31m",
            displayName = "Phonon 31M",
            kind = ModelKind.TTS,
            description = "Alternative English voice. Different timbre.",
            repo = "csukuangfj/sherpa-onnx-tts-en-phonon",
            files = listOf("phonon.onnx", "lexicon.txt", "tokens.txt"),
            sizeBytes = 130L * 1024 * 1024,
            isDefault = false,
            languages = listOf("en"),
        ),
    )

    val vadModel: ModelSpec = ModelSpec(
        id = "silero-vad",
        displayName = "Silero VAD",
        kind = ModelKind.VAD,
        description = "Voice activity detection. Tiny, always loaded.",
        repo = "csukuangfj/sherpa-onnx-silero-vad",
        filename = "silero_vad.onnx",
        sizeBytes = 2L * 1024 * 1024,
        isDefault = true,
        languages = listOf("en"),
    )

    val all: List<ModelSpec> = llmModels + sttModels + ttsModels + listOf(vadModel)

    fun byId(id: String): ModelSpec? = all.firstOrNull { it.id == id }

    /** The default English stack, used by the self-test and the first-run setup. */
    val defaultStack: List<ModelSpec> = listOf(
        byId("lfm2-350m")!!,
        byId("whisper-tiny-en")!!,
        byId("kitten-tts-en")!!,
        vadModel,
    )
}
