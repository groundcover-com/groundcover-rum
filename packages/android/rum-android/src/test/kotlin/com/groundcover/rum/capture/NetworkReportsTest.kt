package com.groundcover.rum.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The body rules an HTTP client integration reports by: read only when known, small and textual.

class NetworkReportsTest {
    private val json = "application/json"

    @Test
    fun onlyAKnownSmallTextualBodyIsRead() {
        assertTrue(NetworkReports.readsBody(json, 18))
        assertFalse(NetworkReports.readsBody(json, -1))
        assertFalse(NetworkReports.readsBody(json, 5000))
        assertFalse(NetworkReports.readsBody("image/png", 10))
    }

    @Test
    fun aRequestBodyIsItsTextOrThePlaceholderForWhatItIs() {
        assertEquals(
            "{\"a\":1}",
            NetworkReports.requestBody(json, 7, false, "{\"a\":1}".toByteArray())
        )
        assertEquals("", NetworkReports.requestBody(json, 0, false, null))
        assertEquals("[request body unavailable]", NetworkReports.requestBody(json, 7, true, null))
        assertEquals(
            "[request body unavailable]",
            NetworkReports.requestBody(json, -1, false, null)
        )
        assertEquals(
            "[request body too large]",
            NetworkReports.requestBody(json, 6000, false, null)
        )
        assertEquals(
            "[form data]",
            NetworkReports.requestBody("multipart/form-data; boundary=x", 10, false, null)
        )
    }

    @Test
    fun aResponseBodyIsKnownWithoutReadingWhenItCanBe() {
        val headers = mapOf("content-type" to json)
        assertEquals("", NetworkReports.responseBodyUnread("HEAD", 200, headers, 2))
        assertEquals("", NetworkReports.responseBodyUnread("GET", 204, headers, 2))
        assertEquals(
            "[response body too large]",
            NetworkReports.responseBodyUnread("GET", 200, headers, 9000)
        )
        assertEquals(
            "[unreadable response body]",
            NetworkReports.responseBodyUnread(
                "GET",
                200,
                mapOf("content-type" to "text/event-stream"),
                -1
            )
        )
        assertEquals(
            "[image data]",
            NetworkReports.responseBodyUnread("GET", 200, mapOf("content-type" to "image/png"), -1)
        )
        assertEquals(null, NetworkReports.responseBodyUnread("GET", 200, headers, -1))
        assertEquals(null, NetworkReports.responseBodyUnread("GET", 200, headers, 20))
    }

    @Test
    fun aResponseBodyReadByTheAppIsItsTextUnlessCutShortOrPastTheCap() {
        assertEquals("{}", NetworkReports.responseBodyRead("{}".toByteArray(), complete = true))
        assertEquals(
            "[response body unavailable]",
            NetworkReports.responseBodyRead("{".toByteArray(), complete = false)
        )
        assertEquals(
            "[response body too large]",
            NetworkReports.responseBodyRead(ByteArray(5001), complete = false)
        )
    }
}
