package com.groundcover.rum.core.privacy

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.RedactField
import com.groundcover.rum.RedactKind
import com.groundcover.rum.Redactor
import com.groundcover.rum.core.common.MAX_PARSE_DEPTH
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.asList
import com.groundcover.rum.core.common.handleError
import com.groundcover.rum.core.common.jsJsonNestsDeeperThan
import com.groundcover.rum.core.common.parseOrderedJson
import com.groundcover.rum.core.common.truncate
import com.groundcover.rum.core.common.writeJsJson
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Collections
import java.util.IdentityHashMap

// The sensitive-data patterns and redaction helpers every capture path shares. The patterns are
// identical to groundcover's other SDKs, so every SDK masks the same strings. JavaScript's `\w` and
// `\s` are spelled out: the JVM's `\s` is ASCII, and Android's ICU engine reads `\w` as Unicode.

internal const val REDACTED = "[REDACTED]"

private const val WORD = "A-Za-z0-9_"
private const val SPACE =
    "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

/** Header names always redacted, matched case-insensitively in full. */
internal val SENSITIVE_HEADER_NAMES = setOf("authorization", "cookie", "set-cookie")

/**
 * Header names match a broader pattern than body and query keys, including the bare `key`
 * substring (x-functions-key, x-api-key, …).
 */
internal val SENSITIVE_HEADER_REGEX =
    Regex("(token|key|secret|passwd|password|auth|bearer|credential)", RegexOption.IGNORE_CASE)

/**
 * Substrings that mark a key sensitive. Specific on purpose: a bare `card`/`session` would hit
 * `cardinality`/`session_id`.
 */
internal val SENSITIVE_KEY_REGEX = Regex(
    "(token|secret|passwd|password|api[_-]?key|access[_-]?key|write[_-]?key|auth|bearer|" +
        "credential|cvv|ssn|credit[_-]?card|card[_-]?number)",
    RegexOption.IGNORE_CASE
)

/**
 * Query and form keys sensitive on their own but too generic for the substring pattern
 * (`code`/`state` would hit `zipcode`/`statename`). Matched only as whole query or form keys,
 * never inside JSON bodies. Covers the OAuth callback (`?code=…&state=…`).
 */
internal val SENSITIVE_QUERY_PARAM_NAMES =
    setOf("code", "state", "session_state", "id_token", "access_token", "refresh_token", "token")

/** Past this depth values are redacted, so nothing below the limit leaks. */
private const val MAX_DEPTH = 8

/**
 * Above this length a body or message skips the parse-and-walk path for a single text scrub, so
 * a multi-megabyte payload can't stall the thread it runs on.
 */
private const val MAX_BODY_PARSE_LENGTH = 100_000

/** What every redaction entry point takes. */
internal data class RedactOptions(
    val sensitiveKeys: List<String> = emptyList(),
    val redact: Redactor? = null,
    /** The event surface, stamped on each [RedactField] passed to [redact]. */
    val kind: RedactKind? = null
) {
    fun withKind(kind: RedactKind) = copy(kind = kind)
}

/** The redaction options this privacy implies, for the [kind] of surface being redacted. */
internal fun EffectivePrivacy.redactOptions(kind: RedactKind? = null) =
    RedactOptions(sensitiveKeys = sensitiveKeys, redact = redact, kind = kind)

internal fun isSensitiveKey(key: String, extra: List<String> = emptyList()): Boolean {
    if (key.isEmpty()) return false
    if (SENSITIVE_KEY_REGEX.containsMatchIn(key)) return true
    if (extra.isEmpty()) return false
    val lower = key.lowercase()
    return extra.any { it.isNotEmpty() && lower.contains(it.lowercase()) }
}

private fun isSensitiveQueryParam(key: String, extra: List<String>) =
    key.lowercase() in SENSITIVE_QUERY_PARAM_NAMES || isSensitiveKey(key, extra)

