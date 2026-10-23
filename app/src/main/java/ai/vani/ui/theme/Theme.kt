package ai.vani.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.TypographyStyle
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Vani's design system.
 *
 * One deliberate decision: Vani is *always* dark. The voice-assistant surface is a black
 * canvas with a glowing orb, and shipping a light theme would mean maintaining two
 * palettes and two orb treatments for a mode nobody asked for. `isSystemInDarkTheme` is
 * consulted only so a user who forces light mode still gets the dark canvas rather than a
 * broken hybrid.
 */
private val VaniColors = darkColorScheme(
    primary = Color(0xFF7AA2F7),
    onPrimary = Color(0xFF0D0D0D),
    primaryContainer = Color(0xFF2A3A5C),
    onPrimaryContainer = Color(0xFFD6E2FF),
    secondary = Color(0xFF9B8CF0),
    onSecondary = Color(0xFF0D0D0D),
    secondaryContainer = Color(0xFF3A2F5C),
    onSecondaryContainer = Color(0xFFE4DEFF),
    tertiary = Color(0xFF7AD7C7),
    onTertiary = Color(0xFF0D0D0D),
    tertiaryContainer = Color(0xFF2E4A44),
    onTertiaryContainer = Color(0xFFD3F5EC),
    background = Color(0xFF0D0D0D),
    onBackground = Color(0xFFF5F5F7),
    surface = Color(0xFF161616),
    onSurface = Color(0xFFF5F5F7),
    surfaceVariant = Color(0xFF1C1C1E),
    onSurfaceVariant = Color(0xFFA1A1A6),
    surfaceTint = Color(0xFF7AA2F7),
    outline = Color(0xFF2A2A2C),
    outlineVariant = Color(0xFF2A2A2C),
    error = Color(0xFFFF6B6B),
    onError = Color(0xFF0D0D0D),
    errorContainer = Color(0xFF4A1F1F),
    onErrorContainer = Color(0xFFFFD3D3),
    scrim = Color(0x66000000),
)

@Composable
fun VaniTheme(content: @Composable () -> Unit) {
    // Ignore the system setting on purpose - see the doc comment above.
    MaterialTheme(
        colorScheme = VaniColors,
        typography = VaniTypography,
        content = content,
    )
}

/**
 * Typography.
 *
 * Roboto is the platform default on Android and is always present; Inter is used as an
 * opt-in via the app's bundled font when it is shipped. Falling back to Roboto rather than
 * embedding a font keeps the APK small and avoids a licensing question for a UI that is
 * mostly one orb and a few lines of text.
 */
private val VaniTypography = Typography(
    displaySmall = TypographyStyle(
        fontWeight = FontWeight.Bold, fontSize = 34.sp, lineHeight = 42.sp,
        letterSpacing = (-0.5).sp
    ),
    headlineLarge = TypographyStyle(
        fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 36.sp
    ),
    headlineMedium = TypographyStyle(
        fontWeight = FontWeight.SemiBold, fontSize = 22.sp, lineHeight = 28.sp
    ),
    titleLarge = TypographyStyle(
        fontWeight = FontWeight.SemiBold, fontSize = 18.sp, lineHeight = 24.sp
    ),
    titleMedium = TypographyStyle(
        fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 22.sp
    ),
    bodyLarge = TypographyStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TypographyStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TypographyStyle(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = TypographyStyle(fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TypographyStyle(fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 16.sp),
    labelSmall = TypographyStyle(fontWeight = FontWeight.Medium, fontSize = 11.sp, lineHeight = 15.sp),
)
