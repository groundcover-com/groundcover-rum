package com.groundcover.rum.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SafeStorageTest {
    @Test
    fun roundTripsThroughTheBackend() {
        val storage = SafeStorage(MapStorage())
        storage.setItem("k", "v")
        assertEquals("v", storage.getItem("k"))
        storage.removeItem("k")
        assertNull(storage.getItem("k"))
    }

    @Test
    fun neverThrowsWhenTheBackendDoes() {
        val storage = SafeStorage(MapStorage().apply { throwing = true })
        assertNull(storage.getItem("k"))
        storage.setItem("k", "v")
        storage.removeItem("k")
        assertEquals(7L, storage.getIntegerItem("k", fallback = 7))
    }

    @Test
    fun integerItemsReadExactlyAndFallBackWhenNotANumber() {
        val backend = MapStorage()
        backend.values.putAll(
            mapOf(
                "int" to "42",
                "padded" to " 42 ",
                "dec" to "1.5",
                "nan" to "abc",
                "inf" to "Infinity",
                "ns" to "1800000000000000001"
            )
        )
        val storage = SafeStorage(backend)
        assertEquals(42L, storage.getIntegerItem("int"))
        assertEquals(42L, storage.getIntegerItem("padded"))
        assertEquals(1L, storage.getIntegerItem("dec"))
        assertEquals(3L, storage.getIntegerItem("nan", fallback = 3))
        assertEquals(3L, storage.getIntegerItem("inf", fallback = 3))
        assertEquals(0L, storage.getIntegerItem("missing"))
        // A double would read this as ...000000: nanoseconds must come back exact.
        assertEquals(1_800_000_000_000_000_001L, storage.getIntegerItem("ns"))
    }

    @Test
    fun aNullBackendIsASilentNoOp() {
        val storage = SafeStorage(null)
        storage.setItem("k", "v")
        assertNull(storage.getItem("k"))
        assertEquals(5L, storage.getIntegerItem("k", fallback = 5))
    }
}
