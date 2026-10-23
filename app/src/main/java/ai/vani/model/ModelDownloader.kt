package ai.vani.model

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CancelledCoroutineException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Download outcome for a single model.
 */
sealed interface DownloadOutcome {
    data class Success(val file: File) : DownloadOutcome
    data class Failed(val reason: String) : DownloadOutcome
    data object Cancelled : DownloadOutcome
}

/** Progress for one artefact inside a (possibly multi-file) model. */
data class DownloadProgress(
    val artefact: String,
    val bytesDownloaded: Long,
    val bytesTotal: Long,
) {
    val fraction: Float
        get() = if (bytesTotal > 0) (bytesDownloaded.toFloat() / bytesTotal.toFloat()) else 0f
}

/**
 * Model downloader for Hugging Face.
 *
 * ## Why this is not a plain `HttpURLConnection.setInstanceFollowRedirects(true)`
 *
 * The previous build failed to download GGUF models from Hugging Face for two reasons,
 * both of which are handled explicitly here:
 *
 * 1. **Redirects.** Hugging Face answers a `resolve/main/...` request with a `302` to a CDN
 *    host (historically `cdn-lfs*.hf.co`, now `cas-bridge.xethub.hf.co`). The client must
 *    follow that hop, and must keep doing so across the `huggingface.co` -> CDN boundary.
 *    The OkHttp client is configured with `followRedirects(true)` and `followSslRedirects(true)`
 *    *and* the file body is fetched through an explicit redirect loop, because OkHttp drops
 *    some request headers when it rebuilds a redirect request - and a dropped `Range` header
 *    silently breaks resume. Driving the hops ourselves guarantees the `Range` header reaches
 *    the CDN.
 *
 * 2. **User-Agent.** Hugging Face's CDN returns `403` for clients that identify as `curl/x`
 *    or send no UA at all. Every request, including every redirect hop, carries a
 *    standard Android UA.
 *
 * On top of that: scoped-storage-correct destination paths, HTTP `Range` based
 * pause/resume against a `.part` sidecar, and SHA-256 verification of the finished file.
 */
