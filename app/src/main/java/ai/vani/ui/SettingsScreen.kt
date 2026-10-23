package ai.vani.ui

import ai.vani.SelfTestUiState
import ai.vani.VaniViewModel
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import ai.vani.R

/**
 * Settings, and the one-tap hardware self-test.
 *
 * The self-test exists because the APK cannot be exercised on a phone by whoever built it.
 * Tapping it runs the entire native chain on the device - download, load, generate 8 tokens -
 * and prints the verdict on screen and in logcat, which is the only way to know the NDK
 * build, the JNI bridge, scoped storage and the downloader all actually work on real
 * hardware.
 */
@Composable
fun SettingsScreen(viewModel: VaniViewModel) {
    val selfTest by viewModel.selfTest.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.settings_title),
            style = MaterialTheme.typography.headlineMedium,
        )

        // ---- self test -----------------------------------------------------
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant
            ),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Refresh, contentDescription = null)
                    Spacer(Modifier.width(10.dp))
                    Text(
                        text = stringResource(R.string.settings_self_test),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                }
                Text(
                    text = stringResource(R.string.settings_self_test_desc),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                Spacer(Modifier.height(12.dp))

                when (val s = selfTest) {
                    is SelfTestUiState.Idle -> {
                        OutlinedButton(onClick = { viewModel.runSelfTest() }) {
                            Text(stringResource(R.string.settings_self_test))
                        }
                    }

                    is SelfTestUiState.Running -> {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(
                                modifier = Modifier.width(18.dp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.width(10.dp))
                            Text(
                                text = stringResource(R.string.settings_self_test_running),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        }
                        Text(
                            text = "${s.stage} · ${s.detail}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }

                    is SelfTestUiState.Done -> {
                        Text(
                            text = s.message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (s.passed) {
                                MaterialTheme.colorScheme.tertiary
                            } else {
                                MaterialTheme.colorScheme.error
                            },
                            textAlign = TextAlign.Start,
                        )
                        Spacer(Modifier.height(12.dp))
                        OutlinedButton(onClick = { viewModel.runSelfTest() }) {
                            Text(stringResource(R.string.settings_self_test))
                        }
                    }
                }
            }
        }

        // ---- about -----------------------------------------------------------
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant
            ),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = stringResource(R.string.settings_about),
                    style = MaterialTheme.typography.titleMedium,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.settings_version) + " 1.0.0",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                }
                Text(
                    text = stringResource(R.string.settings_offline_note),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }

        Text(
            text = "Engines: llama.cpp (LLM) · Sherpa-ONNX (STT, VAD, TTS)",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
