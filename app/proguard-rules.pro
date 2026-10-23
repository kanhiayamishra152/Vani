# Vani AI - R8 / ProGuard rules.
#
# The JNI bridge methods in ai.vani.engine.NativeBridge are invoked reflectively by
# JNI lookup (RegisterNatives uses direct method pointers, but the engines expose
# std::function callbacks that Kotlin stores in longs). Keep the whole engine surface.

-keepclassmembers class ai.vani.engine.NativeBridge { *; }
-keepclassmembers class ai.vani.engine.NativeCallbacks { *; }
-keepclasseswithmembernames class * { native <methods>; }

# Coroutines
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
-dontwarn org.jetbrains.annotations.**
-dontwarn kotlinx.coroutines.**

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**

# Lottie
-dontwarn com.airbnb.lottie.**

# Keep the AIService / VoicePipeline state machine fields intact (they are read by
# the Compose snapshotter through reflection-free property access, but the classes are
# referenced from many places and R8 would otherwise strip unused accessors).
-keep class ai.vani.voice.** { *; }
-keep class ai.vani.model.** { *; }
-keep class ai.vani.engine.** { *; }

# JSON serialization of ModelSpec / DownloadProgress
-keepattributes *Code*
-keepclassmembers,allowobfuscation class * {
    @kotlinx.serialization.json.* <fields>;
}
