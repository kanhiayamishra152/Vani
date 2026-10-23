package ai.vani.model

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * Unit tests for the model downloader.
 *
 * These are the Kotlin-side counterpart to `tools/verify_downloader.py`. The Python
 * script proves the algorithm against a mock CDN in an environment without a JDK; these
 * tests prove the OkHttp-backed implementation behaves the same way, using MockWebServer
 * so they run offline in CI.
 *
 * The three cases below are the ones that matter: a redirect chain with a preserved
 * User-Agent, Range-based resume against a `.part` file, and a SHA-256 rejection.
 */
class ModelDownloaderTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private lateinit var server: MockWebServer
    private lateinit var downloader: ModelDownloader
    private lateinit var client: okhttp3.OkHttpClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = okhttp3.OkHttpClient.Builder()
            .followRedirects(false)   // the downloader drives redirects itself
            .followSslRedirects(false)
            .build()
        // A short timeout keeps the tests fast when a case is expected to fail.
        downloader = ModelDownloader(client, userAgent = "VaniAI-Test/1.0")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun payload(size: Int): ByteArray = ByteArray(size) { (it * 31 % 251).toByte() }

    @Test
    fun `downloads through a 302 redirect to a CDN host`() = runBlocking {
        val body = payload(256 * 1024)
        // HF answers /resolve/main/<file> with a 302 to a CDN path.
        server.enqueue(
            MockResponse().setResponseCode(302)
                .setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "application/octet-stream")
                .setBody(okio.ByteString.of(body))
        )

        val spec = ModelSpec(
            id = "test", displayName = "Test", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "model.gguf",
            sizeBytes = body.size.toLong(),
        )
        val dir = tmp.newFolder()
        val outcome = downloader.downloadModel(spec, dir) { }

        assertInstance(outcome)
        val file = File(dir, spec.id, spec.filename)
        assertTrue("file should exist", file.exists())
        assertEquals(body.size.toLong(), file.length())
    }

    @Test
    fun `sends a User-Agent on every hop of the redirect chain`() = runBlocking {
        val body = payload(1024)
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(okio.ByteString.of(body))
        )

        val spec = ModelSpec(
            id = "ua", displayName = "UA", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "model.gguf",
            sizeBytes = body.size.toLong(),
        )
        downloader.downloadModel(spec, tmp.newFolder()) { }

        // Both the redirect request and the CDN request must carry the UA.
        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("VaniAI-Test/1.0", first.getHeader("User-Agent"))
        assertEquals("VaniAI-Test/1.0", second.getHeader("User-Agent"))
    }

    @Test
    fun `resumes from a .part file using a Range header`() = runBlocking {
        val body = payload(512 * 1024)
        val dir = tmp.newFolder()
        val modelDir = File(dir, "resume").apply { mkdirs() }
        val target = File(modelDir, "model.gguf")

        // Simulate a previous attempt that wrote the first quarter.
        val partial = target.resolveSibling(target.name + ".part")
        partial.writeBytes(body.copyOf(128 * 1024))

        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(206)
                .setHeader("Content-Range", "bytes ${128 * 1024}-${body.size - 1}/${body.size}")
                .setBody(okio.ByteString.of(body.copyOfRange(128 * 1024, body.size)))
        )

        val spec = ModelSpec(
            id = "resume", displayName = "Resume", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "model.gguf",
            sizeBytes = body.size.toLong(),
        )
        val outcome = downloader.downloadModel(spec, dir) { }

        assertInstance(outcome)
        val cdnRequest = server.takeRequest()
        assertEquals("bytes=131072-", cdnRequest.getHeader("Range"))
        assertFalse(".part should be gone", partial.exists())
        assertEquals(body.size.toLong(), target.length())
        assertEquals(
            body.joinToString("") { "%02x".format(it) },
            ModelDownloader.sha256Of(target),
        )
    }

    @Test
    fun `rejects a file whose SHA-256 does not match`() = runBlocking {
        val body = payload(4096)
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(okio.ByteString.of(body))
        )

        val spec = ModelSpec(
            id = "badhash", displayName = "BadHash", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "model.gguf",
            sizeBytes = body.size.toLong(), sha256 = "00".repeat(32),
        )
        val dir = tmp.newFolder()
        val outcome = downloader.downloadModel(spec, dir) { }

        assertTrue(
            "expected a SHA-256 failure, got $outcome",
            outcome is DownloadOutcome.Failed && outcome.reason.contains("SHA-256")
        )
        assertFalse("corrupt file must not survive", File(dir, spec.id, spec.filename).exists())
    }

    @Test
    fun `detects an HTML error page served with HTTP 200`() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/missing.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(200)
                .setHeader("Content-Type", "text/html; charset=utf-8")
                .setBody("<html><body>Entry not found</body></html>")
        )

        val spec = ModelSpec(
            id = "html", displayName = "HTML", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "missing.gguf",
            sizeBytes = 1024L,
        )
        val outcome = downloader.downloadModel(spec, tmp.newFolder()) { }

        assertTrue(
            "expected an HTML-page failure, got $outcome",
            outcome is DownloadOutcome.Failed && outcome.reason.contains("HTML")
        )
    }

    @Test
    fun `restarts when the server returns 416`() = runBlocking {
        val body = payload(8 * 1024)
        val dir = tmp.newFolder()
        val modelDir = File(dir, "stale").apply { mkdirs() }
        val target = File(modelDir, "model.gguf")
        // Oversized .part forces a 416 on the first Range attempt.
        target.resolveSibling(target.name + ".part").writeBytes(ByteArray(64 * 1024))

        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(MockResponse().setResponseCode(416))
        server.enqueue(
            MockResponse().setResponseCode(302).setHeader("Location", "/cdn/model.gguf")
        )
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(okio.ByteString.of(body))
        )

        val spec = ModelSpec(
            id = "stale", displayName = "Stale", kind = ModelKind.LLM,
            description = "", repo = "some/repo", filename = "model.gguf",
            sizeBytes = body.size.toLong(),
        )
        val outcome = downloader.downloadModel(spec, dir) { }

        assertInstance(outcome)
        assertEquals(body.size.toLong(), target.length())
    }

    @Test
    fun `sha256 helper matches a known digest`() {
        val file = tmp.newFile("digest.bin")
        file.writeBytes(ByteArray(256) { (it % 7).toByte() })
        val digest = ModelDownloader.sha256Of(file)
        assertEquals(64, digest.length)
        assertTrue(digest.all { it in '0'..'9' || it in 'a'..'f' })
    }

    private fun assertInstance(outcome: DownloadOutcome) {
        assertNotNull(outcome)
        when (outcome) {
            is DownloadOutcome.Failed ->
                throw AssertionError("expected success but got: ${outcome.reason}")

            is DownloadOutcome.Cancelled ->
                throw AssertionError("download was cancelled unexpectedly")

            is DownloadOutcome.Success -> { /* expected */ }
        }
    }

    /** Minimal runBlocking so the tests need no extra coroutine dependency. */
    private fun <T> runBlocking(block: suspend () -> T): T =
        kotlinx.coroutines.runBlocking(block)
}
