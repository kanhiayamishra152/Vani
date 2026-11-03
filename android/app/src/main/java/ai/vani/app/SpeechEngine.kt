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
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
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
    private var ttsEngine = "phonon"
    private var tts: OfflineTts? = null
    private var systemTts: TextToSpeech? = null
    private var systemTtsReady = false
    private var ttsSpeed = 1.0f
    private var ttsSid = 0
    @Volatile private var ttsStop = false
    @Volatile private var audioTrack: AudioTrack? = null
    @Volatile private var currentUtterId: String? = null
    @Volatile private var systemSpeaking = false
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
    private var recognizer: OfflineRecognizer? = null
    private var systemRecognizer: SpeechRecognizer? = null
    @Volatile private var asrActive = false
    private var asrMode = "vad"
    private var asrEngine = "system"
    private var wasSpeech = false
    private val pttBuffer = ArrayList<FloatArray>()

    private fun ok(id: String, payload: String = "{}") = MainActivity.instance?.resolve(id, true, payload)
    private fun err(id: String, msg: String) =
        MainActivity.instance?.resolve(id, false, JSONObject().put("error", msg).toString())

    private fun ev(event: String, obj: JSONObject) = emit(event, obj.toString())

    /* ============================ TTS ============================ */

    fun configureTts(a: JSONObject, id: String) {
        val engine = a.optString("engine", "phonon")
        val dir = a.optString("dir", "")
        ttsSpeed = a.optDouble("speed", 1.0).toFloat()
        ttsSid = a.optInt("sid", 0)
        exec.submit {
            try {
                tts?.release(); tts = null
                ttsEngine = engine
                when (engine) {
                    "phonon" -> { /* JS-side formant synth */ }
                    "system" -> ensureSystemTts()
                    else -> {
                        if (dir.isNotEmpty() && File(dir).exists()) {
                            tts = buildTts(engine, File(dir))
                        }
                        if (tts == null) {
                            ensureSystemTts()
                            ev("voice.engineFallback", JSONObject().put("engine", engine))
                        }
                    }
                }
                ok(id)
            } catch (e: Exception) {
                Log.e(TAG, "tts configure", e)
                tts = null
                ensureSystemTts()
                ok(id)
            }
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
                    override fun onDone(utteranceId: String?) { finishSystemUtter(false) }
                    @Deprecated("deprecated") override fun onError(utteranceId: String?) { finishSystemUtter(false) }
                })
            }
        }
    }

    private fun finishSystemUtter(interrupted: Boolean) {
        systemSpeaking = false
        main.removeCallbacks(levelTicker)
        val uid = currentUtterId ?: return
        currentUtterId = null
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
                    val model = pick(dir, ".onnx", needles = arrayOf(".onnx"))
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
        stopTts()
        currentUtterId = utterId
        ttsStop = false
        ok(id)
        ev("tts.start", JSONObject().put("utterId", utterId))
        val engine = ttsEngine
        val neural = tts
        if (engine != "phonon" && neural != null) {
            exec.submit {
                var track: AudioTrack? = null
                var interrupted = false
                try {
                    val sr = neural.sampleRate()
                    track = AudioTrack.Builder()
                        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                        .setAudioFormat(AudioFormat.Builder().setSampleRate(sr).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                        .setBufferSizeInBytes(AudioTrack.getMinBufferSize(sr, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT) * 4)
                        .setTransferMode(AudioTrack.MODE_STREAM)
                        .build()
                    audioTrack = track
                    track.play()
                    neural.generateWithCallback(text = text, sid = ttsSid, speed = ttsSpeed) { samples ->
                        if (ttsStop) { interrupted = true; return@generateWithCallback 0 }
                        track.write(samples, 0, samples.size, AudioTrack.WRITE_BLOCKING)
                        var sum = 0.0
                        for (s in samples) sum += s * s
                        val rms = sqrt(sum / samples.size).toFloat()
                        val now = System.currentTimeMillis()
                        if (now - lastLevelEmit > 60) {
                            lastLevelEmit = now
                            emitLevel(utterId, (rms * 3.2f).coerceIn(0f, 1f))
                        }
                        1
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "neural tts", e)
                } finally {
                    try { track?.stop(); track?.release() } catch (_: Exception) {}
                    audioTrack = null
                    if (currentUtterId == utterId) {
                        currentUtterId = null
                        ev("tts.end", JSONObject().put("utterId", utterId).put("interrupted", (interrupted || ttsStop)))
                    }
                }
            }
        } else {
            // System TTS fallback (also covers "system" engine).
            main.post {
                ensureSystemTts()
                val t = systemTts
                if (t == null || !systemTtsReady) {
                    // Retry once after init.
                    main.postDelayed({
                        val t2 = systemTts
                        if (t2 != null && systemTtsReady && currentUtterId == utterId) {
                            t2.setSpeechRate(ttsSpeed)
                            t2.speak(text, TextToSpeech.QUEUE_FLUSH, null, utterId)
                        } else if (currentUtterId == utterId) {
                            currentUtterId = null
                            ev("tts.end", JSONObject().put("utterId", utterId).put("interrupted", false))
                        }
                    }, 700)
                } else {
                    t.setSpeechRate(ttsSpeed)
                    t.speak(text, TextToSpeech.QUEUE_FLUSH, null, utterId)
                }
            }
        }
    }

    private fun emitLevel(utterId: String, level: Float) {
        ev("tts.level", JSONObject().put("utterId", utterId).put("level", level.toDouble()))
    }

    /** Instant native barge-in: kills AudioTrack + system TTS on the spot. */
    fun stopTts() {
        ttsStop = true
        try { audioTrack?.stop() } catch (_: Exception) {}
        try { systemTts?.stop() } catch (_: Exception) {}
        if (systemSpeaking) finishSystemUtter(true)
        val uid = currentUtterId
        if (uid != null && ttsEngine != "system" && audioTrack == null && !systemSpeaking) {
            // Neural generation between chunks: mark interrupted; the worker
            // loop will emit tts.end when it observes ttsStop.
        }
    }

    /* ============================ ASR ============================ */

    fun startAsr(a: JSONObject, id: String) {
        val engine = a.optString("engine", "system")
        val mode = a.optString("mode", "vad")
        val dir = a.optString("dir", "")
        val language = a.optString("language", "en")
        val sensitivity = a.optDouble("sensitivity", 0.5).toFloat()
        exec.submit {
            try {
                releaseAsrInternal()
                asrEngine = engine
                asrMode = mode
                asrActive = true
                wasSpeech = false
                pttBuffer.clear()
                if (engine == "whisper") {
                    if (dir.isEmpty() || !File(dir).exists()) throw IllegalStateException("Whisper model not installed")
                    val d = File(dir)
                    val encoder = pick(d, "encoder")
                    val decoder = pick(d, "decoder")
                    val tokens = d.walkTopDown().firstOrNull { it.name.endsWith("tokens.txt") }?.absolutePath
                        ?: throw IllegalStateException("Whisper tokens missing")
                    if (encoder.isEmpty() || decoder.isEmpty()) throw IllegalStateException("Whisper ONNX files missing")
                    recognizer = OfflineRecognizer(
                        assetManager = null,
                        config = OfflineRecognizerConfig(
                            featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
                            modelConfig = OfflineModelConfig(
                                whisper = OfflineWhisperModelConfig(encoder = encoder, decoder = decoder, language = language, task = "transcribe"),
                                tokens = tokens,
                                numThreads = 2,
                                modelType = "whisper",
                            ),
                        ),
                    )
                    val threshold = (0.85f - sensitivity * 0.7f).coerceIn(0.1f, 0.9f)
                    vad = Vad(
                        assetManager = ctx.assets,
                        config = VadModelConfig(
                            sileroVadModelConfig = SileroVadModelConfig(
                                model = "vad/silero_vad.onnx",
                                threshold = threshold,
                                minSilenceDuration = 0.35f,
                                minSpeechDuration = 0.2f,
                                windowSize = 512,
                                maxSpeechDuration = 15.0f,
                            ),
                            sampleRate = 16000,
                            numThreads = 1,
                        ),
                    )
                } else {
                    startSystemRecognizer(mode, language)
                }
                ok(id)
            } catch (e: Exception) {
                Log.e(TAG, "asr start", e)
                asrActive = false
                err(id, e.message ?: "ASR failed to start")
            }
        }
    }

    private fun startSystemRecognizer(mode: String, language: String) {
        main.post {
            if (!asrActive) return@post
            if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
                ev("asr.error", JSONObject().put("error", "No speech recognizer on this device. Install Whisper for offline ears."))
                return@post
            }
            val r = SpeechRecognizer.createSpeechRecognizer(ctx)
            systemRecognizer = r
            r.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {}
                override fun onBeginningOfSpeech() {
                    bargeIn()
                    ev("asr.speechStart", JSONObject())
                }
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() { ev("asr.speechEnd", JSONObject()) }
                override fun onError(error: Int) {
                    if (!asrActive) return
                    if (asrMode == "vad") main.postDelayed({ if (asrActive && asrEngine == "system") listenSystem(language) }, 350)
                }
                override fun onResults(results: Bundle?) {
                    val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
                    if (text.isNotBlank()) ev("asr.final", JSONObject().put("text", text))
                    if (asrActive && asrMode == "vad") listenSystem(language)
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

    fun feed(pcmBase64: String) {
        if (!asrActive || asrEngine != "whisper") return
        val bytes = Base64.decode(pcmBase64, Base64.DEFAULT)
        val samples = FloatArray(bytes.size / 2)
        for (i in samples.indices) {
            val lo = bytes[i * 2].toInt() and 0xff
            val hi = bytes[i * 2 + 1].toInt()
            samples[i] = ((hi shl 8) or lo).toShort() / 32768.0f
        }
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
                Log.w(TAG, "feed", e)
            }
        }
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
        try {
            val stream = r.createStream()
            stream.acceptWaveform(samples, 16000)
            r.decode(stream)
            val result = r.getResult(stream)
            stream.release()
            val text = result.text.trim()
            if (text.isNotEmpty()) ev("asr.final", JSONObject().put("text", text))
        } catch (e: Exception) {
            Log.w(TAG, "decode", e)
        }
    }

    /** Native-side interruption: stop any ongoing speech immediately. */
    private fun bargeIn() {
        stopTts()
    }

    fun stopAsr() {
        asrActive = false
        exec.submit { releaseAsrInternal() }
    }

    private fun releaseAsrInternal() {
        try { vad?.release() } catch (_: Exception) {}
        vad = null
        try { recognizer?.release() } catch (_: Exception) {}
        recognizer = null
        pttBuffer.clear()
        main.post {
            try { systemRecognizer?.destroy() } catch (_: Exception) {}
            systemRecognizer = null
        }
    }

    fun release() {
        asrActive = false
        stopTts()
        exec.submit {
            releaseAsrInternal()
            try { tts?.release() } catch (_: Exception) {}
            tts = null
        }
        main.post { try { systemTts?.shutdown() } catch (_: Exception) {} ; systemTts = null }
        exec.shutdown()
    }
}
