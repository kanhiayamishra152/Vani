package ai.vani.ui

import ai.vani.VaniViewModel
import ai.vani.voice.ChatMessage
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The transcript history.
 *
 * Shares [ai.vani.voice.VaniUiState] with the voice screen rather than keeping its own
 * copy: a conversation started by voice and a conversation continued by typing are the
 * same conversation, and splitting the state would let the two drift out of sync.
 */
@Composable
fun ChatScreen(viewModel: VaniViewModel) {
    val ui by viewModel.uiState.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (ui.messages.isEmpty()) {
                item {
                    Text(
                        text = "Nothing yet. Tap the Voice tab and say something.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            items(ui.messages, key = { it.id }) { message ->
                MessageBubble(message = message)
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage) {
    val isUser = message.role == ChatMessage.Role.USER
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        val bubbleWidth = if (isUser) 78.dp else 260.dp
        Box(
            modifier = Modifier
                .width(bubbleWidth)
                .background(
                    color = if (isUser) {
                        MaterialTheme.colorScheme.primaryContainer
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    },
                    shape = RoundedCornerShape(20.dp),
                )
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text = message.text.ifEmpty {
                    if (message.isStreaming) "…" else ""
                },
                style = MaterialTheme.typography.bodyMedium,
                color = if (isUser) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
        }
    }
}

/** Reserved for future typing indicator. */
@Composable
private fun SpacerHint() {
    Spacer(Modifier.height(0.dp))
}