// For free text only, the broad header pattern applies to hyphenated keys (x-functions-key,
// set-cookie): on plain prose it would redact `auth: success` or `API key: …`.
private fun isHeaderNameKey(key: String) =
    key.contains('-') && SENSITIVE_HEADER_REGEX.containsMatchIn(key)

private fun isSensitiveTextKey(key: String, extra: List<String>) =
    isSensitiveKey(key, extra) || isHeaderNameKey(key)

private fun isSensitiveFormTextKey(key: String, extra: List<String>) =
    isSensitiveQueryParam(key, extra) || isHeaderNameKey(key)

private fun isLeaf(value: Any?) =
    value == null || value is String || value is Number || value is Boolean

// One leaf: `sensitive ? [REDACTED] : value` by default. A hook may override it; returning null (or
// throwing) keeps the default, so one hook can't switch masking off elsewhere.
private fun applyLeaf(field: RedactField, redact: Redactor?): Any? {
    val fallback = if (field.sensitive) REDACTED else field.value
    if (redact == null) return fallback
    return try {
        UserHook.run { redact.redact(field) } ?: fallback
    } catch (error: Exception) {
        handleError(error)
        fallback
    }
}

internal fun redactHeaders(
    headers: Map<String, String>,
    opts: RedactOptions = RedactOptions()
): Map<String, String> = headers.entries.associate { (key, value) ->
    val lower = key.lowercase()
    val sensitive = lower in SENSITIVE_HEADER_NAMES ||
        SENSITIVE_HEADER_REGEX.containsMatchIn(lower) ||
        isSensitiveKey(key, opts.sensitiveKeys)
    val out = applyLeaf(
        RedactField(key, value, listOf(key), RedactKind.HEADER, sensitive),
        opts.redact
    )
    key to (out?.toString() ?: "")
}

/**
 * Redacts sensitive values in a `key=value&…` string (no leading `?`), keeping order and duplicate
 * keys.
 */
internal fun redactQueryString(search: String, opts: RedactOptions = RedactOptions()): String {
    if (search.isEmpty()) return search
    return try {
        search.split("&").joinToString("&") { pair ->
            val eq = pair.indexOf('=')
            if (eq == -1) return@joinToString pair
            val rawKey = pair.substring(0, eq)
            val rawValue = pair.substring(eq + 1)
            val key = decodeComponent(rawKey)
            val value = decodeComponent(rawValue)
            val out = applyLeaf(
                RedactField(
                    key,
                    value,
                    listOf(key),
                    opts.kind ?: RedactKind.QUERY,
                    isSensitiveQueryParam(key, opts.sensitiveKeys)
                ),
                opts.redact
            )
            // Unchanged: keep the original pair, with no decode and encode drift.
            if (out == value) pair else "$rawKey=${encodeURIComponent(out?.toString() ?: "")}"
        }
    } catch (error: Exception) {
        search
    }
}

// decodeURIComponent: percent escapes as UTF-8, `+` left alone; a malformed one keeps the text.
private fun decodeComponent(raw: String): String {
    if (!raw.contains('%')) return raw
    return try {
        val out = StringBuilder()
        val bytes = ByteArrayOutputStream()
        var index = 0
        fun flush() {
            if (bytes.size() == 0) return
            val decoder = Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
            out.append(decoder.decode(ByteBuffer.wrap(bytes.toByteArray())))
            bytes.reset()
        }
        while (index < raw.length) {
            val char = raw[index]
            if (char == '%') {
                require(index + 2 < raw.length)
                val high = hexValue(raw[index + 1])
                val low = hexValue(raw[index + 2])
                require(high >= 0 && low >= 0)
                bytes.write(high * 16 + low)
                index += 3
            } else {
                flush()
                out.append(char)
                index++
            }
        }
        flush()
        out.toString()
    } catch (error: Exception) {
        raw
    }
}

private fun hexValue(char: Char) = when (char) {
    in '0'..'9' -> char - '0'
    in 'a'..'f' -> char - 'a' + 10
    in 'A'..'F' -> char - 'A' + 10
    else -> -1
}

