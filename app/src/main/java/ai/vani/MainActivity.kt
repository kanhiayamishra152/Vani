package ai.vani

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.outlined.Chat
import androidx.compose.material.icons.outlined.CloudDownload
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ai.vani.ui.ChatScreen
import ai.vani.ui.ModelsScreen
import ai.vani.ui.SettingsScreen
import ai.vani.ui.VoiceScreen
import ai.vani.ui.theme.VaniTheme

/** Top-level destinations. */
enum class Destination(val route: String, val labelRes: Int, val icon: @Composable () -> Unit) {
    VOICE("voice", R.string.nav_voice) {
        Icon(Icons.Filled.GraphicEq, contentDescription = null)
    },
    CHAT("chat", R.string.nav_chat) {
        Icon(Icons.Outlined.Chat, contentDescription = null)
    },
    MODELS("models", R.string.nav_models) {
        Icon(Icons.Outlined.CloudDownload, contentDescription = null)
    },
    SETTINGS("settings", R.string.nav_settings) {
        Icon(Icons.Outlined.Settings, contentDescription = null)
    };
}

/**
 * Bridges the Activity-owned permission launcher down to the screens.
 *
 * The launcher can only be registered once, from an Activity, but the button that needs it
 * lives in a Composable. Passing a `@Composable () -> Unit` through Compose state would
 * lose the identity of the underlying launcher, so a static CompositionLocal carrying the
 * *action* (a plain function reference) is the smallest correct bridge.
 */
val LocalVaniPermissionRequest = staticCompositionLocalOf<() -> Unit> { {} }

class MainActivity : ComponentActivity() {

    private lateinit var viewModel: VaniViewModel

    private val requestMicrophone =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            viewModel.onPermissionResult()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Dark status/nav bars: the whole surface is #0D0D0D, so light icons are required.
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )

        viewModel = viewModel()

        setContent {
            VaniTheme {
                val navController = rememberNavController()

                CompositionLocalProvider(
                    LocalVaniPermissionRequest provides {
                        requestMicrophone.launch(Manifest.permission.RECORD_AUDIO)
                    }
                ) {
                    AppScaffold(navController = navController, viewModel = viewModel)
                }
            }
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        viewModel.onPermissionResult()
    }
}

@Composable
private fun AppScaffold(
    navController: NavHostController,
    viewModel: VaniViewModel,
) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    Scaffold(
        bottomBar = {
            NavigationBar {
                Destination.entries.forEach { destination ->
                    NavigationBarItem(
                        selected = currentRoute == destination.route,
                        onClick = {
                            if (currentRoute != destination.route) {
                                navController.navigate(destination.route) {
                                    popUpTo(navController.graph.startDestinationId) {
                                        saveState = true
                                    }
                                    launchSingleTop = true
                                    restoreState = true
                                }
                            }
                        },
                        icon = destination.icon,
                        label = { Text(stringResource(destination.labelRes)) },
                    )
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = Destination.VOICE.route,
            modifier = androidx.compose.ui.Modifier.padding(padding),
        ) {
            composable(Destination.VOICE.route) {
                VoiceScreen(viewModel = viewModel)
            }
            composable(Destination.CHAT.route) {
                ChatScreen(viewModel = viewModel)
            }
            composable(Destination.MODELS.route) {
                ModelsScreen(viewModel = viewModel)
            }
            composable(Destination.SETTINGS.route) {
                SettingsScreen(viewModel = viewModel)
            }
        }
    }
}

/** Reserved for future nav-graph builders; keeps the import meaningful. */
private fun NavGraphBuilder.vaniRoutes() {}
