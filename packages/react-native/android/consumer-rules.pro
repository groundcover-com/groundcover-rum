# R8/ProGuard rules shipped WITH the library, applied automatically to any host app that
# minifies. Expo defaults `enableProguardInReleaseBuilds=false`, so most apps never exercise
# these — which is exactly why they are easy to get wrong and are documented per rule rather
# than kept as one broad `-keep class com.groundcover.rum.** { *; }`. A blanket keep would
# also defeat shrinking for every host app that does minify.

# The React Native bridge is reflective on BOTH sides of these.
#
# `GroundcoverRumPackage` is instantiated by the host's generated package list; the class
# name is what appears there, so it cannot be renamed. Its no-arg constructor is the
# entry point.
-keep class com.groundcover.rum.bridge.GroundcoverRumPackage { <init>(); }

# `@ReactMethod` functions are dispatched BY NAME from JavaScript, so their names must
# survive even though the class holding them need not — `getName()` is what JS resolves
# `NativeModules.GroundcoverRum` through, and it returns a string constant. Keeping the
# class as well because a renamed module class with kept methods has no benefit and reads
# as an accident to whoever meets these rules next.
-keep class com.groundcover.rum.bridge.GroundcoverRumModule {
    <init>(...);
    public java.lang.String getName();
    @com.facebook.react.bridge.ReactMethod <methods>;
}

# Declared in the library's AndroidManifest by fully-qualified name, and instantiated by the
# framework before Application.onCreate. A rename breaks app-start and TTI capture with a
# ClassNotFoundException during startup — before any of our own error handling exists.
-keep class com.groundcover.rum.engine.appstart.GcRumStartupProvider { <init>(); }

# Crash reporting reads `throwable.javaClass.name` for `error_type`
# (GcRumCrashRecordMapper). This rule cannot save the HOST's exception classes — their names
# are governed by the host's own configuration, and an obfuscated app will report obfuscated
# types until it uploads a mapping file. It keeps OUR names honest, and is the reason the
# gap is worth a README note rather than silence.
-keepnames class com.groundcover.rum.engine.crash.**

# The same mapper recognizes React Native's rethrown JS fatal by matching
# `throwable.javaClass.name` against `com.facebook.react.common.JavascriptException`
# (GcRumCrashRecordMapper.isReactNativeJsFatal) — that match is the ONLY thing stopping a
# JS crash, already reported by the JS layer with a source-mapped stack, from being recorded
# a second time natively with a worse one. A minifying host that renames the class defeats the
# match silently. RN's own AAR rules keep `com.facebook.react.bridge.**`, not `.common.**`, so
# nothing else protects this name. Keep the NAME only: RN throws the class at runtime, so it is
# never shrunk away — it just must not be obfuscated.
-keepnames class com.facebook.react.common.JavascriptException