private const val URI_UNRESERVED =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

// encodeURIComponent: everything but the unreserved characters, as UTF-8 percent escapes.
private fun encodeURIComponent(value: String): String {
    val out = StringBuilder()
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val code = byte.toInt() and 0xff
        if (code < 0x80 && URI_UNRESERVED.indexOf(code.toChar()) >= 0) {
            out.append(code.toChar())
        } else {
            out.append('%').append("0123456789ABCDEF"[code shr 4]).append(
                "0123456789ABCDEF"[
                    code and
                        0xf
                ]
            )
        }
    }
    return out.toString()
}

private val USERINFO = Regex("^([a-zA-Z][$WORD+.-]*://)[^/?#@]*@")

// Strips `user:pass@` from an absolute URL's authority, so embedded basic-auth never ships. An `@`
// in a path or query (`?email=a@b.com`) is untouched.
private fun redactUserinfo(url: String): String {
    val match = USERINFO.find(url) ?: return url
    return match.groupValues[1] + REDACTED + "@" + url.substring(match.range.last + 1)
}

private fun redactUrlSegment(segment: String, opts: RedactOptions): String {
    val queryIndex = segment.indexOf('?')
    if (queryIndex == -1) return segment
    return segment.substring(0, queryIndex) + "?" +
        redactQueryString(segment.substring(queryIndex + 1), opts)
}

/**
 * Redacts sensitive query parameters in a full or relative URL, including a query inside the
 * fragment (`…#/reset?token=…`), and strips userinfo.
 */
internal fun redactUrl(url: String, opts: RedactOptions = RedactOptions()): String {
    if (url.isEmpty()) return url
    val queryOpts = opts.withKind(opts.kind ?: RedactKind.QUERY)
    val hashIndex = url.indexOf('#')
    val beforeHash = if (hashIndex == -1) url else url.substring(0, hashIndex)
    val safeBase = redactUrlSegment(redactUserinfo(beforeHash), queryOpts)
    if (hashIndex == -1) return safeBase
    return safeBase + "#" + redactUrlSegment(url.substring(hashIndex + 1), queryOpts)
}

private fun newSeenSet(): MutableSet<Any> = Collections.newSetFromMap(IdentityHashMap())

// Walks a value, redacting leaves. Containers (maps, and any collection or array, walked as a
// list, as the enricher flattens them) are recursed and never passed to the hook; a
// sensitive key whose value is a container redacts the subtree whole. Anything that is neither a
// container nor a JSON primitive is stringified first, so the hook only ever sees primitives, and
// gets the text scrub, since an object (a data class, say) prints its own `key=value` pairs.
private fun redactValueAt(
    key: String,
    value: Any?,
    path: List<String>,
    opts: RedactOptions,
    depth: Int,
    seen: MutableSet<Any>
): Any? {
    val sensitive = key.isNotEmpty() && isSensitiveKey(key, opts.sensitiveKeys)

    val items = if (value is Map<*, *>) null else asList(value)
    if (value is Map<*, *> || items != null) {
        if (sensitive || depth > MAX_DEPTH) return REDACTED
        // Only a true cycle (a container inside itself) is redacted; a value shared between
        // siblings is still walked.
        if (!seen.add(value!!)) return REDACTED
        return try {
            if (items != null) {
                items.map { redactValueAt(key, it, path, opts, depth + 1, seen) }
            } else {
                LinkedHashMap<String, Any?>().apply {
                    for ((childKey, child) in value as Map<*, *>) {
                        val name = childKey.toString()
                        put(name, redactValueAt(name, child, path + name, opts, depth + 1, seen))
                    }
                }
            }
        } catch (error: Exception) {
            handleError(error)
            REDACTED
        } finally {
            seen.remove(value)
        }
    }

    // The hook sees the scrubbed string once, as this leaf, not a second time as free text.
    val leaf = if (isLeaf(value)) value else redactText(value.toString(), opts.copy(redact = null))
    return applyLeaf(
        RedactField(key, leaf, path, opts.kind ?: RedactKind.LOG, sensitive),
        opts.redact
    )
}

