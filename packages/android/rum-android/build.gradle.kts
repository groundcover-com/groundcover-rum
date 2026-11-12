import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("com.android.library")
    // See gradle.properties for why this is applied under AGP 9.
    id("org.jetbrains.kotlin.android")
    // Writes the public API to api/rum-android.api; `apiCheck` (part of `check`) fails on any
    // difference, and `apiDump` rewrites the file.
    id("org.jetbrains.kotlinx.binary-compatibility-validator")
    // `ktlintCheck` (part of `check`) holds everything this module compiles except the engine,
    // and these build scripts, to the repo's .editorconfig; `ktlintFormat` applies it.
    id("org.jlleitschuh.gradle.ktlint")
    // Builds com.groundcover:rum-android as Maven Central gets it, with sources and Javadoc jars
    // (the engine's included); gradle.properties holds what the four modules share.
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.groundcover.rum"
    compileSdk = 36

    defaultConfig {
        // The engine's floor, as in the RN library and the Flutter plugin. Features above it
        // (FrameMetrics 24, ApplicationExitInfo 30) are Build.VERSION-guarded per call site.
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The engine compiles straight from packages/core: no vendored copy, unlike RN and Flutter,
    // whose packers can only ship files under their own directory. Maven publishes from Gradle,
    // which can read outside the module. One module also keeps what the engine marks `internal`
    // visible to the SDK and to the manifest.
    //
    // The whole tree, with no include filter: a filter would drop a new file silently.
    sourceSets {
        getByName("main") {
            kotlin.directories.add("../../core/kotlin/src/main/java")
        }
    }

    // The testing hooks write SharedPreferences, which their tests read back under Robolectric.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
        // The metadata older Kotlin compilers in host apps can still read.
        languageVersion = KotlinVersion.KOTLIN_2_0
        apiVersion = KotlinVersion.KOTLIN_2_0
        // No call but `start` throws into the app (Groundcover's contract), and Kotlin's null
        // checks on parameters would: a null from Java, or from a Kotlin platform type such as
        // `intent.getStringExtra(…)`, throws NullPointerException before the body runs. Without
        // them a null reaches the SDK's code, which treats every input as untrusted.
        freeCompilerArgs.addAll(
            "-Xno-param-assertions",
            "-Xno-call-assertions",
            "-Xno-receiver-assertions"
        )
    }
    // The stdlib the SDK asks of its host, matching the 2.0 language and API versions: KGP
    // otherwise declares its own (2.4), which an older host compiler can't read.
    coreLibrariesVersion = "2.0.21"
}

// GroundcoverInternal is for groundcover's own integration modules, not part of the public API.
apiValidation {
    nonPublicMarkers.add("com.groundcover.rum.internal.InternalGroundcoverApi")
}

ktlint {
    version.set("1.8.0")
    // The engine, shared with the RN and Flutter SDKs, is not held to it.
    filter {
        exclude("**/rum/engine/**")
    }
}

dependencies {
    // The engine's @RequiresApi only. The version the RN library and the Flutter plugin pin.
    implementation("androidx.annotation:annotation:1.8.2")
    // Read when the app has it, never shipped: tap targets in Compose come from its semantics
    // (RootForTest, public since 1.0). The floor rum-android-compose sets.
    compileOnly("androidx.compose.ui:ui:1.7.0")
    // Fragment screens, when the app has Fragments: the same rule.
    compileOnly("androidx.fragment:fragment:1.8.0")

    testImplementation("junit:junit:4.13.2")
    // The Fragment screen tests run real Fragments, at the version compiled against.
    testImplementation("androidx.fragment:fragment:1.8.0")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

mavenPublishing {
    pom {
        name.set("groundcover RUM for Android")
        description.set("groundcover's Real User Monitoring (RUM) SDK for Android apps.")
    }
}
