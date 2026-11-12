plugins {
    kotlin("jvm") version "1.9.24"
}

repositories {
    mavenCentral()
    // Robolectric's androidx.test:monitor dependency is published only here, not to Central.
    google()
}

// Point at the real sources rather than copying them — a copy would drift, and
// the whole value here is testing the code that actually ships.
//
// EVERY engine file compiles here, not an allow-list of the easy ones. That makes
// this project the engine's React-free compile gate: the classpath below has the
// Android SDK (compile-only) and androidx.annotation, and nothing from React
// Native or Flutter, so an engine file that imports com.facebook.* — or anything
// else an SDK bridge owns — fails `compileKotlin` here rather than surfacing as a
// build break in whichever SDK vendors the engine next. Code that needs android.*
// at run time is tested under Robolectric (see the `aars` configuration below).
//
// No `include` filter on either source set, deliberately. A filter would drop an
// unlisted .kt silently and the build would still exit 0 — a new test that never
// runs, or a new engine file that escapes the gate.
sourceSets {
    main {
        kotlin {
            setSrcDirs(listOf("../src/main/java"))
        }
    }
    test {
        kotlin {
            setSrcDirs(listOf("../src/test/java"))
        }
    }
}

// Robolectric pulls two AAR dependencies. AGP unpacks an AAR and puts its `classes.jar` on the
// classpath; a plain `kotlin("jvm")` project resolves the AAR and then ignores its contents, so the
// classes are simply absent and Robolectric dies at `NoClassDefFoundError:
// androidx/test/platform/app/InstrumentationRegistry` — after a green compile, since only the run
// time needs them. Unpacking them here is what lets this harness stay SDK-free rather than becoming
// an AGP project just to run Android-dependent unit tests.
val aars: Configuration by configurations.creating
val unpackedAars = layout.buildDirectory.dir("unpacked-aars")
val unpackAars by tasks.registering {
    val input = aars
    val outDir = unpackedAars
    inputs.files(input)
    outputs.dir(outDir)
    doLast {
        val dir = outDir.get().asFile
        dir.deleteRecursively()
        dir.mkdirs()
        input.forEach { aar ->
            copy {
                from(zipTree(aar)) { include("classes.jar") }
                into(dir)
                rename { "${aar.nameWithoutExtension}.jar" }
            }
        }
    }
}

dependencies {
    // org.json ships inside Android; on the JVM it comes from Maven Central.
    // The API is identical, which is why these files can be tested here at all.
    implementation("org.json:json:20240303")
    // The Android SDK classes, as a COMPILE classpath only — this harness has no Android SDK
    // installed and must not need one. Robolectric supplies the working implementations at run
    // time from its own instrumented copy.
    val androidAll = "org.robolectric:android-all:14-robolectric-10818077"
    compileOnly(androidAll)
    // On the test RUNTIME classpath too, which AGP's unit-test variant provides via android.jar
    // and this bare-JVM project has to state. Robolectric loads its own instrumented copies inside
    // its sandbox classloader, but the plain jar still has to be resolvable outside it — JUnit
    // reads `@Config`'s annotation defaults reflectively before any sandbox exists, and those
    // defaults name `android.app.Application`.
    testImplementation(androidAll)
    // @RequiresApi on the API-gated trackers — the same version the RN library declares.
    // Annotations only, so compile-only: nothing reads them at run time.
    compileOnly("androidx.annotation:annotation:1.8.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
    aars("androidx.test:monitor:1.7.1@aar")
    aars("androidx.test.espresso:espresso-idling-resource:3.6.1@aar")
    testImplementation(fileTree(unpackedAars) { include("*.jar") })
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    dependsOn(unpackAars)
    testLogging {
        events("passed", "failed", "skipped")
    }
}
