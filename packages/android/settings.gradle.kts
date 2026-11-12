// The native Android SDK: com.groundcover:rum-android, and one module per optional integration,
// so an app that doesn't use Compose, OkHttp or Timber never depends on them.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        // The Flutter plugin's and playground's AGP and Kotlin.
        id("com.android.library") version "9.1.0"
        id("org.jetbrains.kotlin.android") version "2.4.0"
        id("org.jetbrains.kotlin.plugin.compose") version "2.4.0"
        id("org.jetbrains.kotlinx.binary-compatibility-validator") version "0.18.2"
        id("org.jlleitschuh.gradle.ktlint") version "14.2.0"
        // What Maven Central gets: the POM and the sources and Javadoc jars. Here it only builds,
        // and release-android.yml signs and uploads.
        id("com.vanniktech.maven.publish") version "0.37.0"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "groundcover-rum-android"

// The SDK: its API, capture and pipeline, with the engine compiled in.
include(":rum-android")

// Jetpack Compose: the private-content modifier and the navigation effect.
include(":rum-android-compose")

// OkHttp: the interceptor and event listener that capture requests.
include(":rum-android-okhttp")

// Timber: a Tree that sends what an app logs through Timber as log events.
include(":rum-android-timber")
