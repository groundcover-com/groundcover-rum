package com.groundcover.rum.timber

import android.app.Activity
import android.os.Looper
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import com.groundcover.rum.Groundcover
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.GroundcoverRumTesting
import com.groundcover.rum.TransportOptions
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import timber.log.Timber

// The tree end to end: the SDK started against a MockWebServer ingest, whose batches the test reads.

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GroundcoverTreeTest {
    private val server = MockWebServer()
    private val batches = LinkedBlockingQueue<JSONObject>()

    @Before
    fun setUp() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                batches.add(JSONObject(request.body.readUtf8()))
                return MockResponse().setResponseCode(200)
            }
        }
        server.start()
        Groundcover.start(
            ApplicationProvider.getApplicationContext(),
            GroundcoverConfig(
                apiKey = "k",
                dsn = server.url("/").toString(),
                cluster = "c",
                environment = "e",
                appId = "a",
                options = GroundcoverOptions(
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
        Timber.uprootAll()
        GroundcoverRumTesting.reset()
        server.shutdown()
    }

    private fun logs(count: Int): List<JSONObject> {
        val found = mutableListOf<JSONObject>()
        val deadline = System.currentTimeMillis() + 10_000
        while (found.size < count && System.currentTimeMillis() < deadline) {
            val events = (batches.poll(200, TimeUnit.MILLISECONDS) ?: continue)
                .getJSONArray("events")
            for (i in 0 until events.length()) {
                val event = events.getJSONObject(i)
                if (event.getString("type") == "log") found.add(event.getJSONObject("attributes"))
            }
        }
        return found
    }

    @Test
    fun eachPriorityIsALogAtItsLevelAndAnIgnoredMessageIsNot() {
        Timber.plant(GroundcoverTree(Log.VERBOSE))
        Timber.v("v")
        Timber.d("d")
        Timber.i("skip me groundcoverIgnore")
        Timber.i("i")
        Timber.w("w")
        Timber.e("e")
        Timber.wtf("a")
        val sent = logs(6)
        assertEquals(
            listOf("trace", "debug", "info", "warn", "error", "error"),
            sent.map { it.getString("level") }
        )
        assertEquals(listOf("v", "d", "i", "w", "e", "a"), sent.map { it.getString("message") })
    }

    @Test
    fun theTagAndTheThrowableAreAttributes() {
        Timber.plant(GroundcoverTree())
        Timber.tag("checkout").w(IllegalStateException("declined"), "payment failed")
        val log = logs(1).single()
        assertEquals("warn", log.getString("level"))
        assertEquals("checkout", log.getString("tag"))
        assertEquals("java.lang.IllegalStateException: declined", log.getString("throwable"))
        // Timber's own message: the text, then the throwable's stack trace.
        assertTrue(log.getString("message").startsWith("payment failed\n"))
    }

    @Test
    fun messagesBelowTheTreesPriorityAreNotSent() {
        Timber.plant(GroundcoverTree())
        Timber.d("too quiet")
        Timber.i("loud enough")
        assertEquals(listOf("loud enough"), logs(2).map { it.getString("message") })
    }
}