// The quoted value is the unrolled form of JavaScript's `"(?:[^"\\]|\\.)*"`, which matches the
// same strings: the JVM's engine recurses once per character through the alternation, and a
// 100 KB value would overflow the stack.
private val JSON_PAIR = Regex(
    "\"([$WORD.-]{1,64})\"[$SPACE]*:[$SPACE]*" +
        "(\"[^\"\\\\]*(?:\\\\.[^\"\\\\]*)*\"|[^$SPACE,}\\]]+)"
)

// `?` separates too, so an embedded query (`next=/p?token=secret`) is split instead of swallowed
// whole under a harmless outer key.
private val FORM_PAIR = Regex("([$WORD.-]{1,64})=([^$SPACE&,;?]+)")
private val COLON_PAIR = Regex("([$WORD.-]{1,64}):([ \\t]*)([^\\n,;&]{1,4096})")

/**
 * How deep the `key: value` scrub looks into a value for more pairs: a printed map nests them
 * (`headers: {Authorization: …}`).
 */
private const val MAX_COLON_PAIR_DEPTH = 8

/**
 * Redacts sensitive `key: value` pairs in [text]. A harmless key's value is scanned again, since in
 * a printed map (`{k: v, …}`) the pair that matters sits inside a value a label before it
 * swallowed.
 */
private fun scrubColonPairs(text: String, keys: List<String>, depth: Int): String =
    COLON_PAIR.replace(text) { match ->
        val key = match.groupValues[1]
        when {
            isSensitiveTextKey(key, keys) -> "$key: $REDACTED"

            depth >= MAX_COLON_PAIR_DEPTH -> match.value

            else ->
                "$key:${match.groupValues[2]}" +
                    scrubColonPairs(match.groupValues[3], keys, depth + 1)
        }
    }

/**
 * Free-text scrub for log and error messages and non-JSON bodies: redacts the value in sensitive
 * `key=value`, `key: value` and `"key":"value"` pairs, then hands the whole original string to the
 * redact hook once. Never throws.
 */
internal fun redactText(text: String, opts: RedactOptions = RedactOptions()): String {
    if (text.isEmpty()) return text
    // On a very large string, scrub the head and drop the tail (fail-closed).
    if (text.length > MAX_BODY_PARSE_LENGTH) {
        return redactText(truncate(text, MAX_BODY_PARSE_LENGTH), opts) + "…"
    }

    // The hook sees the whole original string once; a non-null result replaces the built-in
    // scrub, which then needn't run.
    val redact = opts.redact
    if (redact != null) {
        try {
            val result = UserHook.run {
                redact.redact(
                    RedactField("", text, emptyList(), opts.kind ?: RedactKind.LOG, false)
                )
            }
            if (result != null) return result.toString()
        } catch (error: Exception) {
            handleError(error)
        }
    }

    val keys = opts.sensitiveKeys
    if (!mayHoldSensitiveKey(text, keys)) return text
    return try {
        var out = JSON_PAIR.replace(text) { match ->
            val key = match.groupValues[1]
            if (isSensitiveTextKey(key, keys)) "\"$key\":\"$REDACTED\"" else match.value
        }
        out = FORM_PAIR.replace(out) { match ->
            val key = match.groupValues[1]
            if (isSensitiveFormTextKey(key, keys)) "$key=$REDACTED" else match.value
        }
        scrubColonPairs(out, keys, 0)
    } catch (error: Exception) {
        handleError(error)
        text
    } catch (error: StackOverflowError) {
        // A value of tens of thousands of escapes still recurses once per escape. Fail closed:
        // the text can't be scrubbed, so none of it is sent.
        REDACTED
    }
}

