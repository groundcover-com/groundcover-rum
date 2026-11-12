import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

// com.groundcover:rum-android-okhttp: the SDK's OkHttp integration. Built as rum-android is; see
// its build script for why each plugin is here.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlinx.binary-compatibility-validator")
    id("org.jlleitschuh.gradle.ktlint")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "com.groundcover.rum.okhttp"
    compileSdk = 36

    defaultConfig {
        minSdk = 23
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
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
    // A floor: an app's own OkHttp wins, 5.x included, which keeps the 4.x API.
    api("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

mavenPublishing {
    pom {
        name.set("groundcover RUM for Android: OkHttp")
        description.set("OkHttp integration for groundcover's Android RUM SDK.")
    }
}
