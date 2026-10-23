package ai.vani.voice

import ai.vani.engine.LlamaEngine
import ai.vani.engine.SherpaSttEngine
import ai.vani.engine.TtsEngine
import ai.vani.engine.VadEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.AudioTrack

/**
 * Splits a stream of LLM tokens into sentence-sized chunks so TTS can start on the first
 * sentence while the model is still producing the rest. This overlap is what makes the
 * assistant feel conversational instead of serial.
 */
class SentenceSplitter(
    private val onSentence: suspend (String) -> Unit,
) {
    private val buffer = StringBuilder()

    suspend fun accept(token: String) {
        buffer.append(token)
        // Emit on any terminator, or when the buffer grows long enough that waiting for a
        // full stop would cost more latency than it saves.
        val text = buffer.toString()
        val end = text.indexOfLastChar { it == '.' || it == '!' || it == '?' || it == '\n' }
        if (end >= 0 && end >= text.length - 4) {
            val sentence = text.substring(0, end + 1).trim()
            buffer.clear()
            buffer.append(text.substring(end + 1))
            if (sentence.isNotEmpty()) onSentence(sentence)
        } else if (buffer.length > MAX_BUFFER_CHARS) {
            val cut = buffer.lastIndexOf(' ')
            val sentence = if (cut > 0) buffer.substring(0, cut + 1).trim() else buffer.toString().trim()
            buffer.clear()
            if (sentence.isNotEmpty()) onSentence(sentence)
        }
    }

    suspend fun flush() {
        val rest = buffer.toString().trim()
        buffer.clear()
        if (rest.isNotEmpty()) onSentence(rest)
    }

    companion object {
        private const val MAX_BUFFER_CHARS = 96
    }
}

/**
 * Plays TTS buffers on an [AudioTrack].
 *
 * [stopImmediately] is the barge-in path: `AudioTrack.stop()` releases the buffer in one
 * call, which is what keeps the audio cut-off well under the 200 ms budget. Calling
 * `AudioTrack.flush()` as well guarantees no queued sample survives into the next utterance.
 */
class AudioPlayer(private val sampleRate: Int) {
    private var track: AudioTrack? = null

    val isPlaying: Boolean get() = track?.playState == AudioTrack.PLAYSTATE_PLAYING

    @Synchronized
    fun play(samples: FloatArray) {
        stopImmediately()
        if (samples.isEmpty()) return
        val trackBuilder = AudioTrack.Builder()
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(samples.size * 4)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track = trackBuilder

        // Float PCM in [-1, 1] goes straight in; no conversion pass needed.
        trackBuilder.write(samples, 0, samples.size)
        trackBuilder.play()
    }

    @Synchronized
    fun stopImmediately() {
        val t = track
        track = null
        if (t == null) return
        try {
            if (t.playState == AudioTrack.PLAYSTATE_PLAYING) t.stop()
            t.flush()
            t.release()
        } catch (_: Exception) {
            // Already released or never started; nothing to clean up.
        }
    }

    fun close() = stopImmediately()
}

/**
 * The Vani conversation pipeline.
 *
 *   microphone -> (VAD)  -> STT partials  -> [VadEngine] endpoint
 *                                           -> LLM token stream
 *                                           -> [SentenceSplitter] -> TTS -> AudioTrack
 *
 * Stages overlap on purpose:
 *   * STT partials stream to the UI while the user is still talking.
 *   * The LLM starts generating as soon as VAD says the utterance ended.
 *   * TTS begins on the first sentence while the LLM is still producing the next.
 *   * The mic never closes during TTS, so barge-in is a state flip, not a restart.
 */
