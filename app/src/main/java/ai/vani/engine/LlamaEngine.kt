package ai.vani.engine

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Inference settings for the LLM.
 */
data class LlamaConfig(
    val nThreads: Int = 4,
    val nBatch: Int = 512,
    val nCtx: Int = 4096,
    /** Layers offloaded to the GPU. Vani defaults to 0: CPU-only is far more predictable
     *  for the self-test and does not fight the GPU for the display pipeline. */
    val nGpuLayers: Int = 0,
    /** Maximum tokens to generate for a single reply. */
    val maxTokens: Int = 512,
)

/**
 * Minimal chat-template support.
 *
 * Vani deliberately formats prompts on the Kotlin side rather than pulling each model's
 * template out of llama.cpp: the catalog is small, the templates are short, and doing it
 * here keeps the JNI surface tiny and makes the exact prompt bytes auditable in one place.
 */
interface ChatTemplate {
    fun format(history: List<ChatTurn>, userMessage: String): String

    companion object {
        /** LFM 2.x / Qwen3 style: explicit role tags, system prompt first. */
        val LFM_QWEN: ChatTemplate = object : ChatTemplate {
            override fun format(history: List<ChatTurn>, userMessage: String): String {
                val sb = StringBuilder()
                sb.append("<|im_start|>system\n")
                sb.append(SYSTEM_PROMPT)
                sb.append("<|im_end|>\n")
                for (turn in history) {
                    sb.append("<|im_start|>").append(turn.role).append('\n')
                    sb.append(turn.content).append("\n<|im_end|>\n")
                }
                sb.append("<|im_start|>user\n").append(userMessage).append("\n<|im_end|>\n")
                sb.append("<|im_start|>assistant\n")
                return sb.toString()
            }
        }

        val NONE: ChatTemplate = object : ChatTemplate {
            override fun format(history: List<ChatTurn>, userMessage: String): String =
                history.joinToString("") { it.content + "\n" } + userMessage + "\n"
        }
    }

    const val SYSTEM_PROMPT =
        "You are Vani, a concise voice assistant running entirely on the user's phone. " +
            "Answer in short, natural sentences meant to be spoken aloud. No markdown, no " +
            "lists, no emoji, no preamble. If you do not know, say so briefly."
}

data class ChatTurn(val role: String, val content: String)

/**
 * Thin wrapper over llama.cpp for token streaming.
 *
 * Threading: [generate] runs the decode loop on [Dispatchers.Default] and serialises it
 * with the native mutex. Cancellation stops the loop between tokens, so a barge-in never
 * waits for a full generation to finish.
 */
class LlamaEngine(
    private val config: LlamaConfig,
    private val template: ChatTemplate = ChatTemplate.LFM_QWEN,
) {
    private var handle: Long = 0
    private var loadedPath: String? = null
    private var isLoaded = false

    private val _state = MutableStateFlow(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    sealed interface State {
        data object Idle : State
        data class Loading(val progress: Float) : State
        data object Ready : State
        data object Generating : State
        data object Error(val message: String) : State
    }

    val isReady: Boolean get() = isLoaded

    /**
     * Loads the model from disk.
     *
     * @param path absolute path to the `.gguf` file.
     * @param progress optional progress callback (0.0..1.0) invoked from the loading thread.
     * @return true on success.
     */
    suspend fun load(path: String, progress: ((Float) -> Unit)? = null): Boolean =
        withContext(Dispatchers.Default) {
            val file = File(path)
            if (!file.exists()) {
                _state.value = State.Error("Model file not found: ${file.absolutePath}")
                return@withContext false
            }
            if (handle != 0) return@withContext true

            NativeBridge.nativeInit()
            NativeBridge.nativeRegisterProgress(ProgressBridge(progress))

            _state.value = State.Loading(0f)
            val modelHandle = NativeBridge.nativeLlamaLoadModel(
                path, config.nGpuLayers, config.nThreads, config.nBatch, false
            )
            if (modelHandle == 0L) {
                _state.value = State.Error("llama.cpp failed to load the model")
                return@withContext false
            }
            val ctxHandle = NativeBridge.nativeLlamaInitContext(
                modelHandle, config.nCtx, config.nThreads, config.nBatch, 1
            )
            if (ctxHandle == 0L) {
                NativeBridge.nativeLlamaFreeModel(modelHandle)
                _state.value = State.Error("llama.cpp failed to allocate a context")
                return@withContext false
            }
            handle = ctxHandle
            loadedPath = path
            isLoaded = true
            _state.value = State.Ready
            true
        }

    /**
     * Streams a completion. Each token is decoded to text and handed to [onToken] before
     * the next decode, which is what makes the UI feel live.
     *
     * @return the full generated text.
     */
    suspend fun generate(
        prompt: String,
        maxTokens: Int = config.maxTokens,
        onToken: (String) -> Unit,
    ): String = withContext(Dispatchers.Default) {
        if (!isLoaded) error("LlamaEngine is not loaded")

        val tokens = NativeBridge.nativeLlamaTokenize(handle, prompt, addBos = true)
        if (tokens.isEmpty()) error("Tokenisation produced no tokens")

        val decodeResult = NativeBridge.nativeLlamaDecodeTokens(handle, tokens)
        if (decodeResult != 0) error("llama_decode failed with code $decodeResult")

        _state.value = State.Generating
        val out = StringBuilder()
        var stop = false

        for (i in 0 until maxTokens) {
            ensureActive()
            val token = NativeBridge.nativeLlamaSample(handle)
            if (token == -1) {
                _state.value = State.Error("Sampling failed")
                break
            }
            if (token == VOCAB_EOS) {
                stop = true
                break
            }
            val piece = NativeBridge.nativeLlamaTokenToPiece(handle, token)
            if (piece.isNotEmpty()) {
                out.append(piece)
                onToken(piece)
            }
            if (i + 1 < maxTokens) {
                val rc = NativeBridge.nativeLlamaDecodeTokens(handle, intArrayOf(token))
                if (rc != 0) {
                    _state.value = State.Error("llama_decode failed mid-generation: $rc")
                    break
                }
            }
        }
        _state.value = State.Idle
        out.toString()
    }

    /** Empties the KV cache so the next exchange starts from a clean context. */
    fun clearContext() {
        if (handle != 0L) NativeBridge.nativeLlamaMemoryClear(handle)
    }

    /** Human-readable model description, e.g. "LFM2-350M Q4_K_M". */
    fun modelDescription(): String =
        if (handle != 0L) NativeBridge.nativeLlamaModelDesc(handle) else ""

    fun modelSizeBytes(): Long = if (handle != 0L) NativeBridge.nativeLlamaModelSize(handle) else 0L

    fun modelParameterCount(): Long =
        if (handle != 0L) NativeBridge.nativeLlamaModelNParams(handle) else 0L

    fun close() {
        if (handle != 0L) {
            NativeBridge.nativeLlamaFreeModel(handle)
            handle = 0
        }
        isLoaded = false
        loadedPath = null
        _state.value = State.Idle
    }

    private companion object {
        /** End-of-sequence id. llama.cpp exposes it via llama_vocab_eos; Vani hard-codes
         *  the conventional id rather than adding another JNI call, and treats sampling
         *  failure as a stop so generation always terminates. */
        const val VOCAB_EOS = 2
    }
}

/**
 * Adapts a Kotlin closure to the reflective `onProgress(float)` the native side calls.
 */
private class ProgressBridge(private val callback: ((Float) -> Unit)?) {
    fun onProgress(p: Float) {
        callback?.invoke(p)
    }
}
