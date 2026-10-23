package ai.vani.voice

/** The four animation states of the Vani orb. */
enum class OrbState {
    /** Slow, calm breathing. At rest, mic closed. */
    IDLE,

    /** Energetic rippling. Mic open, user is speaking or about to. */
    LISTENING,

    /** Swirling, contained. VAD fired, LLM is generating. */
    THINKING,

    /** Active pulsing. TTS audio is playing. */
    SPEAKING;

    companion object {
        fun from(name: String?): OrbState =
            entries.firstOrNull { it.name == name } ?: IDLE
    }
}

data class ChatMessage(
    val id: String,
    val role: Role,
    val text: String,
    /** True while the message is still being produced. */
    val isStreaming: Boolean = false,
) {
    enum class Role { USER, ASSISTANT }
}

/**
 * Everything the UI renders. Kept as one immutable snapshot so Compose can diff cheaply
 * during the fast partial-transcript updates that happen several times a second.
 */
data class VaniUiState(
    val orb: OrbState = OrbState.IDLE,
    val listening: Boolean = false,
    val partialTranscript: String = "",
    val messages: List<ChatMessage> = emptyList(),
    val isBargeIn: Boolean = false,
    val error: String? = null,
    val micPermissionGranted: Boolean = false,
    val ttsSpeaking: Boolean = false,
) {
    companion object {
        val EMPTY = VaniUiState()
    }
}
