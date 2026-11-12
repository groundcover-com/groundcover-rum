import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    // See gradle.properties for why this is applied under AGP 9.
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Build-time environment, the counterpart of the Flutter playground's --dart-define values and
// RN's EXPO_PUBLIC_* ones. The defaults are the e2e run's: the mock ingest on the host, as the
// emulator reaches it. A device run names a git-ignored properties file holding its values,
// `-PgcEnvFile=device.properties`, as Flutter's names a JSON file, so the key is in neither the
// repo nor the command line (README). A -P property still wins, for the values that aren't secret.
val envFile: Properties =
    Properties().apply {
        (findProperty("gcEnvFile") as String?)?.let { path ->
            rootProject.file(path).reader().use { load(it) }
        }
    }

fun env(name: String, default: String): String =
    listOf(findProperty(name) as String?, envFile.getProperty(name))
        .firstNotNullOfOrNull { it?.trim()?.takeIf(String::isNotEmpty) } ?: default

android {
    namespace = "com.groundcover.nativeplayground"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.groundcover.nativeplayground"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        buildConfigField("String", "GC_DSN", "\"${env("gcDsn", "http://10.0.2.2:9393")}\"")
        buildConfigField("String", "GC_API_KEY", "\"${env("gcApiKey", "e2e-key")}\"")
        buildConfigField("String", "GC_PRESET", "\"${env("gcPreset", "")}\"")
        buildConfigField("String", "GC_RELEASE_ID", "\"${env("gcReleaseId", "1.0.0")}\"")
        buildConfigField("String", "GC_DEBUG", "\"${env("gcDebug", "")}\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The locator contract test runs the app under Robolectric, resources and all.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}

dependencies {
    // The SDK, by the coordinates an app uses; settings.gradle.kts swaps in the source build.
    implementation("com.groundcover:rum-android")
    implementation("com.groundcover:rum-android-compose")
    implementation("com.groundcover:rum-android-okhttp")
    implementation("com.groundcover:rum-android-timber")

    // Pinned to releases that accept compileSdk 36: Compose 1.12 (BOM 2026.08), navigation
    // 2.10 and fragment 1.9 require 37.
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.navigation:navigation-compose:2.9.8")
    // AndroidFragment<…>() in a NavHost route: Detail is a real Fragment, so the SDK's Fragment
    // lifecycle hook has one to see.
    implementation("androidx.fragment:fragment-compose:1.8.9")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.jakewharton.timber:timber:5.0.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    testImplementation(platform("androidx.compose:compose-bom:2026.06.01"))
    testImplementation("androidx.compose.ui:ui-test-junit4")
}