/**
 * Every key the scrub redacts contains one of these, or one of the app's extra keys: whole query
 * keys (`code`, `state`, `…token`), the key and header patterns (`api_key` and `x-functions-key`
 * both hold `key`). Keys are ASCII, so a text holding none of them has nothing to scrub, and skips
 * the three passes, most of what a log line costs.
 */
private val SENSITIVE_KEY_PART = Regex(
    "token|secret|passw|key|auth|bearer|credential|cvv|ssn|card|code|state",
    RegexOption.IGNORE_CASE
)

private fun mayHoldSensitiveKey(text: String, extra: List<String>): Boolean {
    if (SENSITIVE_KEY_PART.containsMatchIn(text)) return true
    if (extra.isEmpty()) return false
    val lower = text.lowercase()
    return extra.any { it.isNotEmpty() && lower.contains(it.lowercase()) }
}

/**
 * Redacts an already-stringified body: JSON deep redaction when it parses, then form encoding,
 * then the free-text scrub. JSON is written back as JSON.stringify writes it. Never throws.
 */
internal fun redactBody(body: String, opts: RedactOptions = RedactOptions()): String {
    if (body.isEmpty()) return body
    val trimmed = body.trim()
    if (trimmed.length <= MAX_BODY_PARSE_LENGTH &&
        (trimmed.startsWith("{") || trimmed.startsWith("["))
    ) {
        val parsed = try {
            Parsed(parseOrderedJson(trimmed))
        } catch (error: IllegalArgumentException) {
            // Too deep to read, and the text scrub would run the nested pairs together under a
            // harmless key, so it fails closed. Anything else isn't JSON after all: fall through.
            if (jsJsonNestsDeeperThan(trimmed, MAX_PARSE_DEPTH)) return REDACTED
            null
        }
        if (parsed != null) {
            return try {
                writeJsJson(redactValueAt("", parsed.value, emptyList(), opts, 0, newSeenSet()))
            } catch (error: Exception) {
                // Fail closed: the text scrub below would leave values under sensitive keys in
                // place.
                handleError(error)
                REDACTED
            }
        }
    }
    if (body.contains('=') && !body.contains('{')) return redactQueryString(body, opts)
    return redactText(body, opts)
}

private class Parsed(val value: Any?)

/**
 * Deep redaction of structured attributes (log attributes, error metadata). Returns a new map and
 * never mutates the input.
 */
internal fun redactObject(
    obj: Map<String, Any?>,
    opts: RedactOptions = RedactOptions()
): Map<String, Any?> = try {
    @Suppress("UNCHECKED_CAST")
    redactValueAt("", obj, emptyList(), opts, 0, newSeenSet()) as? Map<String, Any?> ?: emptyMap()
} catch (error: Exception) {
    // Fail closed: never throw out of redaction, never return the input.
    handleError(error)
    emptyMap()
}

/**
 * Caller-supplied metadata as it may be sent: key-redacted while masking is on, untouched under
 * `allow`.
 */
internal fun redactMetadata(
    metadata: Map<String, Any?>?,
    privacy: EffectivePrivacy
): Map<String, Any?>? {
    if (privacy.level == PrivacyLevel.ALLOW || metadata == null) return metadata
    return redactObject(metadata, privacy.redactOptions())
}

/** A log line's message and attributes, as they may be sent. */
internal class RedactedLog(val message: String, val attributes: Map<String, Any?>?)

/**
 * Log-surface redaction (the free-text message and the structured attributes) in one place, for
 * captured and explicit logs alike. A no-op when log masking is off.
 */
internal fun redactLogFields(
    privacy: EffectivePrivacy,
    message: String,
    attributes: Map<String, Any?>?
): RedactedLog {
    if (!privacy.shouldMaskLogs) return RedactedLog(message, attributes)
    val opts = privacy.redactOptions(RedactKind.LOG)
    return RedactedLog(redactText(message, opts), attributes?.let { redactObject(it, opts) })
}
