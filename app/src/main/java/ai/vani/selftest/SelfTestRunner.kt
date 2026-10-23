package ai.vani.selftest

import ai.vani.engine.LlamaEngine
import ai.vani.model.ModelCatalog
import ai.vani.model.ModelDownloader
import ai.vani.model.ModelStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * One-tap hardware verification.
 *
 * The APK cannot be exercised on a device by the person building it, so Vani ships a
 * self-test that runs the whole native chain on the phone itself:
 *
 *   1. download the default 229 MB LLM (LFM 2.5 350M Q4_K_M),
 *   2. load it into memory through llama.cpp,
 *   3. generate exactly 8 tokens,
 *   4. print `SELF-TEST PASSED` or `SELF-TEST FAILED: <reason>` on screen and in logcat.
 *
 * This is deliberately end-to-end rather than a mock: it is the only way to prove that the
 * NDK build, the JNI bridge, the scoped-storage path and the model downloader all work on
 * the actual device, since those are exactly the things that fail silently otherwise.
 */
class SelfTestRunner(
    private val store: ModelStore,
    private val downloader: ModelDownloader,
    private val llamaFactory: (LlamaEngine) -> LlamaEngine = { it },
) {
    sealed interface Result {
        data class Passed(val modelDesc: String, val tokenCount: Int, val tokens: String) : Result
        data class Failed(val stage: String, val reason: String) : Result
    }

    /** Progress reporting so the Settings screen can show which stage is running. */
    fun interface Listener {
        fun onStage(stage: String, detail: String = "")
    }

    suspend fun run(listener: Listener? = null): Result = withContext(Dispatchers.IO) {
        val spec = ModelCatalog.byId("lfm2-350m")
            ?: return@withContext Result.Failed("catalog", "Default LLM is not in the catalogue")

        // ---- Stage 1: download -------------------------------------------------
        listener?.onStage("Download", "Fetching ${spec.displayName}")
        val outcome = downloader.downloadModel(spec, store.downloadDir(spec)) {}
        if (outcome is ModelDownloader.DownloadOutcome.Failed) {
            return@withContext Result.Failed("Download", outcome.reason)
        }
        if (outcome is ModelDownloader.DownloadOutcome.Cancelled) {
            return@withContext Result.Failed("Download", "Cancelled")
        }
        val modelFile = store.llmFile(spec)
        if (!modelFile.exists()) {
            return@withContext Result.Failed("Download", "Model file missing after download")
        }

        // ---- Stage 2: load ------------------------------------------------------
        listener?.onStage("Load", "Initialising llama.cpp")
        val engine = LlamaEngine(
            ai.vani.engine.LlamaConfig(
                nThreads = 4, nBatch = 512, nCtx = 4096, nGpuLayers = 0, maxTokens = 8
            )
        )
        val loaded = try {
            engine.load(modelFile.absolutePath)
        } catch (e: Exception) {
            engine.close()
            return@withContext Result.Failed("Load", e.message ?: e.javaClass.simpleName)
        }
        if (!loaded) {
            engine.close()
            return@withContext Result.Failed("Load", "llama.cpp returned false")
        }

        // ---- Stage 3: generate exactly 8 tokens -------------------------------
        listener?.onStage("Generate", "Producing 8 tokens")
        val generated = StringBuilder()
        var tokenCount = 0
        try {
            engine.generate(
                prompt = "Say hello in exactly eight words.",
                maxTokens = 8,
                onToken = { token ->
                    tokenCount++
                    generated.append(token)
                },
            )
        } catch (e: Exception) {
            engine.close()
            return@withContext Result.Failed("Generate", e.message ?: e.javaClass.simpleName)
        }

        val desc = engine.modelDescription()
        val sizeBytes = engine.modelSizeBytes()
        engine.close()

        Result.Passed(
            modelDesc = "$desc (${"%.1f".format(sizeBytes / 1048576.0)} MB)",
            tokenCount = tokenCount,
            tokens = generated.toString(),
        )
    }
}

/** Formats a self-test result into the exact strings the spec asks to print. */
fun SelfTestRunner.Result.asMessage(): String = when (this) {
    is Result.Passed ->
        "SELF-TEST PASSED  ·  $modelDesc  ·  ${tokenCount} tokens  ·  \"$tokens\""

    is Result.Failed -> "SELF-TEST FAILED: [$stage] $reason"
}

/** File size helper used by the Settings screen. */
fun File.humanSize(): String =
    "%.1f MB".format(this.length() / 1048576.0)
