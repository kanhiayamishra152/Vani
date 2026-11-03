package ai.vani.app

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OfflineMoonshineModelConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import com.k2fsa.sherpa.onnx.OfflineTransducerModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.sqrt

/**
 * Vani AI — on-device speech: silero VAD + Whisper ASR + neural TTS
 * (Pocket TTS / Piper VITS / Kokoro) on the bundled sherpa-onnx runtime,
 * with Android system speech services as fallbacks.
 *
 * Barge-in is handled NATIVELY: the moment VAD detects speech the AudioTrack
 * is stopped on the spot (<50 ms), before any JS round-trip.
 */
class SpeechEngine(
    private val ctx: Context,
    private val emit: (String, String) -> Unit,
) {
    companion object { private const val TAG = "VaniSpeech" }

    private val exec = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    // ---- TTS state ----
    @Volatile private var ttsEngine = "phonon"
    private var ttsParadee = false
    @Volatile private var tts: OfflineTts? = null
    private var systemTts: TextToSpeech? = null
    private var systemTtsReady = false
    private var ttsSpeed = 1.0f
    private var ttsSid = 0
    @Volatile private var ttsLoading = false
    @Volatile private var ttsModelPath: String? = null
    @Volatile private var ttsModelId: String? = null
    @Volatile private var ttsModelName: String? = null
    @Volatile private var currentUtterId: String? = null
    @Volatile private var systemSpeaking = false
    @Volatile private var activeSpeech: SpeechJob? = null

    private class SpeechJob(val utterId: String) {
        @Volatile var cancelled: Boolean = false
        @Volatile var track: AudioTrack? = null
    }
    private var lastLevelEmit = 0L
    private val levelTicker = object : Runnable {
        override fun run() {
            if (!systemSpeaking) return
            emitLevel(currentUtterId ?: return, 0.35f + Math.random().toFloat() * 0.3f)
            main.postDelayed(this, 90)
        }
    }

    // ---- ASR state ----
    private var vad: Vad? = null
    @Volatile private var recognizer: OfflineRecognizer? = null
    private var systemRecognizer: SpeechRecognizer? = null
    @Volatile private var asrActive = false
    private var asrMode = "vad"
    @Volatile private var asrEngine = "system"
    @Volatile private var asrOnce = false
    @Volatile private var asrErrorRetries = 0
    @Volatile private var asrLoading = false
    @Volatile private var asrModelPath: String? = null
    @Volatile private var asrModelId: String? = null
    @Volatile private var asrModelName: String? = null
    private var asrLoadedLanguage = ""
    private var wasSpeech = false
    private val pttBuffer = ArrayList<FloatArray>()
    private var audioBridge: VaniAudioBridge? = null

    private fun ok(id: String, payload: String = "{}") = MainActivity.instance?.resolve(id, true, payload)
    private fun err(id: String, msg: String) =
        MainActivity.instance?.resolve(id, false, JSONObject().put("error", msg).toString())

    private fun ev(event: String, obj: JSONObject) = emit(event, obj.toString())

    private fun ttsStatus(): JSONObject = JSONObject().apply {
        put("state", if (ttsLoading) "loading" else if (tts != null) "ready" else "idle")
        put("path", ttsModelPath ?: "")
        put("modelId", ttsModelId ?: "")
        put("name", ttsModelName ?: "")
        put("engine", ttsEngine)
        put("speaking", activeSpeech != null || systemSpeaking)
    }

    private fun asrStatus(): JSONObject = JSONObject().apply {
        put("state", if (asrLoading) "loading" else if (recognizer != null) "ready" else "idle")
        put("path", asrModelPath ?: "")
        put("modelId", asrModelId ?: "")
        put("name", asrModelName ?: "")
        put("engine", if (recognizer != null) asrEngine else "")
        put("capturing", asrActive)
    }

    fun status(): JSONObject = JSONObject().put("tts", ttsStatus()).put("asr", asrStatus())
    private fun emitTtsStatus() = ev("tts.status", ttsStatus())
    private fun emitAsrStatus() = ev("asr.status", asrStatus())

    /* ============================ TTS ============================ */

    fun configureTts(a: JSONObject, id: String) {
        val engine = a.optString("engine", "phonon")
        val dir = a.optString("dir", "")
        val speed = a.optDouble("speed", 1.0).toFloat()
        val sid = a.optInt("sid", 0)
        val modelId = a.optString("modelId", "")
        val modelName = a.optString("name", modelId.ifEmpty { File(dir).name })
        val paradee = a.optBoolean("paradee", false) || engine == "paradee" ||
            dir.contains("phonon-ultra") || dir.contains("paradee")
        ttsLoading = true
        emitTtsStatus()
        exec.submit {
            try {
                stopTts()
                val normEngine = when (engine) {
                    "phonon" -> "vits"
                    "paradee" -> "kokoro"
                    else -> engine
                }
                if (normEngine == "system") {
                    releaseTtsModelInternal()
                    ttsEngine = "system"
                    ensureSystemTts()
                } else {
                    if (dir.isEmpty() || !File(dir).exists()) {
                        throw IllegalStateException("Selected voice is not installed")
                    }
                    // Speaker/rate changes reuse the resident native model. A real
                    // model switch releases the old allocation before constructing
                    // the replacement, so two standalone TTS instances never coexist.
                    if (tts == null || ttsEngine != normEngine || ttsModelPath != dir) {
                        releaseTtsModelInternal()
                        tts = buildTts(normEngine, File(dir))
                            ?: throw IllegalStateException("Selected voice files are incomplete or unsupported")
                    }
                    ttsEngine = normEngine
                    ttsModelPath = dir
                    ttsModelId = modelId
                    ttsModelName = modelName
                }
                ttsSpeed = speed
                ttsSid = sid
                ttsParadee = paradee
                ok(id)
            } catch (e: Throwable) {
                Log.e(TAG, "tts configure", e)
                releaseTtsModelInternal()
                err(id, e.message ?: "Voice configuration failed")
            } finally {
                ttsLoading = false
                emitTtsStatus()
            }
        }
    }

    private fun releaseTtsModelInternal() {
        try { tts?.release() } catch (e: Throwable) { Log.w(TAG, "tts release", e) }
        tts = null
        ttsModelPath = null
        ttsModelId = null
        ttsModelName = null
    }

    fun unloadTts(id: String? = null) {
        stopTts()
        exec.submit {
            releaseTtsModelInternal()
            ttsLoading = false
            if (id != null) ok(id, ttsStatus().toString())
            emitTtsStatus()
        }
    }

    private fun ensureSystemTts() {
        if (systemTts != null) return
        main.post {
            systemTts = TextToSpeech(ctx) { status ->
                systemTtsReady = status == TextToSpeech.SUCCESS
                systemTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) {
                        systemSpeaking = true
                        main.post(levelTicker)
                    }
                    override fun onDone(utteranceId: String?) { finishSystemUtter(false, utteranceId) }
                    @Deprecated("deprecated") override fun onError(utteranceId: String?) {
                        val uid = currentUtterId
                        if (uid != null && (utteranceId == null || uid == utteranceId)) {
                            ev("tts.error", JSONObject().put("utterId", uid).put("error", "System speech playback failed"))
                        }
                        finishSystemUtter(false, utteranceId)
                    }
                })
            }
        }
    }

    private fun finishSystemUtter(interrupted: Boolean, expectedId: String? = null) {
        systemSpeaking = false
        main.removeCallbacks(levelTicker)
        val uid = currentUtterId ?: return
        if (expectedId != null && uid != expectedId) return
        currentUtterId = null
        activeSpeech = null
        ev("tts.end", JSONObject().put("utterId", uid).put("interrupted", interrupted))
    }

    private fun pick(dir: File, vararg needles: String, ext: String = ".onnx", preferInt8: Boolean = true): String {
        val files = dir.walkTopDown().filter { it.isFile && it.name.endsWith(ext) }.toList()
        fun match(f: File) = needles.all { f.name.lowercase().contains(it) }
        val candidates = files.filter(::match)
        if (candidates.isEmpty()) return ""
        val int8 = candidates.filter { it.name.contains("int8") }
        val chosen = if (preferInt8 && int8.isNotEmpty()) int8.first() else candidates.first()
        return chosen.absolutePath
    }

    private fun buildTts(engine: String, dir: File): OfflineTts? {
        return try {
            val modelConfig = when (engine) {
                "vits" -> {
                    val model = pick(dir, ".onnx")
                    val tokens = File(dir, "tokens.txt")
                    if (model.isEmpty() || !tokens.exists()) return null
                    OfflineTtsModelConfig(
                        vits = OfflineTtsVitsModelConfig(model = model, tokens = tokens.absolutePath),
                        numThreads = 2,
                    )
                }
                "kokoro" -> {
                    val model = pick(dir, "model", preferInt8 = true)
                    val voices = dir.walkTopDown().firstOrNull { it.name == "voices.bin" }?.absolutePath ?: return null
                    val tokens = dir.walkTopDown().firstOrNull { it.name == "tokens.txt" }?.absolutePath ?: return null
                    val lexicon = dir.walkTopDown().firstOrNull { it.name.startsWith("lexicon-us-en") }?.absolutePath
                        ?: dir.walkTopDown().firstOrNull { it.name.startsWith("lexicon") }?.absolutePath ?: ""
                    OfflineTtsModelConfig(
                        kokoro = OfflineTtsKokoroModelConfig(model = model, voices = voices, tokens = tokens, lexicon = lexicon, lang = "en"),
                        numThreads = 2,
                    )
                }
                "kitten" -> {
                    // Optional legacy Kitten pack support. Phonon-UltraLight
                    // itself uses the Kokoro-compatible Paradee branch above.
                    val model = pick(dir, "model", preferInt8 = true).ifEmpty { pick(dir, ".onnx") }
                    val voices = dir.walkTopDown().firstOrNull { it.name == "voices.bin" }?.absolutePath ?: return null
                    val tokens = dir.walkTopDown().firstOrNull { it.name == "tokens.txt" }?.absolutePath ?: return null
                    val lexicon = dir.walkTopDown().firstOrNull { it.name.startsWith("lexicon") && it.name.endsWith(".txt") }?.absolutePath ?: ""
                    if (model.isEmpty()) return null
                    OfflineTtsModelConfig(
                        kitten = OfflineTtsKittenModelConfig(model = model, voices = voices, tokens = tokens, lexicon = lexicon),
                        numThreads = 2,
                    )
                }
                "pocket" -> {
                    val lmFlow = pick(dir, "flow")
                    val lmMain = pick(dir, "main")
                    val encoder = pick(dir, "encoder")
                    val decoder = pick(dir, "decoder")
                    val conditioner = pick(dir, "conditioner")
                    val vocab = dir.walkTopDown().firstOrNull { it.name.contains("vocab") && it.name.endsWith(".json") }?.absolutePath ?: ""
                    val scores = dir.walkTopDown().firstOrNull { it.name.contains("score") && it.name.endsWith(".json") }?.absolutePath ?: ""
                    if (lmFlow.isEmpty() || lmMain.isEmpty()) return null
                    OfflineTtsModelConfig(
                        pocket = OfflineTtsPocketModelConfig(
                            lmFlow = lmFlow, lmMain = lmMain, encoder = encoder, decoder = decoder,
                            textConditioner = conditioner, vocabJson = vocab, tokenScoresJson = scores,
                        ),
                        numThreads = 2,
                    )
                }
                else -> return null
            }
            OfflineTts(assetManager = null, config = OfflineTtsConfig(model = modelConfig, maxNumSentences = 1))
        } catch (e: Exception) {
            Log.e(TAG, "buildTts($engine)", e)
            null
        }
    }

    fun speak(a: JSONObject, id: String) {
        val utterId = a.optString("utterId", "u0")
        val text = a.optString("text", "")
        if (text.isBlank()) { err(id, "empty text"); return }
        val sid = if (a.has("sid")) a.optInt("sid", ttsSid) else ttsSid
        stopTts()
        val job = SpeechJob(utterId)
        activeSpeech = job
        currentUtterId = utterId
        ok(id)
        ev("tts.start", JSONObject().put("utterId", utterId))
        val engine = ttsEngine
        val neural = tts
        if (engine != "system" && neural != null) {
            exec.submit {
                var output: AudioTrack? = null
                var interrupted = false
                var framesWritten = 0L
                var sampleRate = 24000
                try {
                    sampleRate = neural.sampleRate()
                    val minBuffer = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
                    val track = AudioTrack.Builder()
                        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(maxOf(minBuffer, 4096) * 2)
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
                    output = track
                    job.track = track
                    track.play()
                    fun onSamples(samples: FloatArray): Int {
                        if (job.cancelled) { interrupted = true; return 0 }
                        var offset = 0
                        while (offset < samples.size && !job.cancelled) {
                            val written = track.write(samples, offset, samples.size - offset, AudioTrack.WRITE_BLOCKING)
                            if (written < 0) throw IllegalStateException("AudioTrack write failed: $written")
                            if (written == 0) return 0
                            offset += written
                        }
                        if (job.cancelled) { interrupted = true; return 0 }
                        framesWritten += samples.size
                        if (samples.isNotEmpty()) {
                            var sum = 0.0
                            for (sample in samples) sum += sample * sample
                            val rms = sqrt(sum / samples.size).toFloat()
                            val now = System.currentTimeMillis()
                            if (now - lastLevelEmit > 60) {
                                lastLevelEmit = now
                                emitLevel(utterId, (rms * 3.2f).coerceIn(0f, 1f))
                            }
                        }
                        return 1
                    }
                    if (ttsParadee) {
                        val config = ParadeeFrontend.config(ctx, text, sid, ttsSpeed)
                        neural.generateWithConfigAndCallback("", config) { samples -> onSamples(samples) }
                    } else {
                        neural.generateWithCallback(text = text, sid = sid, speed = ttsSpeed) { samples -> onSamples(samples) }
                    }
                } catch (e: Throwable) {
                    if (!job.cancelled) {
                        Log.e(TAG, "neural tts", e)
                        ev("tts.error", JSONObject().put("utterId", utterId).put("error", e.message ?: "Speech playback failed"))
                    }
                    interrupted = interrupted || job.cancelled
                } finally {
                    // Let already-buffered audio finish, but never hold a worker
                    // indefinitely if a device reports a stuck playback head.
                    val track = output
                    if (track != null && !job.cancelled) {
                        val drainMs = (framesWritten * 1000L / sampleRate + 350L).coerceIn(250L, 12000L)
                        val deadline = SystemClock.elapsedRealtime() + drainMs
                        while (!job.cancelled && track.playState == AudioTrack.PLAYSTATE_PLAYING &&
                            track.playbackHeadPosition.toLong() < framesWritten && SystemClock.elapsedRealtime() < deadline) {
                            SystemClock.sleep(10)
                        }
                    }
                    try { track?.stop(); track?.release() } catch (_: Exception) {}
                    job.track = null
                    if (activeSpeech === job) {
                        activeSpeech = null
                        if (currentUtterId == utterId) currentUtterId = null
                        ev("tts.end", JSONObject().put("utterId", utterId).put("interrupted", interrupted || job.cancelled))
                    }
                }
            }
        } else if (engine == "system") {
            main.post {
                ensureSystemTts()
                val t = systemTts
                if (t == null || !systemTtsReady) {
                    main.postDelayed({
                        val t2 = systemTts
                        if (t2 != null && systemTtsReady && currentUtterId == utterId) {
                            t2.setSpeechRate(ttsSpeed)
                            t2.speak(text, TextToSpeech.QUEUE_FLUSH, null, utterId)
                        } else if (currentUtterId == utterId) {
                            currentUtterId = null
                            ev("tts.error", JSONObject().put("utterId", utterId).put("error", "System speech service unavailable"))
                        }
                    }, 700)
                } else {
                    t.setSpeechRate(ttsSpeed)
                    t.speak(text, TextToSpeech.QUEUE_FLUSH, null, utterId)
                }
            }
        } else {
            activeSpeech = null
            if (currentUtterId == utterId) currentUtterId = null
            ev("tts.error", JSONObject().put("utterId", utterId).put("error", "Selected voice is not configured"))
        }
    }

    private fun emitLevel(utterId: String, level: Float) {
        ev("tts.level", JSONObject().put("utterId", utterId).put("level", level.toDouble()))
    }

    /** Instant native barge-in: kills only the active utterance's track. */
    fun stopTts() {
        val job = activeSpeech
        job?.cancelled = true
        try { job?.track?.stop() } catch (_: Exception) {}
        try { systemTts?.stop() } catch (_: Exception) {}
        if (systemSpeaking) finishSystemUtter(true)
    }

    /* ============================ ASR ============================ */

    private fun isOfflineAsr(engine: String) =
        engine == "whisper" || engine == "moonshine" || engine == "sensevoice" || engine == "zipformer"

    /** Build an offline recognizer for any supported engine from a model directory. */
    private fun buildOfflineRecognizer(engine: String, d: File, language: String): OfflineRecognizer? {
        val tokens = d.walkTopDown().firstOrNull { it.isFile && it.name.endsWith("tokens.txt") }?.absolutePath
            ?: return null
        fun find(vararg needles: String, exclude: String = ""): String =
            d.walkTopDown().firstOrNull { f ->
                f.isFile && f.name.endsWith(".onnx") &&
                    needles.all { f.name.lowercase().contains(it) } &&
                    (exclude.isEmpty() || !f.name.lowercase().contains(exclude))
            }?.absolutePath ?: ""
        val modelConfig = when (engine) {
            "whisper" -> {
                val encoder = find("encoder"); val decoder = find("decoder")
                if (encoder.isEmpty() || decoder.isEmpty()) return null
                OfflineModelConfig(
                    whisper = OfflineWhisperModelConfig(encoder = encoder, decoder = decoder, language = language, task = "transcribe"),
                    tokens = tokens, numThreads = 2, modelType = "whisper",
                )
            }
            "moonshine" -> {
                val pre = find("preprocess")
                val encoder = find("encode", exclude = "decode")
                val uncached = find("uncached")
                val cached = find("cached", exclude = "uncached")
                val merged = find("merged")
                if (encoder.isEmpty() || (uncached.isEmpty() && merged.isEmpty())) return null
                OfflineModelConfig(
                    moonshine = OfflineMoonshineModelConfig(
                        preprocessor = pre, encoder = encoder,
                        uncachedDecoder = uncached, cachedDecoder = cached, mergedDecoder = merged,
                    ),
                    tokens = tokens, numThreads = 2,
                )
            }
            "sensevoice" -> {
                val model = find("model").ifEmpty { find(".onnx") }
                if (model.isEmpty()) return null
                OfflineModelConfig(
                    senseVoice = OfflineSenseVoiceModelConfig(model = model, language = language, useInverseTextNormalization = true),
                    tokens = tokens, numThreads = 2,
                )
            }
            "zipformer" -> {
                val encoder = find("encoder"); val decoder = find("decoder"); val joiner = find("joiner")
                if (encoder.isEmpty() || decoder.isEmpty() || joiner.isEmpty()) return null
                OfflineModelConfig(
                    transducer = OfflineTransducerModelConfig(encoder = encoder, decoder = decoder, joiner = joiner),
                    tokens = tokens, numThreads = 2,
                )
            }
            else -> return null
        }
        return OfflineRecognizer(
            assetManager = null,
            config = OfflineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
                modelConfig = modelConfig,
            ),
        )
    }

    /** Load one offline ASR model without opening the microphone. */
    fun loadAsr(a: JSONObject, id: String) {
        val engine = a.optString("engine", "whisper")
        val dir = a.optString("dir", "")
        val language = a.optString("language", "en")
        val modelId = a.optString("modelId", "")
        val modelName = a.optString("name", modelId.ifEmpty { File(dir).name })
        asrActive = false
        asrLoading = true
        emitAsrStatus()
        exec.submit {
            try {
                releaseCaptureInternal()
                installOfflineAsr(engine, dir, language, modelId, modelName)
                asrLoading = false
                ok(id, asrStatus().toString())
            } catch (e: Throwable) {
                Log.e(TAG, "asr load", e)
                releaseAsrModelInternal()
                err(id, e.message ?: "ASR model failed to load")
            } finally {
                asrLoading = false
                emitAsrStatus()
            }
        }
    }

    /** Called only on the serialized speech executor. */
    private fun installOfflineAsr(engine: String, dir: String, language: String, modelId: String, modelName: String) {
        if (!isOfflineAsr(engine)) throw IllegalStateException("Unsupported offline ASR engine: $engine")
        if (dir.isEmpty() || !File(dir).exists()) throw IllegalStateException("$engine model is not installed")
        releaseAsrModelInternal()
        recognizer = buildOfflineRecognizer(engine, File(dir), language)
            ?: throw IllegalStateException("$engine ONNX files are incomplete or unsupported")
        asrEngine = engine
        asrModelPath = dir
        asrModelId = modelId
        asrModelName = modelName
        asrLoadedLanguage = language
    }

    fun startAsr(a: JSONObject, id: String) {
        val engine = a.optString("engine", "system")
        val mode = a.optString("mode", "vad")
        val dir = a.optString("dir", "")
        val language = a.optString("language", "en")
        val sensitivity = a.optDouble("sensitivity", 0.5).toFloat()
        val once = a.optBoolean("once", false)
        val modelId = a.optString("modelId", "")
        val modelName = a.optString("name", modelId.ifEmpty { File(dir).name })
        exec.submit {
            try {
                // Stop only the old capture session. A matching recognizer stays
                // resident across dictation/Live starts and stops.
                releaseCaptureInternal()
                asrMode = mode
                asrOnce = once
                asrErrorRetries = 0
                asrActive = true
                wasSpeech = false
                pttBuffer.clear()
                if (isOfflineAsr(engine)) {
                    if (recognizer == null || asrEngine != engine || asrModelPath != dir || asrLoadedLanguage != language) {
                        asrLoading = true
                        emitAsrStatus()
                        try {
                            installOfflineAsr(engine, dir, language, modelId, modelName)
                        } catch (loadError: Throwable) {
                            // Preserve the system-ASR fallback for a broken model,
                            // but never disguise microphone capture failures as success.
                            releaseAsrModelInternal()
                            asrEngine = "system"
                            startSystemRecognizer(mode, language)
                            ev("voice.engineFallback", JSONObject().put("engine", engine).put("reason", loadError.message ?: "load failed"))
                            ok(id)
                            return@submit
                        } finally {
                            asrLoading = false
                            emitAsrStatus()
                        }
                    }
                    asrEngine = engine
                    val threshold = (0.85f - sensitivity * 0.7f).coerceIn(0.1f, 0.9f)
                    vad = Vad(
                        assetManager = ctx.assets,
                        config = VadModelConfig(
                            sileroVadModelConfig = SileroVadModelConfig(
                                model = "vad/silero_vad.onnx",
                                threshold = threshold,
                                minSilenceDuration = 0.7f,
                                minSpeechDuration = 0.2f,
                                windowSize = 512,
                                maxSpeechDuration = 5.0f,
                            ),
                            sampleRate = 16000,
                            numThreads = 1,
                        ),
                    )
                    if (!startNativeCapture()) throw IllegalStateException("Microphone unavailable — grant mic permission and close other recorders, then tap again")
                } else {
                    asrEngine = "system"
                    startSystemRecognizer(mode, language)
                }
                ok(id)
            } catch (e: Throwable) {
                Log.e(TAG, "asr start", e)
                asrActive = false
                releaseCaptureInternal()
                err(id, e.message ?: "ASR failed to start")
            } finally {
                asrLoading = false
                emitAsrStatus()
            }
        }
    }

    private fun startSystemRecognizer(mode: String, language: String) {
        main.post {
            // Never two mic consumers: the system recognizer owns the mic alone.
            try { audioBridge?.stop() } catch (_: Exception) {}
            audioBridge = null
            if (!asrActive) return@post
            if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
                ev("asr.error", JSONObject().put("error", "No speech recognizer on this device. Install Whisper for offline ears."))
                return@post
            }
            val r = SpeechRecognizer.createSpeechRecognizer(ctx)
            systemRecognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) { asrErrorRetries = 0 }
                override fun onBeginningOfSpeech() {
                    bargeIn()
                    ev("asr.speechStart", JSONObject())
                }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { ev("asr.speechEnd", JSONObject()) }
                override fun onError(error: Int) {
                    if (!asrActive) return
                    if (asrOnce) {
                        asrActive = false
                        ev("asr.error", JSONObject().put("error", "Speech recognizer error: $error"))
                        return
                    }
                    if (asrMode == "vad") {
                        asrErrorRetries++
                        if (asrErrorRetries > 2) {
                            asrActive = false
                            ev("asr.error", JSONObject().put("error", "Speech recognizer stopped after repeated errors"))
                        } else main.postDelayed({ if (asrActive && asrEngine == "system") listenSystem(language) }, 350)
                    }
                }
                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    if (text.isNotBlank()) ev("asr.final", JSONObject().put("text", text))
                    if (asrOnce) { asrActive = false; stopAsr() }
                    else if (asrActive && asrMode == "vad") listenSystem(language)
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    if (text.isNotBlank()) ev("asr.partial", JSONObject().put("text", text))
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })
            listenSystem(language)
        }
    }

    private fun listenSystem(language: String) {
        val r = systemRecognizer ?: return
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            if (android.os.Build.VERSION.SDK_INT >= 33) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        }
        try { r.startListening(intent) } catch (e: Exception) { Log.w(TAG, "system listen", e) }
    }

    /** Native PCM path: VaniAudioBridge feeds 16 kHz mono floats directly (no
     *  getUserMedia, no base64 JS round-trip). This is the ONLY mic consumer. */
    fun feedSamples(samples: FloatArray) {
        if (!asrActive || !isOfflineAsr(asrEngine)) return
        exec.submit {
            if (!asrActive) return@submit
            try {
                if (asrMode == "ptt") {
                    pttBuffer.add(samples)
                    return@submit
                }
                val v = vad ?: return@submit
                v.acceptWaveform(samples)
                val speaking = v.isSpeechDetected()
                if (speaking && !wasSpeech) {
                    wasSpeech = true
                    bargeIn()
                    ev("asr.speechStart", JSONObject())
                } else if (!speaking && wasSpeech) {
                    wasSpeech = false
                }
                while (!v.empty()) {
                    val seg = v.front()
                    v.pop()
                    ev("asr.speechEnd", JSONObject())
                    decodeSegment(seg.samples)
                }
            } catch (e: Exception) {
                Log.w(TAG, "feedSamples", e)
            }
        }
    }

    /** Legacy base64 path (web preview / compatibility). Decodes then feeds. */
    fun feed(pcmBase64: String) {
        if (!asrActive || !isOfflineAsr(asrEngine)) return
        val bytes = Base64.decode(pcmBase64, Base64.DEFAULT)
        val samples = FloatArray(bytes.size / 2)
        for (i in samples.indices) {
            val lo = bytes[i * 2].toInt() and 0xff
            val hi = bytes[i * 2 + 1].toInt()
            samples[i] = ((hi shl 8) or lo).toShort() / 32768.0f
        }
        feedSamples(samples)
    }

    /** Start the single native mic consumer and report the actual AudioRecord
     * result to the background ASR executor. Never blocks the Android UI thread. */
    private fun startNativeCapture(): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return startNativeCaptureOnMain()
        val latch = CountDownLatch(1)
        var started = false
        main.post {
            try { started = startNativeCaptureOnMain() }
            catch (e: Throwable) { Log.e(TAG, "native capture", e); started = false }
            finally { latch.countDown() }
        }
        return try {
            if (!latch.await(6, TimeUnit.SECONDS)) false else started
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
    }

    private fun startNativeCaptureOnMain(): Boolean {
        try { audioBridge?.stop() } catch (_: Exception) {}
        audioBridge = null
        val activity = MainActivity.instance ?: return false
        val ab = VaniAudioBridge(activity) { samples, len ->
            // Copy: the capture thread reuses its buffer; ASR runs async.
            feedSamples(samples.copyOf(len))
        }
        if (!ab.start()) return false
        audioBridge = ab
        return true
    }

    fun pttRelease() {
        if (asrEngine == "system") {
            main.post { try { systemRecognizer?.stopListening() } catch (_: Exception) {} }
            return
        }
        exec.submit {
            try {
                val total = pttBuffer.sumOf { it.size }
                if (total < 1600) { pttBuffer.clear(); return@submit }
                val all = FloatArray(total)
                var off = 0
                for (chunk in pttBuffer) { System.arraycopy(chunk, 0, all, off, chunk.size); off += chunk.size }
                pttBuffer.clear()
                decodeSegment(all)
            } catch (e: Exception) {
                Log.w(TAG, "ptt release", e)
            }
        }
    }

    private fun decodeSegment(samples: FloatArray) {
        val r = recognizer ?: return
        if (samples.size < 4800) return // <0.3 s
        val stream = try { r.createStream() } catch (e: Exception) {
            Log.w(TAG, "create ASR stream", e)
            return
        }
        try {
            stream.acceptWaveform(samples, 16000)
            r.decode(stream)
            val result = r.getResult(stream)
            val text = result.text.trim()
            if (text.isNotEmpty()) {
                ev("asr.final", JSONObject().put("text", text))
                if (asrOnce) { asrActive = false; stopAsr() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "decode", e)
            ev("asr.error", JSONObject().put("error", "Offline speech decoding failed: ${e.message ?: "native error"}"))
        } finally {
            try { stream.release() } catch (_: Exception) {}
        }
    }

    /** Native-side interruption: stop any ongoing speech immediately. */
    private fun bargeIn() {
        stopTts()
    }

    /** Stop only capture. The selected offline recognizer remains in RAM until
     * the user explicitly chooses Unload (or Omni isolation requires it). */
    fun stopAsr() {
        asrActive = false
        asrOnce = false
        asrErrorRetries = 0
        exec.submit {
            releaseCaptureInternal()
            emitAsrStatus()
        }
    }

    fun unloadAsr(id: String? = null) {
        asrActive = false
        asrOnce = false
        asrErrorRetries = 0
        exec.submit {
            releaseCaptureInternal()
            releaseAsrModelInternal()
            asrLoading = false
            if (id != null) ok(id, asrStatus().toString())
            emitAsrStatus()
        }
    }

    private fun releaseCaptureInternal() {
        try { audioBridge?.stop() } catch (_: Exception) {}
        audioBridge = null
        try { vad?.release() } catch (_: Exception) {}
        vad = null
        pttBuffer.clear()
        wasSpeech = false
        main.post {
            try { systemRecognizer?.destroy() } catch (_: Exception) {}
            systemRecognizer = null
        }
    }

    private fun releaseAsrModelInternal() {
        try { recognizer?.release() } catch (e: Throwable) { Log.w(TAG, "asr release", e) }
        recognizer = null
        asrModelPath = null
        asrModelId = null
        asrModelName = null
        asrLoadedLanguage = ""
    }

    /** Synchronous cross-engine barrier used only before Omni allocation. */
    fun unloadAllBlocking(): Boolean {
        stopTts()
        asrActive = false
        asrOnce = false
        val task = exec.submit {
            releaseCaptureInternal()
            releaseTtsModelInternal()
            releaseAsrModelInternal()
            ttsLoading = false
            asrLoading = false
        }
        return try {
            task.get(20, TimeUnit.SECONDS)
            // System speech objects are not downloadable model instances, but
            // their service bindings still own resources. Tear them down too
            // and wait for the main-thread cleanup before Omni allocates.
            val mainCleanup = CountDownLatch(1)
            main.post {
                try {
                    try { systemRecognizer?.destroy() } catch (_: Exception) {}
                    systemRecognizer = null
                    try { systemTts?.shutdown() } catch (_: Exception) {}
                    systemTts = null
                    systemTtsReady = false
                } finally { mainCleanup.countDown() }
            }
            if (!mainCleanup.await(5, TimeUnit.SECONDS)) return false
            emitTtsStatus()
            emitAsrStatus()
            true
        } catch (e: Throwable) {
            Log.e(TAG, "unload all for Omni", e)
            if (e is InterruptedException) Thread.currentThread().interrupt()
            false
        }
    }

    fun release() {
        asrActive = false
        stopTts()
        exec.submit {
            releaseCaptureInternal()
            releaseAsrModelInternal()
            releaseTtsModelInternal()
        }
        main.post { try { systemTts?.shutdown() } catch (_: Exception) {} ; systemTts = null }
        exec.shutdown()
    }
}
