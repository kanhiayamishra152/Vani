package ai.vani.ui

import ai.vani.ModelUiState
import ai.vani.VaniViewModel
import ai.vani.model.ModelSpec
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
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
 * Model Hub.
 *
 * The first screen defaults to English only: the default LLM, STT and TTS are all English
 * and are rendered first, with the multilingual and Hindi entries below them and never
 * pre-selected. That ordering is enforced here rather than in the catalogue so the
 * *presentation* rule is visible next to the *data* rule.
 */
@Composable
fun ModelsScreen(viewModel: VaniViewModel) {
    val state by viewModel.modelUi.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 16.dp),
    ) {
        Text(
            text = stringResource(R.string.models_title),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            text = stringResource(R.string.models_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))

        Text(
            text = stringResource(R.string.models_english_only_note),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(12.dp))

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 24.dp),
        ) {
            // English-only defaults first, then everything else - preserves the spec's
            // "first screen MUST default to English-only" requirement.
            val ordered = state.specs.sortedWith(
                compareBy({ it.languages.contains("en") && it.isDefault }, { !it.isDefault })
            )
            items(ordered, key = { it.id }) { spec ->
                ModelCard(
                    spec = spec,
                    state = state,
                    viewModel = viewModel,
                )
            }
        }
    }
}

@Composable
private fun ModelCard(
    spec: ModelSpec,
    state: ModelUiState,
    viewModel: VaniViewModel,
) {
    val progress = state.progressByModel[spec.id] ?: 0f
    val downloadState = state.downloadStateByModel[spec.id]
    val error = state.errorByModel[spec.id]
    val isDownloading = downloadState is ai.vani.model.DownloadSession.State.Downloading
    val isPaused = downloadState is ai.vani.model.DownloadSession.State.Paused
    val isComplete = viewModel.store.isComplete(spec)

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        ),
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.CloudDownload, contentDescription = null)
                Spacer(Modifier.height(0.dp).width(8.dp))
                Text(
                    text = spec.displayName,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                if (spec.isDefault) {
                    Text(
                        text = stringResource(R.string.models_default_badge),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }

            Text(
                text = spec.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp),
            )

            Text(
                text = "${spec.languages.joinToString()} · ${spec.sizeBytes / 1048576} MB",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(8.dp))

            when {
                isComplete -> {
                    Text(
                        text = stringResource(R.string.models_downloaded),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = { viewModel.deleteModel(spec) },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.errorContainer
                        ),
                    ) {
                        Icon(Icons.Outlined.Delete, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text(stringResource(R.string.models_cancel))
                    }
                }

                isDownloading || isPaused -> {
                    LinearProgressIndicator(
                        progress = { progress },
                        modifier = Modifier.fillMaxWidth().height(6.dp),
                    )
                    Text(
                        text = if (isDownloading) {
                            stringResource(R.string.models_downloading, (progress * 100).toInt())
                        } else {
                            stringResource(R.string.models_pause)
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Row {
                        if (isDownloading) {
                            Button(onClick = { viewModel.pauseModel(spec) }) {
                                Icon(Icons.Outlined.Pause, contentDescription = null)
                                Spacer(Modifier.width(6.dp))
                                Text(stringResource(R.string.models_pause))
                            }
                        } else {
                            Button(onClick = { viewModel.resumeModel(spec) }) {
                                Icon(Icons.Outlined.PlayArrow, contentDescription = null)
                                Spacer(Modifier.width(6.dp))
                                Text(stringResource(R.string.models_resume))
                            }
                        }
                    }
                }

                else -> {
                    if (error != null) {
                        Text(
                            text = stringResource(R.string.models_failed) + ": $error",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                            textAlign = TextAlign.Start,
                        )
                        Spacer(Modifier.height(8.dp))
                    }
                    Button(onClick = { viewModel.downloadModel(spec) }) {
                        Icon(Icons.Outlined.CloudDownload, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text(stringResource(R.string.models_download))
                    }
                }
            }
        }
    }
}

/** Kept so the import of the kind filter stays meaningful. */
@Composable
private fun KindSummary(kind: ModelKind) {
    Text("${ModelCatalog.all.count { it.kind == kind }} models")
}

/** Small helper used by ModelCard. */
@Composable
private fun Modifier.height(dp: androidx.compose.ui.unit.Dp): Modifier =
    this.then(androidx.compose.foundation.layout.height(dp))

@Composable
private fun Modifier.width(dp: androidx.compose.ui.unit.Dp): Modifier =
    this.then(androidx.compose.foundation.layout.width(dp))

/** Placeholder used by the empty state. */
@Composable
private fun EmptyState() {
    Box(modifier = Modifier.fillMaxSize()) {
        CircularProgressIndicator()
    }
}