class VoicePipeline(
    private val stt: SherpaSttEngine,
    private val vad: VadEngine,
    private val llm: LlamaEngine,
    private val tts: TtsEngine,
    private val scope: CoroutineScope,
    private val onState: (VaniUiState) -> Unit,
) {
    private val supervisor = SupervisorJob()
    private val pipelineScope = CoroutineScope(scope.coroutineContext + supervisor)

    private var captureJob: Job? = null
    private var generateJob: Job? = null
    private var audioPlayer: AudioPlayer? = null

    private val _state = MutableStateFlow(VaniUiState())
    val state: StateFlow<VaniUiState> = _state.asStateFlow()

    private var history: MutableList<ChatMessage> = mutableListOf()
    private var pipelineRunning = false

    private val SAMPLE_RATE = 16000
    private val READ_SIZE = 1024

    @Synchronized
    private fun update(transform: (VaniUiState) -> VaniUiState) {
        _state.value = transform(_state.value)
        onState(_state.value)
    }

    fun start() {
        if (pipelineRunning) return
        pipelineRunning = true
        audioPlayer = AudioPlayer(tts.sampleRate.let { if (it > 0) it else SAMPLE_RATE })
        update { it.copy(listening = true, error = null) }
        captureJob = pipelineScope.launch { runCaptureLoop() }
    }

    fun stop() {
        captureJob?.cancel()
        generateJob?.cancel()
        audioPlayer?.stopImmediately()
        pipelineRunning = false
        stt.destroyStream()
        update {
            it.copy(
                listening = false,
                partialTranscript = "",
                orb = OrbState.IDLE,
                ttsSpeaking = false,
                isBargeIn = false,
            )
        }
    }

    /**
     * Feeds microphone audio to both STT (for live partials) and VAD (for endpoint
     * detection). Runs until [stop] is called.
     */
    private suspend fun runCaptureLoop() {
        val recorder = createRecorder() ?: run {
            update { it.copy(error = "Microphone is not available", listening = false, orb = OrbState.IDLE) }
            pipelineRunning = false
            return
        }

        val ttsActive = audioPlayer
        try {
        recorder.startRecording()

        // AEC must be built against the live recorder's audio session; it is what stops
        // Vani's own TTS output from being picked up by the mic and re-transcribed.
        val aec = try {
            AcousticEchoCanceler(recorder.audioSessionId)
        } catch (_: Exception) {
            null
        }

        update { it.copy(orb = OrbState.LISTENING) }

            val pcm = ShortArray(READ_SIZE)
            val floatBuf = FloatArray(READ_SIZE)

            while (pipelineRunning) {
                val read = recorder.read(pcm, 0, READ_SIZE)
                if (read > 0) {
                    // 16-bit PCM -> float in [-1, 1] for sherpa-onnx.
                    for (i in 0 until read) {
                        floatBuf[i] = (pcm[i].toInt() / 32768.0).toFloat()
                    }

                    // Live partial transcript, only while listening (not while speaking).
                    if (_state.value.orb != OrbState.SPEAKING) {
                        stt.acceptWaveform(floatBuf.copyOf(read))
                        if (stt.isReadyToDecode()) {
                            stt.decodeOnline()
                            val partial = stt.partialText()
                            if (partial.isNotEmpty()) {
                                update { it.copy(partialTranscript = partial) }
                            }
                        }
                    }

                    // VAD runs continuously so barge-in works while TTS is playing.
                    vad.acceptWaveform(floatBuf.copyOf(read))

                    if (vad.hasSpeechSegment()) {
                        handleEndpoint()
                        vad.pop()
                    }
                }
            }
        } catch (e: Exception) {
            update { it.copy(error = "Capture failed: ${e.message}", listening = false, orb = OrbState.IDLE) }
        } finally {
            try {
                recorder.stop()
            } catch (_: Exception) {
            }
            aec?.release()
            recorder.release()
        }
    }

    /**
     * End of an utterance. If TTS was playing, this is a barge-in: cut the audio now and
     * switch straight to listening instead of finishing the sentence.
     */
    private fun handleEndpoint() {
        val wasSpeaking = _state.value.ttsSpeaking
        audioPlayer?.stopImmediately()

        if (wasSpeaking) {
            update {
                it.copy(
                    ttsSpeaking = false,
                    isBargeIn = true,
                    partialTranscript = "",
                    orb = OrbState.LISTENING,
                )
            }
        }

        // Finalise the transcript for this utterance.
        generateJob?.cancel()
        val transcript = stt.partialText().ifEmpty { _state.value.partialTranscript }.trim()
        stt.inputFinished()
        stt.decodeOnline()
        val finalText = stt.partialText().ifEmpty { transcript }.trim()

        if (finalText.isEmpty()) return

        stt.resetOnline()
        update {
            it.copy(
                partialTranscript = "",
                messages = it.messages + ChatMessage(
                    id = UUID.randomUUID().toString(), role = ChatMessage.Role.USER, text = finalText
                ),
                orb = OrbState.THINKING,
            )
        }

        history.add(ChatMessage(UUID.randomUUID().toString(), ChatMessage.Role.USER, finalText))
        generateReply(finalText)
    }

    /** Streams the LLM reply and overlaps TTS with generation. */
    private fun generateReply(userText: String) {
        generateJob = pipelineScope.launch {
            val replyId = UUID.randomUUID().toString()
            update {
                it.copy(
                    messages = it.messages + ChatMessage(
                        id = replyId, role = ChatMessage.Role.ASSISTANT, text = "", isStreaming = true
                    )
                )
            }

            val splitter = SentenceSplitter(onSentence = ::synthesizeAndPlay)

            val full = try {
                llm.generate(
                    prompt = buildPrompt(userText),
                    onToken = { token ->
                        // Append to the streaming assistant message.
                        update { state ->
                            state.copy(
                                messages = state.messages.map { m ->
                                    if (m.id == replyId) m.copy(text = m.text + token) else m
                                }
                            )
                        }
                        splitter.accept(token)
                    },
                )
            } catch (e: Exception) {
                update {
                    it.copy(
                        error = "Generation failed: ${e.message}",
                        orb = OrbState.IDLE,
                        messages = it.messages.map { m ->
                            if (m.id == replyId) m.copy(isStreaming = false) else m
                        },
                    )
                }
                return@launch
            }

            splitter.flush()
            update {
                it.copy(
                    messages = it.messages.map { m ->
                        if (m.id == replyId) m.copy(text = full, isStreaming = false) else m
                    },
                    orb = OrbState.IDLE,
                    ttsSpeaking = false,
                )
            }
        }
    }

    /** Synthesises one sentence and plays it. Overlaps with continued LLM generation. */
    private suspend fun synthesizeAndPlay(sentence: String) = withContext(Dispatchers.Default) {
        val samples = tts.synthesize(sentence) ?: return@withContext
        if (samples.isEmpty()) return@withContext
        audioPlayer?.play(samples)
        update { it.copy(ttsSpeaking = true, orb = OrbState.SPEAKING) }
        // Playback is fire-and-forget: barge-in is detected by VAD, not by waiting here.
    }

    private fun buildPrompt(userText: String): String {
        val recent = history.takeLast(6).toList()
        val convo = ai.vani.engine.ChatTemplate.LFM_QWEN.format(
            recent.map { ai.vani.engine.ChatTurn(it.role.name.lowercase(), it.text) },
            userText
        )
        return convo
    }

    private fun createRecorder(): AudioRecord? {
        val channelMask = AudioFormat.CHANNEL_IN_MONO
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE, channelMask, AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuf == AudioRecord.ERROR || minBuf == AudioRecord.ERROR_BAD_VALUE) return null

        // VOICE_RECOGNITION applies the platform's voice-recognition preprocessing
        // (noise suppression, AEC) at the source, which is exactly what ASR wants.
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT,
            max(minBuf * 2, READ_SIZE * 2)
        )
        return if (recorder.state == AudioRecord.STATE_INITIALIZED) recorder else null
    }

    fun close() {
        stop()
        pipelineScope.cancel()
        audioPlayer?.close()
    }

    /** Exposed for the Settings screen to reset conversation history. */
    fun resetConversation() {
        history = mutableListOf()
        update { it.copy(messages = emptyList()) }
    }
}
