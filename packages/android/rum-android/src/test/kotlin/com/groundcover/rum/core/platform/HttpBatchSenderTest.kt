package com.groundcover.rum.core.platform

import com.groundcover.rum.core.common.RumDiagnostics
import com.groundcover.rum.core.transport.BatchRequest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// The batch sender as it talks to a server: the POST it makes, and the delivery verdict, against a
// local MockWebServer so nothing leaves the machine.
class HttpBatchSenderTest {
    private val server = MockWebServer()

    @Before
    fun startServer() {
        server.start()
    }

    @After
    fun stopServer() {
        server.shutdown()
    }

    private fun send(
        endpoint: String = server.url("/json/rum").toString(),
        headers: Map<String, String> = mapOf("apikey" to "k"),
        sender: HttpBatchSender = HttpBatchSender()
    ): Boolean {
        val latch = CountDownLatch(1)
        var delivered: Boolean? = null
        sender.send(
            endpoint,
            BatchRequest(headers, "{\"events\":[]}".toByteArray(Charsets.UTF_8))
        ) {
            delivered = it
            latch.countDown()
        }
        assertTrue("the sender completes", latch.await(10, TimeUnit.SECONDS))
        return delivered!!
    }

    @Test
    fun postsTheBodyAndHeadersAndCallsA2xxDelivered() {
        server.enqueue(MockResponse().setResponseCode(200))
        assertTrue(send(headers = mapOf("apikey" to "k", "Content-Type" to "application/json")))
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/json/rum", request.path)
        assertEquals("k", request.getHeader("apikey"))
        assertEquals("application/json", request.getHeader("Content-Type"))
        assertEquals("{\"events\":[]}", request.body.readUtf8())
    }

    @Test
    fun aNon2xxAnswerIsNotDelivered() {
        server.enqueue(MockResponse().setResponseCode(500))
        assertFalse(send())
    }

    @Test
    fun aRefusedKeyWarnsOnceWithDebugOff() {
        val lines = mutableListOf<String>()
        val sender = HttpBatchSender(diagnostics = RumDiagnostics(sink = { lines.add(it) }))
        listOf(401, 403, 401, 500).forEach { status ->
            server.enqueue(MockResponse().setResponseCode(status))
            assertFalse(send(sender = sender))
        }
        assertEquals(
            listOf(
                "[groundcover] ${server.url("/json/rum")} rejected a batch with HTTP 401. Check " +
                    "the apiKey and dsn passed to Groundcover.start(): no RUM data is recorded " +
                    "until they are accepted."
            ),
            lines
        )
    }

    @Test
    fun aNetworkFailureIsNotDelivered() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        assertFalse(send())
    }

    @Test
    fun anEndpointThatIsNotAUrlIsNotDelivered() {
        assertFalse(send(endpoint = ""))
    }
}
