# R8/ProGuard rules shipped WITH the plugin, applied automatically to any host app that
# minifies (Flutter's release builds do by default). The engine's half of the RN library's
# consumer-rules.pro, documented per rule there; the RN-specific rules stay in RN.

# Declared in the plugin's AndroidManifest by fully-qualified name, and instantiated by the
# framework before Application.onCreate. A rename breaks app-start capture with a
# ClassNotFoundException during startup, before any of our own error handling exists.
-keep class com.groundcover.rum.engine.appstart.GcRumStartupProvider { <init>(); }

# Crash reporting reads `throwable.javaClass.name` for `error_type`
# (GcRumCrashRecordMapper). This keeps OUR names honest; the host's own exception classes
# follow the host's configuration.
-keepnames class com.groundcover.rum.engine.crash.**
