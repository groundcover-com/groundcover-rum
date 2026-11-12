group = "com.groundcover.rum.flutter"
version = "1.0-SNAPSHOT"

buildscript {
    val kotlinVersion = "2.4.0"
    repositories {
        google()
        mavenCentral()
    }

    dependencies {
        classpath("com.android.tools.build:gradle:9.1.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

plugins {
    id("com.android.library")
}

android {
    namespace = "com.groundcover.rum.flutter"

    compileSdk = 36

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // src/main/kotlin/com/groundcover/rum/engine is the native engine. It compiles into this
    // module, which keeps the classes the engine marks `internal` visible to the manifest.
    sourceSets {
        getByName("main") {
            java.srcDirs("src/main/kotlin")
        }
    }

    defaultConfig {
        // The engine's floor, as in the RN library: frame vitals come from Dart, and
        // anything above 23 is Build.VERSION-guarded.
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }
}

dependencies {
    // The engine's @RequiresApi only — features above minSdk are Build.VERSION-guarded per
    // call site. The version the RN library pins.
    implementation("androidx.annotation:annotation:1.8.2")
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
