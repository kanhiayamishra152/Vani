// Vani AI - top level build script.
// Plugin versions are resolved in settings.gradle.kts pluginManagement; here we only
// declare the ones applied by subprojects.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
