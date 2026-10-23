plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ai.vani"
    compileSdk = 34
    ndkVersion = "26.3.11579264"

    defaultConfig {
        applicationId = "ai.vani"
        minSdk = 29
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"

        // arm64-v8a only, as specified. The three engines (llama.cpp, Sherpa-ONNX,
        // ONNX Runtime) are all built for ARM64; shipping x86_64 would double APK
        // size for a device class that never runs this app.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        multiDexEnabled = true

        vectorDrawables { useSupportLibrary = true }
    }

    signingConfigs {
        // Release signing is read from a local (gitignored) properties file so the
        // keystore never enters the repository. See scripts/build_apk.sh.
        if (rootProject.file("keystore.properties").exists()) {
            val props = java.util.Properties()
            rootProject.file("keystore.properties").inputStream().use { props.load(it) }
            create("release") {
                storeFile = rootProject.file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // Keep .so files uncompressed and page-aligned: mmap() of a 350MB-class GGUF is
    // much faster when the .so and the model do not have to be inflated at install.
    packaging {
        jniLibs {
            useLegacyPackaging = false
            keepDebugSymbols = false
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests {
            isReturnDefaultValues = true
            isIncludeAndroidResources = true
        }
    }

    assetPackaging {
        // Lottie animations are read from assets/animations at runtime.
        // Nothing to configure beyond the default, but this block documents intent.
    }
}

dependencies {
    implementation(libs.bundles.compose)
    implementation(libs.bundles.lifecycle)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.okhttp)
    implementation(libs.lottie)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.core.ktx)

    debugImplementation(libs.androidx.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(libs.kotlinx.coroutines.test)
}
