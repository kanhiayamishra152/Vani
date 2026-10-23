package ai.vani.ui

import ai.vani.PermissionState
import ai.vani.R
import ai.vani.VaniViewModel
import ai.vani.voice.OrbState
import ai.vani.voice.VaniUiState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

/**
 * The voice surface: orb, live transcript, and the push-to-talk control.
 *
 * This is the screen the spec is really about. Everything on it is driven by
 * [VaniUiState], so the four orb states and the barge-in transition are just different
 * values of the same state - which is what makes the crossfade in [VaniOrb] a pure
 * function of the conversation state rather than a separate animation controller.
 */
@Composable
fun VoiceScreen(viewModel: VaniViewModel) {
    val ui by viewModel.uiState.collectAsStateWithLifecycle()
    val permission by viewModel.permission.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 32.dp),
        ) {
            // ---- the orb -----------------------------------------------------
            VaniOrb(
                state = ui.orb,
                modifier = Modifier.size(280.dp),
                onReady = { /* compositions loaded */ },
            )

            Spacer(Modifier.height(36.dp))

            // ---- state label ---------------------------------------------------
            Text(
                text = stateLabel(ui),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(12.dp))

            // ---- live transcript ------------------------------------------------
            if (ui.partialTranscript.isNotEmpty()) {
                Text(
                    text = ui.partialTranscript,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                )
            } else if (permission == PermissionState.GRANTED && !ui.listening) {
                Text(
                    text = stringResource(R.string.voice_hint),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Spacer(Modifier.height(48.dp))

            // ---- the control ----------------------------------------------------
            when (permission) {
                PermissionState.GRANTED -> MicButton(
                     listening = ui.listening,
                     onClick = { viewModel.toggleVoice() },
                )

                // First refusal: show why, and offer to ask again.
                PermissionState.DENIED -> PermissionButton(
                    rationale = stringResource(R.string.perm_rationale_audio),
                    onClick = { LocalVaniPermissionRequest.current() },
                )

                // Never asked yet, or asked and permanently denied with no rationale.
                PermissionState.NOT_DETERMINED -> PermissionButton(
                    rationale = stringResource(R.string.perm_rationale_audio),
                    onClick = { LocalVaniPermissionRequest.current() },
                )
            }

            if (ui.error != null) {
                Spacer(Modifier.height(16.dp))
                Text(
                    text = ui.error!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

@Composable
private fun stateLabel(ui: VaniUiState): String = when (ui.orb) {
    OrbState.IDLE -> "Vani"
    OrbState.LISTENING -> stringResource(R.string.voice_state_listening)
    OrbState.THINKING -> stringResource(R.string.voice_state_thinking)
    OrbState.SPEAKING -> stringResource(R.string.voice_state_speaking)
}

@Composable
private fun MicButton(listening: Boolean, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = CircleShape,
        colors = ButtonDefaults.buttonColors(
            containerColor = if (listening) {
                MaterialTheme.colorScheme.secondaryContainer
            } else {
                MaterialTheme.colorScheme.primaryContainer
            },
            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        ),
        modifier = Modifier.size(84.dp),
    ) {
        Icon(
            imageVector = if (listening) Icons.Filled.MicOff else Icons.Filled.Mic,
            contentDescription = stringResource(R.string.cd_mic_button),
            modifier = Modifier.size(36.dp),
        )
    }
}

@Composable
private fun PermissionButton(rationale: String, onClick: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = rationale,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = onClick) {
            Text(stringResource(R.string.perm_retry))
        }
    }
}
