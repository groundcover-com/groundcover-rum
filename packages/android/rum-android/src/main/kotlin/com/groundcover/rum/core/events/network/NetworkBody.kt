package com.groundcover.rum.core.events.network

// Request and response body classification and capping, shared by every capture path. Reading a
// body stays with the interceptor; deciding WHETHER to read it, and what a body that can't be kept
// becomes, lives here so every SDK emits the same placeholders for the same payloads.

/**
 * Emitted in place of a body that redaction can't safely handle (binary, oversized, or partial). A
 * truncated prefix would break redactBody, so a body is either complete or a placeholder, never
 * cut.
 */
internal object BodyPlaceholder {
    const val REQUEST_TOO_LARGE = "[request body too large]"
    const val REQUEST_UNAVAILABLE = "[request body unavailable]"
    const val RESPONSE_TOO_LARGE = "[response body too large]"
    const val RESPONSE_UNAVAILABLE = "[response body unavailable]"
    const val RESPONSE_UNREADABLE = "[unreadable response body]"
    const val FORM_DATA = "[form data]"
    const val BINARY = "[binary data]"
}

/** The bodies kept, in UTF-8 bytes: RN's `maxBodyLength`. */
internal const val MAX_NETWORK_BODY_BYTES = 5000

/** MIME essence: the type without parameters, lowercased. */
internal fun mimeEssence(contentType: String) = contentType.substringBefore(';').trim().lowercase()

private val STRUCTURED_SYNTAX = Regex("^application/([A-Za-z0-9_.-]+\\+)?(json|xml)$")

private val ARCHIVE_TYPES = setOf(
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/x-rar-compressed"
)

/**
 * Whether a content type is text. Precise rules, not substrings: a `contains("xml")` would pass
 * xlsx and docx. Absent or opaque is not text.
 */
internal fun isTextualContentType(contentType: String): Boolean {
    val mime = mimeEssence(contentType)
    if (mime.isEmpty()) return false
    if (mime.startsWith("text/")) return true
    if (mime == "application/x-www-form-urlencoded" ||
        mime == "application/javascript" ||
        mime == "application/ecmascript" ||
        mime == "application/graphql"
    ) {
        return true
    }
    return STRUCTURED_SYNTAX.matches(mime)
}

/** A fail-closed label for a non-textual content type. Never decoded. */
internal fun binaryLabel(contentType: String): String {
    val mime = mimeEssence(contentType)
    return when {
        mime.startsWith("image/") -> "[image data]"

        mime.startsWith("audio/") -> "[audio data]"

        mime.startsWith("video/") -> "[video data]"

        mime.startsWith("font/") || mime.startsWith("application/font") ||
            mime == "application/vnd.ms-fontobject" -> "[font data]"

        mime == "application/pdf" -> "[pdf data]"

        mime in ARCHIVE_TYPES -> "[archive data]"

        mime == "application/wasm" -> "[wasm data]"

        mime.contains("protobuf") || mime.startsWith("application/grpc") -> "[protobuf data]"

        else -> BodyPlaceholder.BINARY
    }
}

/**
 * The read gate for a non-empty body: multipart or non-textual gives the placeholder to record
 * without reading it; textual gives null (read it, capped). A caller that knows the body is empty
 * records "" first.
 */
internal fun classifyBody(contentType: String): String? {
    val lower = contentType.lowercase()
    if (lower.contains("multipart/form-data")) return BodyPlaceholder.FORM_DATA
    if (!isTextualContentType(lower)) return binaryLabel(lower)
    return null
}

/**
 * Whether a response has no body, known without touching it: a HEAD, a null-body status, or
 * `content-length: 0`.
 */
internal fun isKnownEmptyResponse(
    method: String,
    status: Int,
    headers: Map<String, String>
): Boolean {
    if (method.uppercase() == "HEAD") return true
    if (status == 204 || status == 205 || status == 304) return true
    return (headers["content-length"] ?: "").trim() == "0"
}

/** A server-sent-events stream never closes, so its body is never read. */
internal fun isEventStream(contentType: String) = mimeEssence(contentType) == "text/event-stream"

/** A body, or its too-large placeholder at or over the cap, in UTF-8 bytes. */
internal fun capBody(text: String, maxBytes: Int, tooLargePlaceholder: String): String {
    if (text.isEmpty()) return text
    if (text.length >= maxBytes) return tooLargePlaceholder
    if (text.toByteArray(Charsets.UTF_8).size >= maxBytes) return tooLargePlaceholder
    return text
}
