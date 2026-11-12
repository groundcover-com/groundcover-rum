# R8/ProGuard rules shipped WITH the library, applied automatically to any host app that
# minifies. The first two are the native engine's, the same rules the React Native and Flutter
# SDKs ship; the SDK's own rules follow.

# Declared in the library's AndroidManifest by fully-qualified name, and instantiated by the
# framework before Application.onCreate. A rename breaks app-start capture with a
# ClassNotFoundException during startup, before any of our own error handling exists.
-keep class com.groundcover.rum.engine.appstart.GcRumStartupProvider { <init>(); }

# Crash reporting reads `throwable.javaClass.name` for `error_type`
# (GcRumCrashRecordMapper). This keeps OUR names honest; the host's own exception classes
# follow the host's configuration.
-keepnames class com.groundcover.rum.engine.crash.**

# Compose and androidx.fragment are compiled against, never shipped: the SDK reads them only once
# it has found them in the app. An app without one of them would otherwise fail R8's
# missing-class check on the SDK's references.
-dontwarn androidx.compose.ui.**
-dontwarn androidx.fragment.app.**

# A Fragment screen is named by its class's simple name. A Fragment created in code (a pager's, a
# bottom navigation's) is otherwise renamed: its screen would be "a", and Fragments from different
# packages could share one name. The names only; R8 still removes what's unused.
-keepnames class * extends androidx.fragment.app.Fragment
