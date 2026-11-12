package com.groundcover.rum.core.common

import java.security.SecureRandom
import java.util.Random

/** Event, span and trace ids, as lowercase hex. */
internal interface IdGenerator {
    /** 32 hex characters: 16 zeros, then 64 random bits. */
    fun generateTraceId(): String

    /** 16 hex characters. */
    fun generateSpanId(): String

    /** 32 hex characters. */
    fun generateId(): String
}

/** Ids from a secure random source. */
internal class RandomIdGenerator(private val random: Random = SecureRandom()) : IdGenerator {
    override fun generateTraceId() = TRACE_ID_ZERO_PREFIX + hex(16)

    override fun generateSpanId() = hex(16)

    override fun generateId() = hex(32)

    // One draw per 16 characters, 4 bits each.
    private fun hex(count: Int): String {
        val characters = CharArray(count)
        for (start in 0 until count step 16) {
            var bits = random.nextLong()
            for (index in start until minOf(start + 16, count)) {
                characters[index] = DIGITS[(bits and 0xf).toInt()]
                bits = bits ushr 4
            }
        }
        return String(characters)
    }

    private companion object {
        const val DIGITS = "0123456789abcdef"
        val TRACE_ID_ZERO_PREFIX = "0".repeat(16)
    }
}
