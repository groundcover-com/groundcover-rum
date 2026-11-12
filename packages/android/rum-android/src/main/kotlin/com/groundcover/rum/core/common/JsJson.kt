package com.groundcover.rum.core.common

import java.math.BigDecimal

// JSON for a request or response body redaction rewrites: read strictly, keeping each object's key
// order, and written back as JavaScript's JSON.stringify writes it, so a redacted body reads the
// same from every SDK. org.json can't do either: it reads leniently (`{a: b}` would pass as
// JSON) and writes `/` as `\/`.

// Past this, a body isn't read: deeper nesting would only exhaust the stack, and the same limit as
// iOS keeps the two twins redacting one body alike.
internal const val MAX_PARSE_DEPTH = 64

// JavaScript's Number.MAX_SAFE_INTEGER: up to here a whole double is written as an integer.
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

/**
 * [text] parsed as strict JSON: objects as insertion-ordered maps, arrays as lists, an integer
 * that fits as a Long, any other number as a Double. Throws [IllegalArgumentException] on anything
 * that isn't one JSON value.
 */
internal fun parseOrderedJson(text: String): Any? = JsonReader(text).readDocument()

/**
 * [value] as JSON.stringify writes it: keys in the map's order, `/` and non-ASCII unescaped, a
 * whole number within JavaScript's safe range without a fraction, a non-finite number as null,
 * and anything that isn't JSON data as its string form.
 */
internal fun writeJsJson(value: Any?): String =
    StringBuilder().also { it.writeJs(value) }.toString()

private fun StringBuilder.writeJs(value: Any?) {
    when (value) {
        null -> append("null")

        is String -> writeJsString(value)

        is Boolean -> append(value)

        is Int, is Long, is Short, is Byte -> append(value.toString())

        is Number -> append(jsNumber(value.toDouble()))

        is Map<*, *> -> {
            append('{')
            var first = true
            for ((key, child) in value) {
                if (!first) append(',')
                first = false
                writeJsString(key.toString())
                append(':')
                writeJs(child)
            }
            append('}')
        }

        is Iterable<*> -> writeJsArray(value.toList())

        is Array<*> -> writeJsArray(value.toList())

        else -> writeJsString(value.toString())
    }
}

private fun StringBuilder.writeJsArray(items: List<*>) {
    append('[')
    items.forEachIndexed { index, item ->
        if (index > 0) append(',')
        writeJs(item)
    }
    append(']')
}

private fun StringBuilder.writeJsString(value: String) {
    append('"')
    for ((index, char) in value.withIndex()) {
        when {
            char == '"' -> append("\\\"")
            char == '\\' -> append("\\\\")
            char == '\b' -> append("\\b")
            char == '\u000C' -> append("\\f")
            char == '\n' -> append("\\n")
            char == '\r' -> append("\\r")
            char == '\t' -> append("\\t")
            char < ' ' || isLoneSurrogate(value, index) -> append("\\u%04x".format(char.code))
            else -> append(char)
        }
    }
    append('"')
}

private fun isLoneSurrogate(value: String, index: Int): Boolean {
    val char = value[index]
    return when {
        char.isHighSurrogate() -> index + 1 >= value.length || !value[index + 1].isLowSurrogate()
        char.isLowSurrogate() -> index == 0 || !value[index - 1].isHighSurrogate()
        else -> false
    }
}

/** A number as JavaScript's Number#toString writes it. */
internal fun jsNumber(value: Double): String {
    if (!value.isFinite()) return "null"
    if (value == Math.rint(value) && kotlin.math.abs(value) <= MAX_SAFE_INTEGER) {
        return value.toLong().toString()
    }
    if (value < 0) return "-" + jsNumber(-value)
    // The shortest digits that read back as this double, and n, the exponent such that the value
    // is 0.digits × 10^n, as ECMAScript's Number::toString defines them.
    val decimal = BigDecimal(value.toString()).stripTrailingZeros()
    val digits = decimal.unscaledValue().toString()
    val k = digits.length
    val n = k - decimal.scale()
    return when {
        n in k..21 -> digits + "0".repeat(n - k)

        n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)

        n in -5..0 -> "0." + "0".repeat(-n) + digits

        else -> {
            val exponent = n - 1
            val sign = if (exponent >= 0) "+" else "-"
            val mantissa = if (k == 1) digits else digits[0] + "." + digits.substring(1)
            "${mantissa}e$sign${kotlin.math.abs(exponent)}"
        }
    }
}

/**
 * Whether [text] opens more than [limit] objects or arrays at once, counting `{` and `[` outside
 * strings: why a parse of it gave up, read in one pass without the stack a parse needs.
 */
