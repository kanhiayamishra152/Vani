package ai.vani.model

import android.content.Context
import ai.vani.engine.SttModel
import ai.vani.engine.TtsModel
import java.io.File

/**
 * Scoped-storage layout for downloaded models.
 *
 * Everything lives under the app's own external files dir, which on Android 10+ is
 * app-scoped: no `MANAGE_EXTERNAL_STORAGE` permission, no Storage Access Framework
 * prompt, and the OS reclaims the space when the app is uninstalled. A `.done` marker
 * file distinguishes a complete model directory from a half-finished one, which is what
 * lets a resumed download skip artefacts that already landed.
 */
class ModelStore(context: Context) {

    val rootDir: File =
        context.getExternalFilesDir(null) ?: File(context.filesDir, "models")

    private val downloadTmpDir: File get() = File(rootDir, "_downloads")

    /** Directory holding every artefact of [spec]. */
    fun modelDir(spec: ModelSpec): File = File(rootDir, spec.id)

    /** Directory the downloader writes into while the transfer is in flight. */
    fun downloadDir(spec: ModelSpec): File = File(downloadTmpDir, spec.id)

    /** Primary LLM file (`.gguf`) for a loaded model. */
    fun llmFile(spec: ModelSpec): File {
        val dir = modelDir(spec)
        val named = File(dir, spec.filename)
        if (named.exists()) return named
        return dir.listFiles()?.firstOrNull { it.extension.equals("gguf", true) }
            ?: File(dir, "${spec.id}.gguf")
    }

    /** True only when every artefact and the `.done` marker are present. */
    fun isComplete(spec: ModelSpec): Boolean {
        val dir = modelDir(spec)
        if (!dir.exists() || !File(dir, ".done").exists()) return false
        return spec.artefacts.all { File(dir, it).exists() }
    }

    /** True if a partial download exists (`.part` sidecars or a directory without `.done`). */
    fun isPartial(spec: ModelSpec): Boolean {
        val dir = modelDir(spec)
        if (!dir.exists()) return false
        if (isComplete(spec)) return false
        return dir.walkTopDown().any { it.extension == "part" }
    }

    /** Bytes still free on the volume holding [rootDir], or -1 if unknown. */
    fun freeSpaceBytes(): Long =
        try {
            val stat = java.io.RandomAccessFile(rootDir, "rw")
            stat.use { it.getFileDescriptor().let { fd -> java.io.File("/proc/self/fd/$fd") } }
            rootDir.getUsableSpace()
        } catch (_: Exception) {
            -1L
        }

    /** Resolves a downloaded STT model directory into an engine-ready [SttModel]. */
    fun sttModel(spec: ModelSpec, language: String = "en"): SttModel? {
        val dir = modelDir(spec)
        return SttModel.fromDirectory(dir, language)
    }

    /** Resolves a downloaded TTS model directory into an engine-ready [TtsModel]. */
    fun ttsModel(spec: ModelSpec): TtsModel? = TtsModel.fromDirectory(modelDir(spec))

    /** Deletes a model's directory, including any partial download. */
    fun delete(spec: ModelSpec): Boolean =
        modelDir(spec).deleteRecursively()

    val downloadedModels: List<ModelSpec>
        get() = ModelCatalog.all.filter { isComplete(it) }
}
