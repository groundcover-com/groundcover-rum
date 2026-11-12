package com.groundcover.rum

import android.app.Application
import android.view.View
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.core.nativeengine.InteractiveMarks
import com.groundcover.rum.core.pipeline.FakeNativeEngine
import com.groundcover.rum.core.pipeline.FakePlatform
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// The public API as a Kotlin app calls it. Mostly a compile check: what's written here is the
// contract, and a change to any signature fails this file before it reaches an app. JavaApiTest is
// the same from Java.
@RunWith(RobolectricTestRunner::class)
class PublicApiTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()

    @After
    fun stopTheSdk() {
        GroundcoverRumTesting.reset()
    }

    @Test
    fun theQuickStartStarts() {
        Groundcover.start(
            app,
            GroundcoverConfig(
                apiKey = "your-rum-ingestion-key",
                dsn = "https://example.platform.grcv.io",
                cluster = "your-cluster",
                environment = "production",
                appId = "my-android-app"
            )
        )
    }

    @Test
    fun aBlankAppIdFailsTheStartWithItsReason() {
        for (appId in listOf("", "   ", "\n")) {
            val config = GroundcoverConfig("key", "localhost:9393", "c", "dev", appId)
            val error = assertThrows(GroundcoverInitException::class.java) {
                Groundcover.start(app, config)
            }
            assertEquals("start requires a nonblank appId", error.message)
        }
    }

    @Test
    fun everyOptionCanBeSet() {
        val options =
            GroundcoverOptions(
                enabledEvents = listOf(RumEventName.INTERACTION, RumEventName.APP_START),
                sessionSampleRate = 0.5,
                sessionMaxDurationMs = 2 * 60 * 60 * 1000L,
                debug = true,
                excludedUrls =
                    listOf(
                        UrlPattern.of("https://api.example.com/health"),
                        UrlPattern.of(Regex("/metrics$"))
                    ),
                beforeSend = { event -> event.type != "log" },
                enrichEvent = { event -> event.apply { attributes["team"] = "payments" } },
                privacy =
                    PrivacyOptions(
                        level = PrivacyLevel.MASK_SENSITIVE,
                        maskNetworkBodies = true,
                        maskNetworkQueryParams = true,
                        maskLogs = true,
                        maskErrors = true,
                        sensitiveKeys = listOf("order_id"),
                        redact = { field ->
                            if (field.key ==
                                "email"
                            ) {
                                "redacted@example.com"
                            } else {
                                null
                            }
                        },
                        maskInteractionLabels = false
                    ),
                tracing =
                    TracingOptions(
                        propagationUrls = listOf("https://api.myapp.com/*"),
                        propagationHeaders = listOf("traceparent", "b3"),
                        traceIdHeaderName = "x-trace-id",
                        spanIdHeaderName = "x-span-id",
                        origin = TracingOrigin("origin", "rum")
                    ),
                transport = TransportOptions(
                    batchSize = 20,
                    batchTimeoutMs = 5_000,
                    compression = true
                ),
                appVersion = "1.2.3",
                appBuild = "45",
                native = NativeOptions(
                    hangThresholdMs = 1_000,
                    vitalsMaxSegmentMs = 30_000,
                    tti = TtiMode.MANUAL
                ),
                hooks = NativeHooks(
                    activities = true,
                    fragments = false,
                    windowCallback = true,
                    textFields = false
                )
            )
        Groundcover.start(
            app,
            GroundcoverConfig(
                apiKey = "key",
                dsn = "localhost:9393",
                cluster = "c",
                environment = "dev",
                appId = "app",
                namespace = "ns",
                releaseId = "1.0.0",
                user = RumUser(id = "u_123", email = "demo@example.com"),
                sessionId = "fixed",
                options = options
            )
        )
    }

    @Test
    fun everyCallIsAvailable() {
        Groundcover.identifyUser(
            RumUser(
                id = "u_123",
                email = "demo@example.com",
                name = "Demo",
                role = "admin",
                organization = "acme",
                properties = mapOf("plan" to "pro")
            )
        )
        Groundcover.updateConfig(GroundcoverConfigUpdate(user = UserUpdate.Clear))
        Groundcover.updateConfig(
            GroundcoverConfigUpdate(
                environment = "staging",
                user = UserUpdate.Set(RumUser(id = "u_456")),
                options =
                    GroundcoverOptionsUpdate(
                        debug = false,
                        excludedUrls = listOf(UrlPattern.of("*/health")),
                        transport = TransportOptions(batchTimeoutMs = 1_000)
                    )
            )
        )
        Groundcover.sendCustomEvent("plan_upgraded", mapOf("plan" to "pro"))
        Groundcover.sendCustomEvent("opened")
        Groundcover.captureException(IllegalStateException("declined"), mapOf("step" to "pay"))
        Groundcover.logger.log("log")
        Groundcover.logger.info("info", mapOf("via" to "api"))
        Groundcover.logger.warn("Payment retry", mapOf("attempt" to 2))
        Groundcover.logger.error("error")
        Groundcover.logger.debug("debug")
        Groundcover.logger.trace("trace")
        assertEquals("", Groundcover.sessionId)
        Groundcover.setSessionId("fixed")
        var completed = false
        Groundcover.setSessionId("fixed") { completed = true }
        idleMainLooper()
        assertTrue(completed)
        Groundcover.setSessionId()
        Groundcover.startNavigation("Checkout", key = "checkout-1", metadata = mapOf("cart" to 3))
        Groundcover.endNavigation(mapOf("paid" to true))
        Groundcover.stopNavigationTracking()
        Groundcover.markAppInteractive()
    }

    @Test
    fun onceStartedTheSessionIdIsSetAndSetSessionIdCompletesAfterTheHandOver() {
        Groundcover.start(app, GroundcoverConfig("key", "localhost:9393", "c", "dev", "app"))
        assertTrue(waitFor { Groundcover.sessionId.length == 32 })
        var completed = false
        Groundcover.setSessionId("fixed") { completed = true }
        assertTrue(
            waitFor {
                idleMainLooper()
                completed
            }
        )
        assertEquals("fixed", Groundcover.sessionId)
    }

    @Test
    fun everyPublicCallReachesTheWire() {
        withStarted { platform ->
            Groundcover.identifyUser(RumUser(id = "u_1"))
            Groundcover.updateConfig(
                GroundcoverConfigUpdate(
                    environment = "staging",
                    user = UserUpdate.Set(RumUser(email = "ada@example.com"))
                )
            )
            Groundcover.sendCustomEvent("plan_upgraded", mapOf("plan" to "pro"))
            Groundcover.captureException(IllegalStateException("declined"), mapOf("step" to "pay"))
            val levels = listOf("log", "info", "warn", "error", "debug", "trace")
            Groundcover.logger.log("said log")
            Groundcover.logger.info("said info")
            Groundcover.logger.warn("said warn")
            Groundcover.logger.error("said error")
            Groundcover.logger.debug("said debug")
            Groundcover.logger.trace("said trace")
            // Hands the old session's buffer over, under it.
            Groundcover.setSessionId("next")

            val request = platform.requests.single()
            assertEquals(
                mapOf("id" to "u_1", "email" to "ada@example.com"),
                request.sessionAttributes["user"]
            )
            assertEquals("staging", request.sessionAttributes["env"])
            val events = request.events
            assertEquals(
                listOf("custom", "exception") + levels.map {
                    "log"
                },
                events.map { it["type"] }
            )
            val custom = attributesOf(events[0])
            assertEquals("plan_upgraded", custom["custom_event_name"])
            assertEquals("pro", custom["custom_event_attributes.plan"])
            val error = attributesOf(events[1])
            // Fully qualified, as a crash and each cause name it: one exception, one error_type.
            assertEquals("java.lang.IllegalStateException", error["error_type"])
            assertEquals("declined", error["error_message"])
            assertEquals("pay", error["error_metadata.step"])
            assertEquals(true, error["error_handled"])
            // The throwable's own frames, where it was made: this test.
            val frame = (error["error_stacktrace"] as List<*>).first() as Map<*, *>
            assertEquals(javaClass.name, frame["error_stacktrace[0].filename"])
            assertEquals("everyPublicCallReachesTheWire", frame["error_stacktrace[0].function"])
            assertTrue((frame["error_stacktrace[0].lineno"] as Int) > 0)
            assertEquals(levels, events.drop(2).map { attributesOf(it)["level"] })
            assertEquals(
                levels.map {
                    "said $it"
                },
                events.drop(2).map { attributesOf(it)["message"] }
            )
            assertEquals("next", Groundcover.sessionId)
        }
    }

    @Test
    fun aNavigationCarriesItsMetadataAsItWasWhenCalled() {
        withStarted { platform ->
            // A Java caller that reuses its map once the call returns; the start's metadata is
            // read only when the navigation ends.
            val metadata = HashMap<String, Any?>(mapOf("cart" to 3))
            Groundcover.startNavigation("Checkout", metadata = metadata)
            metadata.clear()
            Groundcover.endNavigation()
            Groundcover.setSessionId("next")

            val navigation = platform.requests.single().events.single {
                it["type"] == "navigation"
            }
            assertEquals(3, attributesOf(navigation)["metadata.cart"])
        }
    }

    @Test
    fun aHandledErrorCarriesItsCausesWhereACrashDoesTheirMessagesMasked() {
        withStarted { platform ->
            val root = java.io.IOException("token: abc123")
            Groundcover.captureException(
                RuntimeException(java.util.concurrent.ExecutionException("task failed", root)),
                mapOf("step" to "pay")
            )
            Groundcover.setSessionId("next")

            val error = attributesOf(
                platform.requests.single().events.single { it["type"] == "exception" }
            )
            assertEquals("pay", error["error_metadata.step"])
            assertEquals(
                listOf(
                    mapOf(
                        "error_metadata.causes[0].type" to
                            "java.util.concurrent.ExecutionException",
                        "error_metadata.causes[0].message" to "task failed"
                    ),
                    mapOf(
                        "error_metadata.causes[1].type" to "java.io.IOException",
                        "error_metadata.causes[1].message" to "token: [REDACTED]"
                    )
                ),
                error["error_metadata.causes"]
            )
        }
    }

    @Test
    fun markAppInteractiveCountsBeforeStartWithWhenItWasCalledAndOnlyTheFirstCallCounts() {
        InteractiveMarks.shared.reset()
        Groundcover.markAppInteractive()
        val mark = InteractiveMarks.shared.mark(manual = true)
        assertNotNull(mark)
        val platform = FakePlatform(nowMs = 1_234L)
        val previous = Groundcover.runtime.replacePlatform { platform.services }
        try {
            Groundcover.start(app, GroundcoverConfig("key", "localhost:9393", "c", "dev", "app"))
            Groundcover.markAppInteractive()
            assertEquals(mark, InteractiveMarks.shared.mark(manual = true))
        } finally {
            Groundcover.runtime.replacePlatform(previous)
        }
    }

    @Test
    fun markAppInteractiveInManualModeReleasesTtiOntoTheWire() {
        InteractiveMarks.shared.reset()
        val engine = FakeNativeEngine()
        val platform = FakePlatform().apply { this.engine = engine }
        val previous = Groundcover.runtime.replacePlatform { platform.services }
        try {
            Groundcover.start(
                app,
                GroundcoverConfig(
                    "key",
                    "localhost:9393",
                    "c",
                    "dev",
                    "app",
                    options = GroundcoverOptions(
                        native = NativeOptions(tti = TtiMode.MANUAL),
                        transport = TransportOptions(batchSize = 100, compression = false)
                    )
                )
            )
            Groundcover.runtime.dispatch("presence") { it.presence() }
            engine.emit(
                "app_start",
                mapOf(
                    "type" to "cold",
                    "startMs" to platform.nowMs - 2_000,
                    "firstFrameMs" to platform.nowMs - 1_150
                )
            )
            Groundcover.startNavigation("Home", "Home-1")
            Groundcover.markAppInteractive()
            Groundcover.runtime.dispatch("flush") { it.flush() }
            val tti = platform.requests.flatMap { it.events }
                .mapNotNull { it["attributes"] as? Map<*, *> }
                .firstOrNull { it["performance_metric_name"] == "app_start_tti" }
            // Marked now, 2 s after the start.
            assertEquals(2_000L, (tti?.get("performance_metric_value") as? Number)?.toLong())
        } finally {
            Groundcover.runtime.replacePlatform(previous)
        }
    }

    @Test
    fun markAppInteractiveAfterStartReadsTheSdksClockAndTheResetClearsIt() {
        InteractiveMarks.shared.reset()
        val platform = FakePlatform(nowMs = 1_234L)
        val previous = Groundcover.runtime.replacePlatform { platform.services }
        try {
            Groundcover.start(app, GroundcoverConfig("key", "localhost:9393", "c", "dev", "app"))
            Groundcover.markAppInteractive()
            assertEquals(1_234L, InteractiveMarks.shared.mark(manual = true))
            GroundcoverRumTesting.reset()
            assertNull(InteractiveMarks.shared.mark(manual = true))
            assertNull(InteractiveMarks.shared.mark(manual = false))
        } finally {
            Groundcover.runtime.replacePlatform(previous)
        }
    }

    /**
     * Runs [body] with the SDK started into a fake platform and present, as a tap makes it. Inline,
     * so a throwable made in [body] has the test's own frame on top.
     */
    private inline fun withStarted(body: (FakePlatform) -> Unit) {
        val platform = FakePlatform()
        val previous = Groundcover.runtime.replacePlatform { platform.services }
        try {
            Groundcover.start(
                app,
                GroundcoverConfig(
                    "key",
                    "localhost:9393",
                    "c",
                    "dev",
                    "app",
                    options = GroundcoverOptions(
                        transport = TransportOptions(batchSize = 100, compression = false)
                    )
                )
            )
            Groundcover.runtime.dispatch("presence") { it.presence() }
            body(platform)
        } finally {
            GroundcoverRumTesting.reset()
            Groundcover.runtime.replacePlatform(previous)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun attributesOf(event: Map<String, Any?>) = event["attributes"] as Map<String, Any?>

    @Test
    fun setSessionIdCompletesOnTheMainThread() {
        val ranOn = java.util.concurrent.ConcurrentLinkedQueue<Thread>()
        val record = Runnable { ranOn.add(Thread.currentThread()) }
        // Dropped before start, called from a background thread.
        Thread { Groundcover.setSessionId("early", record) }.apply { start() }.join()
        Groundcover.start(app, GroundcoverConfig("key", "localhost:9393", "c", "dev", "app"))
        // Completed by the core thread.
        Groundcover.setSessionId("fixed", record)
        assertTrue(
            waitFor {
                idleMainLooper()
                ranOn.size == 2
            }
        )
        assertEquals(listOf(mainThread(), mainThread()), ranOn.toList())
    }

    @Test
    fun anOnCompleteThatThrowsSurfacesOnTheMainThread() {
        Groundcover.start(app, GroundcoverConfig("key", "localhost:9393", "c", "dev", "app"))
        Groundcover.setSessionId("fixed") { throw IllegalStateException("the app's own bug") }
        val surfaced = assertThrows(IllegalStateException::class.java) {
            repeat(200) {
                idleMainLooper()
                Thread.sleep(10)
            }
        }
        assertEquals("the app's own bug", surfaced.message)
    }

    private fun mainThread() = android.os.Looper.getMainLooper().thread

    private fun idleMainLooper() {
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
    }

    private fun waitFor(condition: () -> Boolean): Boolean {
        repeat(200) {
            if (condition()) return true
            Thread.sleep(10)
        }
        return condition()
    }

    // The wire names are contract (the other SDKs and the wire spell them so), and the API file
    // records an enum's constants without them.
    @Test
    fun theWireNamesAreTheContract() {
        assertEquals(
            listOf(
                "interaction",
                "network",
                "logs",
                "navigation",
                "exceptions",
                "crashes",
                "hangs",
                "vitals",
                "appStart"
            ),
            RumEventName.entries.map { it.wireName }
        )
        assertEquals(
            listOf("mask-sensitive", "mask-all", "allow"),
            PrivacyLevel.entries.map { it.wireName }
        )
        assertEquals(
            listOf("request-body", "response-body", "query", "header", "log", "error"),
            RedactKind.entries.map { it.wireName }
        )
    }

    @Test
    fun hooksTakeAndReturnTheEvent() {
        val event =
            RumEvent(
                "interaction",
                "id",
                "span",
                attributes = mutableMapOf("interaction_target.label" to "Pay")
            )
        val beforeSend = BeforeSend { it.attributes["interaction_target.label"] != "x" }
        val enrich = EnrichEvent { it.apply { attributes["enriched"] = true } }
        assertTrue(beforeSend.shouldSend(event))
        assertEquals(true, enrich.enrich(event).attributes["enriched"])
    }

    @Test
    fun viewsCanBeMarkedPrivate() {
        val view = View(app)
        assertFalse(view.groundcoverPrivate)
        view.groundcoverPrivate = true
        assertTrue(view.groundcoverPrivate)
        view.groundcoverPrivate = false
        assertFalse(view.groundcoverPrivate)
    }
}
