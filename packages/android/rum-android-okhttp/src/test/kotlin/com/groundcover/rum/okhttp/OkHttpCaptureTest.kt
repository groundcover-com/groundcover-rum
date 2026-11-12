package com.groundcover.rum.okhttp

import android.app.Activity
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.Groundcover
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.GroundcoverOptionsUpdate
import com.groundcover.rum.GroundcoverRumTesting
import com.groundcover.rum.TracingOptions
import com.groundcover.rum.TracingOrigin
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.internal.GroundcoverInternal
import com.groundcover.rum.internal.InternalGroundcoverApi
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// The interceptor end to end: the SDK started against a MockWebServer that is both the app's API
// (echoing each request's headers) and the ingest, whose batches the test reads.

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OkHttpCaptureTest {
    private val server = MockWebServer()
    private val batches = java.util.concurrent.LinkedBlockingQueue<JSONObject>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path ?: ""
                if (path.startsWith("/ingest/json/rum")) {
                    batches.add(JSONObject(request.body.readUtf8()))
                    return MockResponse().setResponseCode(200)
                }
                if (path.startsWith("/slow")) {
                    return MockResponse().setHeadersDelay(5, TimeUnit.SECONDS)
                }
                if (path.startsWith("/typed")) {
                    val url = request.requestUrl!!
                    val size = url.queryParameter("size")!!.toInt()
                    val type = url.queryParameter("type")!!
                    val typed = MockResponse().setHeader("content-type", type)
                        .setBody("x".repeat(size))
                    // Held: the headers now, the body only later, so the app may cancel between.
                    // Under MockWebServer's 5 s wait at shutdown, which the delay would outlast.
                    if (url.queryParameter("held") != null) typed.setBodyDelay(1, TimeUnit.SECONDS)
                    return typed
                }
                if (path.startsWith("/chunked")) {
                    val size = path.substringAfter("size=").toInt()
                    return MockResponse().setHeader("content-type", "application/json")
                        .setChunkedBody("{\"a\":\"" + "x".repeat(size) + "\"}", 64)
                }
                val echo = JSONObject().put("traceparent", request.getHeader("traceparent") ?: "")
                return MockResponse().setHeader(
                    "content-type",
                    "application/json"
                ).setBody(echo.toString())
            }
        }
        server.start()
        Groundcover.start(
            ApplicationProvider.getApplicationContext(),
            GroundcoverConfig(
                apiKey = "k",
                // A path of its own: a request to the ingest is the SDK's upload, never captured.
                dsn = server.url("/ingest").toString(),
                cluster = "c",
                environment = "e",
                appId = "a",
                options = GroundcoverOptions(
                    tracing = TracingOptions(propagationUrls = listOf("*")),
                    transport = TransportOptions(batchSize = 0, compression = false)
                )
            )
        )
        // Presence: a return to the foreground, the way an app shows it.
        val activity = Robolectric.buildActivity(Activity::class.java).setup()
        activity.pause().stop()
        activity.start().resume()
        shadowOf(Looper.getMainLooper()).idle()
    }

    @After
    fun tearDown() {
        GroundcoverRumTesting.reset()
        server.shutdown()
    }

    private val client = OkHttpClient.Builder()
        .addInterceptor(GroundcoverOkHttpInterceptor())
        .eventListenerFactory(GroundcoverEventListener.Factory())
        .build()

    private fun networkEvents(count: Int): List<JSONObject> {
        val found = mutableListOf<JSONObject>()
        val deadline = System.currentTimeMillis() + 10_000
        while (found.size < count && System.currentTimeMillis() < deadline) {
            val batch = batches.poll(200, TimeUnit.MILLISECONDS) ?: continue
            val events: JSONArray = batch.getJSONArray("events")
            for (i in 0 until events.length()) {
                val event = events.getJSONObject(i)
                if (event.getString("type") ==
                    "network"
                ) {
                    found.add(event.getJSONObject("attributes"))
                }
            }
        }
        return found
    }

    @Test
    fun aRequestCarriesATraceparentAndIsReportedWithItsBodies() {
        val response = client.newCall(
            Request.Builder().url(server.url("/echo"))
                .post("{\"hello\":\"mobile\"}".toRequestBody("application/json".toMediaType()))
                .build()
        ).execute()
        val echoed = JSONObject(response.body!!.string()).getString("traceparent")
        assertTrue(echoed, echoed.matches(Regex("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")))
        val event = networkEvents(1).single()
        assertEquals("200", event.getString("status"))
        assertEquals("POST", event.getString("http.method"))
        assertEquals(echoed, event.getString("http.request.headers.traceparent"))
        assertEquals("{\"hello\":\"mobile\"}", event.getString("gc.request.body"))
        assertTrue(event.getString("gc.response.body").contains(echoed))
    }

    /** Traces every request with [origin] too, once the core has applied it. */
    @OptIn(InternalGroundcoverApi::class)
    private fun traceWithOrigin(origin: TracingOrigin) {
        Groundcover.updateConfig(
            GroundcoverConfigUpdate(
                options = GroundcoverOptionsUpdate(
                    tracing = TracingOptions(propagationUrls = listOf("*"), origin = origin)
                )
            )
        )
        val url = server.url("/echo").toString()
        fun applied() = GroundcoverInternal.networkTraceHeaders(url, emptyList())
            ?.containsKey(origin.name) == true
        val deadline = System.currentTimeMillis() + 10_000
        while (!applied()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("origin never applied")
            Thread.sleep(20)
        }
    }

    @Test
    fun aTraceHeaderValueOkHttpRefusesIsLeftOffAndTheRequestStillGoes() {
        // A value an app might take from its own name: OkHttp refuses anything but ASCII.
        traceWithOrigin(TracingOrigin("x-origin", "Café app"))
        val response = client.newCall(Request.Builder().url(server.url("/echo")).build()).execute()
        val echoed = JSONObject(response.body!!.string()).getString("traceparent")
        assertTrue(echoed, echoed.matches(Regex("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")))
    }

    @Test
    fun aRequestWithItsOwnTraceparentKeepsItAndGainsNoTraceHeader() {
        // The app's own tracer, or another SDK's interceptor before ours, set it.
        traceWithOrigin(TracingOrigin("x-origin", "app"))
        val own = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        val response = client.newCall(
            Request.Builder().url(server.url("/echo")).header("traceparent", own).build()
        ).execute()
        assertEquals(own, JSONObject(response.body!!.string()).getString("traceparent"))
        val event = networkEvents(1).single()
        assertEquals(own, event.getString("http.request.headers.traceparent"))
        assertFalse(event.has("http.request.headers.x-origin"))
    }

    @Test
    fun aRequestCarryingOnlyTheOriginHeaderStillGainsATraceparent() {
        // Only a propagation header is a trace context of the request's own.
        traceWithOrigin(TracingOrigin("x-origin", "app"))
        val response = client.newCall(
            Request.Builder().url(server.url("/echo")).header("x-origin", "web").build()
        ).execute()
        val echoed = JSONObject(response.body!!.string()).getString("traceparent")
        assertTrue(echoed, echoed.matches(Regex("^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")))
    }

    @Test
    fun aRefusedConnectionIsStatusZeroAndACancelledCallIsNotReported() {
        val refused = OkHttpClient.Builder()
            .addInterceptor(GroundcoverOkHttpInterceptor())
            .build()
        try {
            refused.newCall(
                Request.Builder().url("http://127.0.0.1:1/unreachable").build()
            ).execute()
        } catch (_: IOException) {
        }
        val slow = client.newCall(Request.Builder().url(server.url("/slow")).build())
        Thread {
            Thread.sleep(200)
            slow.cancel()
        }.start()
        try {
            slow.execute()
        } catch (_: IOException) {
        }
        // Cancelled once its headers are in, as a screen that goes away does: closing the
        // response then doesn't report it.
        val read = client.newCall(Request.Builder().url(server.url("/chunked?size=10")).build())
        read.execute().use { read.cancel() }
        val events = networkEvents(3)
        assertEquals(1, events.size)
        assertEquals("0", events.single().getString("status"))
        assertEquals("ERR_NETWORK_FAILURE", events.single().getString("error.type"))
    }

    @Test
    fun aBodyKnownFromItsHeadersIsReportedOnceReadAndNotWhenCancelledFirst() {
        // A binary body, and one known to be past the cap: the SDK keeps none of it, but the app
        // may still cancel while it reads.
        for (held in listOf("type=image/png&size=10", "type=text/plain&size=6000")) {
            val url = server.url("/typed?held=1&$held")
            val call = client.newCall(Request.Builder().url(url).build())
            call.execute().use { call.cancel() }
        }
        val read = server.url("/typed?type=image/png&size=10")
        client.newCall(Request.Builder().url(read).build()).execute().use { it.body!!.bytes() }
        val event = networkEvents(1).single()
        assertFalse(event.getString("url.full"), event.getString("url.full").contains("held"))
        assertEquals("[image data]", event.getString("gc.response.body"))
    }

    @Test
    fun anEventStreamIsReportedOnceOpenThoughTheAppEndsItByCancelling() {
        // A stream has no end of its own: the app cancels it as it leaves (EventSource.cancel).
        val stream = server.url("/typed?held=1&type=text/event-stream&size=10")
        val call = client.newCall(Request.Builder().url(stream).build())
        call.execute().use { call.cancel() }
        val event = networkEvents(1).single()
        assertEquals("200", event.getString("status"))
        assertEquals("[unreadable response body]", event.getString("gc.response.body"))
    }

    @Test
    fun aChunkedBodyIsKeptAsTheAppReadsItAndTooLargePastTheCap() {
        client.newCall(Request.Builder().url(server.url("/chunked?size=10")).build()).execute()
            .use { it.body!!.string() }
        client.newCall(Request.Builder().url(server.url("/chunked?size=6000")).build()).execute()
            .use { it.body!!.string() }
        val events = networkEvents(2).associateBy {
            it.getString("url.full").substringAfter("size=")
        }
        assertEquals("{\"a\":\"xxxxxxxxxx\"}", events.getValue("10").getString("gc.response.body"))
        assertEquals(
            "[response body too large]",
            events.getValue("6000").getString("gc.response.body")
        )
    }

    @Test
    fun aBodyTheAppClosesUnreadIsUnavailable() {
        client.newCall(
            Request.Builder().url(server.url("/chunked?size=10")).build()
        ).execute().close()
        assertEquals(
            "[response body unavailable]",
            networkEvents(1).single().getString("gc.response.body")
        )
    }
}