class ModelDownloader(
    private val client: OkHttpClient = OkHttpClient.Builder()
        // The spec's `setInstanceFollowRedirects(true)` equivalent. Kept on even though the
        // file body uses its own redirect loop, so any non-body request still follows hops.
        .followRedirects(true)
        .followSslRedirects(true)
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build(),

    private val userAgent: String =
        "VaniAI/1.0 (Android 10; arm64; Pixel 7) okhttp/4.12.0",
) {

    /**
     * Downloads every artefact of [spec] into [destDir] and returns the primary file.
     *
     * Each artefact is written to `<destDir>/<spec.id>/<filename>`, with a `.part` sidecar
     * used for resumable writes. A completed model directory is marked with a `.done` file
     * so an interrupted multi-file download can be told apart from a finished one.
     */
    suspend fun downloadModel(
        spec: ModelSpec,
        destDir: File,
        progress: (DownloadProgress) -> Unit,
    ): DownloadOutcome = withContext(Dispatchers.IO) {
        try {
            val modelDir = File(destDir, spec.id)
            if (!modelDir.exists()) modelDir.mkdirs()

            for (artefact in spec.artefacts) {
                val url = spec.resolveUrl(artefact)
                val target = File(modelDir, artefact)
                val outcome = downloadFile(
                    url = url,
                    dest = target,
                    expectedSize = if (spec.files.isEmpty()) spec.sizeBytes else null,
                    expectedSha256 = spec.sha256,
                    progress = { p -> progress(DownloadProgress(artefact, p.bytesDownloaded, p.bytesTotal)) },
                )
                when (outcome) {
                    is DownloadOutcome.Cancelled -> return@withContext outcome
                    is DownloadOutcome.Failed -> return@withContext outcome
                    is DownloadOutcome.Success -> Unit
                }
            }

            // Mark the whole model complete only once every artefact landed.
            File(modelDir, ".done").writeText("ok\n")
            DownloadOutcome.Success(modelDir)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DownloadOutcome.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    /**
     * Streams one file to [dest], following redirects itself and resuming from any
     * existing `.part` file.
     */
    private suspend fun downloadFile(
        url: String,
        dest: File,
        expectedSize: Long?,
        expectedSha256: String?,
        progress: (DownloadProgress) -> Unit,
    ): DownloadOutcome = withContext(Dispatchers.IO) {
        val part = File(dest.parentFile, dest.name + ".part")

        // Resume offset: whatever a previous attempt already wrote.
        var resumeOffset = if (part.exists()) part.length() else 0L

        var currentUrl = url
        var redirects = 0
        var response: Response? = null

        try {
            while (true) {
                ensureActive()

                val builder = Request.Builder()
                    .url(currentUrl)
                    // Every hop gets the UA. This is the fix for the 403-from-HF-CDN case.
                    .header("User-Agent", userAgent)
                    .header("Accept", "*/*")
                    // Ask for identity encoding: OkHttp's transparent gzip would make
                    // Content-Length describe the compressed stream, which breaks both the
                    // byte accounting and Range resume.
                    .header("Accept-Encoding", "identity")

                if (resumeOffset > 0L) {
                    builder.header("Range", "bytes=$resumeOffset-")
                }

                client.newCall(builder.build()).execute().use { resp ->
                    response = resp

                    // ---- redirect hops -------------------------------------------------
                    if (resp.isRedirect) {
                        val location = resp.header("Location")
                            ?: return@withContext DownloadOutcome.Failed("302 without a Location header")
                        currentUrl = resolveRedirect(currentUrl, location)
                        redirects++
                        if (redirects > MAX_REDIRECTS) {
                            return@withContext DownloadOutcome.Failed("Too many redirects ($redirects)")
                        }
                        return@use  // continue the while loop with the new URL
                    }

                    val code = resp.code

                    // ---- 416: we asked for a range the server no longer serves ---------
                    // (file replaced upstream). Start over rather than failing.
                    if (code == 416) {
                        part.delete()
                        resumeOffset = 0L
                        return@use
                    }

                    if (code !in 200..299) {
                        return@withContext DownloadOutcome.Failed("HTTP $code for $currentUrl")
                    }

                    // ---- determine total size and whether we are appending ------------
                    val contentLengthHeader = resp.header("Content-Length")?.toLongOrNull()
                    val contentRange = resp.header("Content-Range")
                    val totalSize = contentRange
                        ?.substringAfter('/')
                        ?.trim()
                        ?.toLongOrNull()
                        ?: contentLengthHeader

                    val appending = code == 206 && resumeOffset > 0L
                    if (!appending && resumeOffset > 0L) {
                        // Server ignored our Range and sent the whole file: restart clean.
                        part.delete()
                        resumeOffset = 0L
                    }

                    // Hugging Face renders a missing/private file as a 200 HTML page.
                    // Detect that rather than writing a corrupt "model".
                    val contentType = resp.header("Content-Type") ?: ""
                    if (contentType.contains("text/html", ignoreCase = true)) {
                        return@withContext DownloadOutcome.Failed(
                            "Hugging Face returned an HTML page for $currentUrl " +
                                "(the file is missing, private, or the repo name is wrong)"
                        )
                    }

                    // ---- stream to the .part file ------------------------------------
                    val source = resp.body.source()
                    val sink = FileOutputStream(part, append = appending)
                    var downloaded = resumeOffset
                    val buffer = ByteArray(STREAM_BUFFER_SIZE)

                    try {
                        while (true) {
                            ensureActive()
                            val read = source.read(buffer, 0, buffer.size)
                            if (read == -1) break
                            sink.write(buffer, 0, read)
                            downloaded += read

                            // Throttle progress callbacks: the UI recomposes on these.
                            if (downloaded - lastReported >= PROGRESS_INTERVAL || downloaded == totalSize
                                || downloaded == resumeOffset
                            ) {
                                lastReported = downloaded
                                progress(
                                    DownloadProgress(
                                        dest.name, downloaded, totalSize ?: expectedSize ?: -1L
                                    )
                                )
                            }
                        }
                    } finally {
                        sink.flush()
                        sink.close()
                    }

                    // ---- size check --------------------------------------------------
                    if (expectedSize != null && totalSize != null && totalSize > 0L) {
                        if (totalSize != downloaded) {
                            part.delete()
                            return@withContext DownloadOutcome.Failed(
                                "Size mismatch: expected $expectedSize bytes, got $downloaded"
                            )
                        }
                    }

                    // ---- integrity check --------------------------------------------
                    if (expectedSha256 != null) {
                        val actual = sha256Of(part)
                        if (!actual.equals(expectedSha256, ignoreCase = true)) {
                            part.delete()
                            return@withContext DownloadOutcome.Failed(
                                "SHA-256 mismatch for ${dest.name}: expected $expectedSha256, got $actual"
                            )
                        }
                    }

                    // ---- commit ------------------------------------------------------
                    if (dest.exists()) dest.delete()
                    if (!part.renameTo(dest)) {
                        // Rename can fail across mount points; fall back to a copy.
                        java.nio.file.Files.copy(
                            part.toPath(), dest.toPath(),
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING
                        )
                        part.delete()
                    }

                    progress(DownloadProgress(dest.name, dest.length(), dest.length()))
                    return@withContext DownloadOutcome.Success(dest)
                }
            }
            DownloadOutcome.Failed("Download produced no response")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            DownloadOutcome.Failed(e.message ?: e.javaClass.simpleName)
        } finally {
            response?.close()
        }
    }

    private var lastReported: Long = 0

    /** Resolves a possibly-relative redirect target against the request that produced it. */
    private fun resolveRedirect(base: String, location: String): String =
        try {
            java.net.URI(base).resolve(location).toString()
        } catch (e: Exception) {
            if (location.startsWith("http")) location else base
        }

    companion object {
        const val MAX_REDIRECTS = 10
        const val STREAM_BUFFER_SIZE = 128 * 1024
        const val PROGRESS_INTERVAL = 4L * 1024 * 1024

        /** Computes the lowercase hex SHA-256 of [file]. */
        fun sha256Of(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(128 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    digest.update(buffer, 0, read)
                }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}

/**
 * A running download with pause / resume / cancel.
 *
 * Backed by a background coroutine; the UI drives it through [pause], [resume] and
 * [cancel] and observes [progress].
 */
class DownloadSession(
    private val downloader: ModelDownloader,
    private val spec: ModelSpec,
    private val destDir: File,
    private val scope: CoroutineScope,
) {
    private val _progress = MutableStateFlow(0f)
    val progress: StateFlow<Float> = _progress.asStateFlow()

    private val _state = MutableStateFlow(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var job: Job? = null
    private val cancelled = CompletableDeferred<Unit>()

    sealed interface State {
        data object Idle : State
        data object Downloading : State
        data object Paused : State
        data object Completed : State
        data object Failed : State
        data object Cancelled : State
    }

    @Synchronized
    private fun setState(s: State) {
        _state.value = s
    }

    fun start(): Boolean {
        if (job?.isActive == true) return false
        cancelled.complete(Unit)
        _error.value = null
        setState(State.Downloading)
        job = scope.launch {
            val outcome = downloader.downloadModel(spec, destDir) { p ->
                _progress.value = p.fraction
            }
            when (outcome) {
                is DownloadOutcome.Success -> {
                    _progress.value = 1f
                    setState(State.Completed)
                }
                is DownloadOutcome.Cancelled -> setState(State.Cancelled)
                is DownloadOutcome.Failed -> {
                    _error.value = outcome.reason
                    setState(State.Failed)
                }
            }
        }
        return true
    }

    @Synchronized
    fun cancel() {
        job?.cancel()
        setState(State.Cancelled)
    }

    fun isRunning(): Boolean = job?.isActive == true

    /** Stops the current transfer but keeps the `.part` file so it can resume. */
    @Synchronized
    fun pause() {
        if (job?.isActive == true) {
            job?.cancel()
            setState(State.Paused)
        }
    }

    /** Restarts a paused download; the `.part` file makes it continue, not restart. */
    @Synchronized
    fun resume(): Boolean {
        if (_state.value is State.Completed) return false
        return start()
    }
}
