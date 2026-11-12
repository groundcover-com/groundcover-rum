// The native Android playground the shared Mobilewright suite (tests/e2e/mobile) drives with
// APP=native: a screen-for-screen mirror of apps/rn-playground and apps/flutter-playground.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
    plugins {
        // The SDK's own AGP and Kotlin (packages/android), so the included build and this one
        // share one plugin classpath.
        id("com.android.application") version "9.1.0"
        id("org.jetbrains.kotlin.android") version "2.4.0"
        id("org.jetbrains.kotlin.plugin.compose") version "2.4.0"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "android-playground"
include(":app")

// The SDK from source, as an app would depend on it from Maven Central: the coordinates the
// SDK publishes, swapped for the projects that build them.
includeBuild("../../packages/android") {
    dependencySubstitution {
        for (module in listOf(
            "rum-android",
            "rum-android-compose",
            "rum-android-okhttp",
            "rum-android-timber",
        )) {
            substitute(module("com.groundcover:$module")).using(project(":$module"))
        }
    }
}
