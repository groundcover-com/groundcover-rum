// Request/response body classification and capping, shared by every
// platform's network capture.
// Reading a body stays with the platform; deciding WHETHER to read it, and
// what a body that can't be kept becomes, lives here so every platform emits
// the same placeholders for the same payloads.
import 'dart:convert';

/// Emitted in place of a body that redaction can't safely handle (binary,
/// oversized, or partial). A truncated prefix would break redactBody, so a
/// body is either complete or a placeholder, never cut.
abstract final class BodyPlaceholder {
  static const requestTooLarge = '[request body too large]';
  static const requestUnavailable = '[request body unavailable]';
  static const responseTooLarge = '[response body too large]';
  static const responseUnavailable = '[response body unavailable]';
  static const responseUnreadable = '[unreadable response body]';
  static const formData = '[form data]';
  static const binary = '[binary data]';
}

/// The bodies kept, in UTF-8 bytes: RN's `maxBodyLength`.
const maxNetworkBodyBytes = 5000;

/// MIME essence: the type without parameters, lowercased.
String mimeEssence(String contentType) =>
    contentType.split(';').first.trim().toLowerCase();

final _structuredSyntax = RegExp(r'^application/([\w.-]+\+)?(json|xml)$');

/// Whether a content type is text. Precise rules, not substrings: a
/// `contains('xml')` would pass xlsx and docx. Absent or opaque is not text.
bool isTextualContentType(String contentType) {
  final mime = mimeEssence(contentType);
  if (mime.isEmpty) return false;
  if (mime.startsWith('text/')) return true;
  if (mime == 'application/x-www-form-urlencoded' ||
      mime == 'application/javascript' ||
      mime == 'application/ecmascript' ||
      mime == 'application/graphql') {
    return true;
  }
  return _structuredSyntax.hasMatch(mime);
}

/// A fail-closed label for a non-textual content type. Never decoded.
String binaryLabel(String contentType) {
  final mime = mimeEssence(contentType);
  if (mime.startsWith('image/')) return '[image data]';
  if (mime.startsWith('audio/')) return '[audio data]';
  if (mime.startsWith('video/')) return '[video data]';
  if (mime.startsWith('font/') ||
      mime.startsWith('application/font') ||
      mime == 'application/vnd.ms-fontobject') {
    return '[font data]';
  }
  if (mime == 'application/pdf') return '[pdf data]';
  if (const {
    'application/zip',
    'application/gzip',
    'application/x-gzip',
    'application/x-tar',
    'application/x-7z-compressed',
    'application/x-rar-compressed',
  }.contains(mime)) {
    return '[archive data]';
  }
  if (mime == 'application/wasm') return '[wasm data]';
  if (mime.contains('protobuf') || mime.startsWith('application/grpc')) {
    return '[protobuf data]';
  }
  return BodyPlaceholder.binary;
}

/// The read gate for a non-empty body: multipart or non-textual gives the
/// placeholder to record without reading it; textual gives null (read it,
/// capped). A caller that knows the body is empty records "" first.
String? classifyBody(String contentType) {
  final ct = contentType.toLowerCase();
  if (ct.contains('multipart/form-data')) return BodyPlaceholder.formData;
  if (!isTextualContentType(ct)) return binaryLabel(ct);
  return null;
}

/// Whether a response has no body, known without touching it: a HEAD, a
/// null-body status, or `content-length: 0`.
bool isKnownEmptyResponse({
  required String method,
  required int status,
  required Map<String, String> headers,
}) {
  if (method.toUpperCase() == 'HEAD') return true;
  if (status == 204 || status == 205 || status == 304) return true;
  return (headers['content-length'] ?? '').trim() == '0';
}

/// A server-sent-events stream never closes, so its body is never read.
bool isEventStream(String contentType) =>
    mimeEssence(contentType) == 'text/event-stream';

/// A body, or its too-large placeholder at or over the cap, in UTF-8 bytes.
String capBody(String text, int maxBytes, String tooLargePlaceholder) {
  if (text.isEmpty) return text;
  if (text.length >= maxBytes) return tooLargePlaceholder;
  if (utf8.encode(text).length >= maxBytes) return tooLargePlaceholder;
  return text;
}