internal fun jsJsonNestsDeeperThan(text: String, limit: Int): Boolean {
    var depth = 0
    var inString = false
    var escaped = false
    for (char in text) {
        if (inString) {
            when {
                escaped -> escaped = false
                char == '\\' -> escaped = true
                char == '"' -> inString = false
            }
        } else {
            when (char) {
                '"' -> inString = true
                '{', '[' -> if (++depth > limit) return true
                '}', ']' -> depth--
            }
        }
    }
    return false
}

private class JsonReader(private val text: String) {
    private var position = 0

    fun readDocument(): Any? {
        skipWhitespace()
        val value = readValue(0)
        skipWhitespace()
        require(position == text.length) { "trailing content at $position" }
        return value
    }

    private fun readValue(depth: Int): Any? {
        require(depth <= MAX_PARSE_DEPTH) { "nested too deep" }
        require(position < text.length) { "unexpected end" }
        return when (text[position]) {
            '{' -> readObject(depth)
            '[' -> readArray(depth)
            '"' -> readString()
            't' -> readLiteral("true", true)
            'f' -> readLiteral("false", false)
            'n' -> readLiteral("null", null)
            else -> readNumber()
        }
    }

    private fun readObject(depth: Int): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        position++
        skipWhitespace()
        if (peek() == '}') {
            position++
            return out
        }
        while (true) {
            skipWhitespace()
            require(peek() == '"') { "expected a key at $position" }
            val key = readString()
            skipWhitespace()
            expect(':')
            skipWhitespace()
            out[key] = readValue(depth + 1)
            skipWhitespace()
            when (next()) {
                ',' -> continue
                '}' -> return out
                else -> throw IllegalArgumentException("expected , or } at $position")
            }
        }
    }

    private fun readArray(depth: Int): List<Any?> {
        val out = ArrayList<Any?>()
        position++
        skipWhitespace()
        if (peek() == ']') {
            position++
            return out
        }
        while (true) {
            skipWhitespace()
            out.add(readValue(depth + 1))
            skipWhitespace()
            when (next()) {
                ',' -> continue
                ']' -> return out
                else -> throw IllegalArgumentException("expected , or ] at $position")
            }
        }
    }

    private fun readString(): String {
        expect('"')
        val out = StringBuilder()
        while (true) {
            val char = next()
            when {
                char == '"' -> return out.toString()
                char == '\\' -> out.append(readEscape())
                char < ' ' -> throw IllegalArgumentException("control character in a string")
                else -> out.append(char)
            }
        }
    }

    private fun readEscape(): Char = when (val char = next()) {
        '"', '\\', '/' -> char

        'b' -> '\b'

        'f' -> '\u000C'

        'n' -> '\n'

        'r' -> '\r'

        't' -> '\t'

        'u' -> {
            require(position + 4 <= text.length) { "short \\u escape" }
            val hex = text.substring(position, position + 4)
            position += 4
            hex.toIntOrNull(16)?.toChar() ?: throw IllegalArgumentException("bad \\u escape")
        }

        else -> throw IllegalArgumentException("bad escape \\$char")
    }

    private fun readLiteral(word: String, value: Any?): Any? {
        require(text.startsWith(word, position)) { "bad literal at $position" }
        position += word.length
        return value
    }

    private fun readNumber(): Any {
        val start = position
        if (peek() == '-') position++
        if (peek() == '0') {
            position++
        } else {
            requireDigits()
        }
        var isInteger = true
        if (peek() == '.') {
            isInteger = false
            position++
            requireDigits()
        }
        if (peek() == 'e' || peek() == 'E') {
            isInteger = false
            position++
            if (peek() == '+' || peek() == '-') position++
            requireDigits()
        }
        val literal = text.substring(start, position)
        return (if (isInteger) literal.toLongOrNull() else null) ?: literal.toDouble()
    }

    private fun requireDigits() {
        val start = position
        while (peek()?.isAsciiDigit() == true) position++
        require(position > start) { "expected a digit at $start" }
    }

    private fun Char.isAsciiDigit() = this in '0'..'9'

    private fun skipWhitespace() {
        while (peek() == ' ' || peek() == '\t' || peek() == '\n' || peek() == '\r') position++
    }

    private fun peek(): Char? = text.getOrNull(position)

    private fun next(): Char {
        require(position < text.length) { "unexpected end" }
        return text[position++]
    }

    private fun expect(char: Char) {
        require(next() == char) { "expected $char at ${position - 1}" }
    }
}
