package com.groundcover.rum.core.common

/**
 * [text] cut to [maxLength] UTF-16 units, as the other SDKs count, with [ellipsis] appended when
 * cut. A cut never splits a surrogate pair. Null becomes `""`; anything else is stringified first.
 */
internal fun truncate(text: Any?, maxLength: Int = 10_000, ellipsis: String = ""): String {
    if (text == null) return ""
    val string = text as? String ?: text.toString()
    if (string.length <= maxLength) return string
    val end = if (maxLength > 0 && Character.isHighSurrogate(string[maxLength - 1])) {
        maxLength - 1
    } else {
        maxLength
    }
    return string.substring(0, end) + ellipsis
}

// JavaScript's `\s`, so a label collapses the same on every SDK. Java's `\s` is ASCII only.
private val WHITESPACE = Regex(
    "[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+"
)

/**
 * Runs of whitespace, newlines included, collapsed to one space and trimmed: a one-line label from
 * multi-line text.
 */
internal fun normalizeWhitespace(text: String?): String =
    (text ?: "").replace(WHITESPACE, " ").trim(' ')
