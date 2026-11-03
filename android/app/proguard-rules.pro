# Vani AI — keep JNI + bridge + sherpa-onnx entry points (minify is off for
# v1.0.0 reliability; these rules future-proof an optimized build).
-keep class ai.vani.app.Bridge { *; }
-keep class ai.vani.app.LlmEngine { *; }
-keep class ai.vani.app.LlmEngine$Callback { *; }
-keep class com.k2fsa.sherpa.onnx.** { *; }
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }
