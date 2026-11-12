import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

// com.groundcover:rum-android-compose: the SDK's Jetpack Compose integration. Built as
// rum-android is; see its build script for why each plugin is here.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlinx.binary-compatibility-validator")
    id("org.jlleitschuh.gradle.ktlint")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.groundcover.rum.compose"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
        languageVersion = KotlinVersion.KOTLIN_2_0
        apiVersion = KotlinVersion.KOTLIN_2_0
    }
    // As rum-android: the stdlib matching the 2.0 language and API versions.
    coreLibrariesVersion = "2.0.21"
}

ktlint {
    version.set("1.8.0")
}

dependencies {
    api(project(":rum-android"))
    // Floors, not pins: an app's own Compose and Navigation versions win. Both from
    // September 2024.
    api("androidx.compose.runtime:runtime:1.7.0")
    api("androidx.compose.ui:ui:1.7.0")
    api("androidx.navigation:navigation-runtime:2.8.0")
}

mavenPublishing {
    pom {
        name.set("groundcover RUM for Android: Jetpack Compose")
        description.set("Jetpack Compose integration for groundcover's Android RUM SDK.")
    }
}
