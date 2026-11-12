// The sensitive-data patterns and redaction helpers every capture path
// shares. The patterns are identical to groundcover's other SDKs, so every SDK
// masks the same strings.
import 'dart:convert';

import '../common/hooks.dart';
import '../common/json.dart';
import '../common/logger.dart';
import '../config/types.dart';
import 'privacy_config.dart';

const redacted = '[REDACTED]';

/// Header names always redacted, matched case-insensitively in full.
const sensitiveHeaderNames = ['authorization', 'cookie', 'set-cookie'];

/// Header names match a broader pattern than body and query keys, including
/// the bare `key` substring (x-functions-key, x-api-key, …).
final sensitiveHeaderRegex = RegExp(
  r'(token|key|secret|passwd|password|auth|bearer|credential)',
  caseSensitive: false,
);

/// Substrings that mark a key sensitive. Specific on purpose: a bare
/// `card`/`session` would hit `cardinality`/`session_id`.
final sensitiveKeyRegex = RegExp(
  r'(token|secret|passwd|password|api[_-]?key|access[_-]?key|write[_-]?key|auth|bearer|credential|cvv|ssn|credit[_-]?card|card[_-]?number)',
  caseSensitive: false,
);

/// Query and form keys sensitive on their own but too generic for the
/// substring pattern (`code`/`state` would hit `zipcode`/`statename`). Matched
/// only as whole query or form keys, never inside JSON bodies. Covers the
/// OAuth callback (`?code=…&state=…`).
const sensitiveQueryParamNames = {
  'code',
  'state',
  'session_state',
  'id_token',
  'access_token',
  'refresh_token',
  'token',
};

/// Past this depth values are redacted, so nothing below the limit leaks.
const _maxDepth = 8;

/// Above this length a body or message skips the parse-and-walk path for a
/// single text scrub, so a multi-megabyte payload can't stall the UI isolate.
const _maxBodyParseLength = 100000;

/// What every redaction entry point takes.
final class RedactOptions {
  const RedactOptions({this.sensitiveKeys = const [], this.redact, this.kind});

  final List<String> sensitiveKeys;
  final Redactor? redact;

  /// The event surface, stamped on each [RedactField] passed to [redact].
  final RedactKind? kind;

  RedactOptions withKind(RedactKind kind) =>
      RedactOptions(sensitiveKeys: sensitiveKeys, redact: redact, kind: kind);
}

/// The redaction options [EffectivePrivacy] implies, for the [kind] of
/// surface being redacted.
extension EffectivePrivacyRedaction on EffectivePrivacy {
  RedactOptions redactOptions([RedactKind? kind]) =>
      RedactOptions(sensitiveKeys: sensitiveKeys, redact: redact, kind: kind);
}

bool isSensitiveKey(String key, [List<String> extra = const []]) {
  if (key.isEmpty) return false;
  if (sensitiveKeyRegex.hasMatch(key)) return true;
  if (extra.isEmpty) return false;
  final lower = key.toLowerCase();
  return extra.any(
    (pattern) => pattern.isNotEmpty && lower.contains(pattern.toLowerCase()),
  );
}

bool _isSensitiveQueryParam(String key, List<String> extra) =>
    sensitiveQueryParamNames.contains(key.toLowerCase()) ||
    isSensitiveKey(key, extra);

// For free text only, the broad header pattern applies to hyphenated keys
// (x-functions-key, set-cookie): on plain prose it would redact
// `auth: success` or `API key: …`.
bool _isHeaderNameKey(String key) =>
    key.contains('-') && sensitiveHeaderRegex.hasMatch(key);

bool _isSensitiveTextKey(String key, List<String> extra) =>
    isSensitiveKey(key, extra) || _isHeaderNameKey(key);

bool _isSensitiveFormTextKey(String key, List<String> extra) =>
    _isSensitiveQueryParam(key, extra) || _isHeaderNameKey(key);

bool _isLeaf(Object? value) =>
    value == null || value is String || value is num || value is bool;

// One leaf: `sensitive ? [REDACTED] : value` by default. A hook may override
// it; returning null (or throwing) keeps the default, so one hook can't switch
// masking off elsewhere.
Object? _applyLeaf(RedactField field, Redactor? redact) {
  final fallback = field.sensitive ? redacted : field.value;
  if (redact == null) return fallback;
  try {
    final out = runUserHook(() => redact(field));
    return out ?? fallback;
  } catch (error) {
    handleError(error);
    return fallback;
  }
}

Map<String, String> redactHeaders(
  Map<String, String> headers, [
  RedactOptions opts = const RedactOptions(),
]) {
  return {
    for (final MapEntry(:key, :value) in headers.entries)
      key: () {
        final lower = key.toLowerCase();
        final sensitive =
            sensitiveHeaderNames.contains(lower) ||
            sensitiveHeaderRegex.hasMatch(lower) ||
            isSensitiveKey(key, opts.sensitiveKeys);
        final out = _applyLeaf(
          RedactField(
            key: key,
            value: value,
            path: [key],
            kind: RedactKind.header,
            sensitive: sensitive,
          ),
          opts.redact,
        );
        return out == null ? '' : '$out';
      }(),
  };
}

String _decode(String raw) {
  try {
    return Uri.decodeComponent(raw);
  } catch (_) {
    return raw;
  }
}

/// Redacts sensitive values in a `key=value&…` string (no leading `?`),
/// keeping order and duplicate keys.
String redactQueryString(
  String search, [
  RedactOptions opts = const RedactOptions(),
]) {
  if (search.isEmpty) return search;
  try {
    return search
        .split('&')
        .map((pair) {
          final eq = pair.indexOf('=');
          if (eq == -1) return pair;
          final rawKey = pair.substring(0, eq);
          final rawValue = pair.substring(eq + 1);
          final key = _decode(rawKey);
          final value = _decode(rawValue);
          final out = _applyLeaf(
            RedactField(
              key: key,
              value: value,
              path: [key],
              kind: opts.kind ?? RedactKind.query,
              sensitive: _isSensitiveQueryParam(key, opts.sensitiveKeys),
            ),
            opts.redact,
          );
          // Unchanged: keep the original pair, with no decode/re-encode drift.
          if (out == value) return pair;
          return '$rawKey=${Uri.encodeComponent(out == null ? '' : '$out')}';
        })
        .join('&');
  } catch (_) {
    return search;
  }
}

final _userinfo = RegExp(r'^([a-zA-Z][\w+.-]*://)[^/?#@]*@');

// Strips `user:pass@` from an absolute URL's authority, so embedded basic-auth
// never ships. An `@` in a path or query (`?email=a@b.com`) is untouched.
String _redactUserinfo(String url) =>
    url.replaceFirstMapped(_userinfo, (m) => '${m[1]}$redacted@');

String _redactUrlSegment(String segment, RedactOptions opts) {
  final queryIndex = segment.indexOf('?');
  if (queryIndex == -1) return segment;
  return '${segment.substring(0, queryIndex)}?'
      '${redactQueryString(segment.substring(queryIndex + 1), opts)}';
}

/// Redacts sensitive query parameters in a full or relative URL, including a
/// query inside the fragment (`…#/reset?token=…`), and strips userinfo.
String redactUrl(String url, [RedactOptions opts = const RedactOptions()]) {
  if (url.isEmpty) return url;
  final queryOpts = opts.withKind(opts.kind ?? RedactKind.query);
  final hashIndex = url.indexOf('#');
  final beforeHash = hashIndex == -1 ? url : url.substring(0, hashIndex);
  final fragment = hashIndex == -1 ? '' : url.substring(hashIndex + 1);
  final safeBase = _redactUrlSegment(_redactUserinfo(beforeHash), queryOpts);
  if (hashIndex == -1) return safeBase;
  return '$safeBase#${_redactUrlSegment(fragment, queryOpts)}';
}

// Walks a value, redacting leaves. Containers are recursed and never passed to
// the hook; a sensitive key whose value is a container redacts the subtree
// whole. Anything that is neither a container nor a JSON primitive is
// stringified first, so the hook only ever sees primitives.
Object? _redactValueAt(
  String key,
  Object? value,
  List<String> path,
  RedactOptions opts,
  int depth,
  Set<Object> seen,
) {
  final sensitive = key.isNotEmpty && isSensitiveKey(key, opts.sensitiveKeys);

  if (value is Map || value is List) {
    if (sensitive || depth > _maxDepth) return redacted;
    // Only a true cycle (a container inside itself) is redacted; a value
    // shared between siblings is still walked.
    if (!seen.add(value!)) return redacted;
    try {
      if (value is List) {
        return [
          for (final item in value)
            _redactValueAt(key, item, path, opts, depth + 1, seen),
        ];
      }
      return {
        for (final MapEntry(:key, :value) in (value as Map).entries)
          '$key': _redactValueAt(
            '$key',
            value,
            [...path, '$key'],
            opts,
            depth + 1,
            seen,
          ),
      };
    } catch (error) {
      handleError(error);
      return redacted;
    } finally {
      seen.remove(value);
    }
  }

  final leaf = _isLeaf(value) ? value : '$value';
  return _applyLeaf(
    RedactField(
      key: key,
      value: leaf,
      path: path,
      kind: opts.kind ?? RedactKind.log,
      sensitive: sensitive,
    ),
    opts.redact,
  );
}

final _jsonPair = RegExp(
  r'"([\w.-]{1,64})"\s*:\s*("(?:[^"\\]|\\.)*"|[^\s,}\]]+)',
);
// `?` separates too, so an embedded query (`next=/p?token=secret`) is split
// instead of swallowed whole under a harmless outer key.
final _formPair = RegExp(r'([\w.-]{1,64})=([^\s&,;?]+)');
final _colonPair = RegExp(r'([\w.-]{1,64}):([ \t]*)([^\n,;&]{1,4096})');

/// How deep the `key: value` scrub looks into a value for more pairs: a
/// printed Map nests them (`headers: {Authorization: …}`).
const _maxColonPairDepth = 8;

/// Redacts sensitive `key: value` pairs in [text]. A harmless key's value is
/// scanned again, since in Dart's `Map.toString()` (`{k: v, …}`) the pair
/// that matters sits inside a value a label before it swallowed.
String _scrubColonPairs(String text, List<String> keys, int depth) =>
    text.replaceAllMapped(_colonPair, (m) {
      final key = m[1]!;
      if (_isSensitiveTextKey(key, keys)) return '$key: $redacted';
      if (depth >= _maxColonPairDepth) return m[0]!;
      return '$key:${m[2]}${_scrubColonPairs(m[3]!, keys, depth + 1)}';
    });

/// Free-text scrub for log and error messages and non-JSON bodies: redacts the
/// value in sensitive `key=value`, `key: value` and `"key":"value"` pairs, then
/// hands the whole original string to the redact hook once. Never throws.
String redactText(String text, [RedactOptions opts = const RedactOptions()]) {
  if (text.isEmpty) return text;
  // On a very large string, scrub the head and drop the tail (fail-closed).
  if (text.length > _maxBodyParseLength) {
    return '${redactText(text.substring(0, _maxBodyParseLength), opts)}…';
  }

  // The hook sees the whole original string once; a non-null result replaces
  // the built-in scrub, which then needn't run.
  final redact = opts.redact;
  if (redact != null) {
    try {
      final result = runUserHook(
        () => redact(
          RedactField(
            key: '',
            value: text,
            path: const [],
            kind: opts.kind ?? RedactKind.log,
            sensitive: false,
          ),
        ),
      );
      if (result != null) return '$result';
    } catch (error) {
      handleError(error);
    }
  }

  final keys = opts.sensitiveKeys;
  if (!_mayHoldSensitiveKey(text, keys)) return text;
  try {
    var out = text.replaceAllMapped(
      _jsonPair,
      (m) => _isSensitiveTextKey(m[1]!, keys) ? '"${m[1]}":"$redacted"' : m[0]!,
    );
    out = out.replaceAllMapped(
      _formPair,
      (m) => _isSensitiveFormTextKey(m[1]!, keys) ? '${m[1]}=$redacted' : m[0]!,
    );
    return _scrubColonPairs(out, keys, 0);
  } catch (error) {
    handleError(error);
    return text;
  }
}

/// Every key the scrub redacts contains one of these, or one of the app's
/// [extra] keys: whole query keys (`code`, `state`, `…token`), the key and
/// header patterns (`api_key` and `x-functions-key` both hold `key`). Keys
/// are ASCII, so a text holding none of them has nothing to scrub, and skips
/// the three passes, most of what a log line costs.
final _sensitiveKeyPart = RegExp(
  'token|secret|passw|key|auth|bearer|credential|cvv|ssn|card|code|state',
  caseSensitive: false,
);

bool _mayHoldSensitiveKey(String text, List<String> extra) {
  if (_sensitiveKeyPart.hasMatch(text)) return true;
  if (extra.isEmpty) return false;
  final lower = text.toLowerCase();
  return extra.any(
    (pattern) => pattern.isNotEmpty && lower.contains(pattern.toLowerCase()),
  );
}

/// Redacts an already-stringified body: JSON deep redaction when it parses,
/// then form encoding, then the free-text scrub. Never throws.
String redactBody(String body, [RedactOptions opts = const RedactOptions()]) {
  if (body.isEmpty) return body;
  final trimmed = body.trim();
  if (trimmed.length <= _maxBodyParseLength &&
      (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    Object? parsed;
    var isJson = true;
    try {
      parsed = jsonDecode(trimmed);
    } catch (_) {
      // Not JSON after all: fall through.
      isJson = false;
    }
    if (isJson) {
      try {
        return encodeJson(
          _asJsNumbers(
            _redactValueAt('', parsed, const [], opts, 0, Set.identity()),
          ),
        );
      } catch (error) {
        // Fail closed: the text scrub below would leave values under
        // sensitive keys in place.
        handleError(error);
        return redacted;
      }
    }
  }
  if (body.contains('=') && !body.contains('{')) {
    return redactQueryString(body, opts);
  }
  return redactText(body, opts);
}

/// [value] with every whole double inside JavaScript's safe-integer range an
/// int: jsonDecode reads `1.0` as a double that jsonEncode writes back as
/// `1.0`, where JavaScript's JSON.stringify writes `1`.
Object? _asJsNumbers(Object? value) => switch (value) {
  double()
      when value.isFinite &&
          value == value.truncateToDouble() &&
          value.abs() <= 9007199254740991 =>
    value.toInt(),
  Map() => {
    for (final MapEntry(:key, :value) in value.entries)
      key: _asJsNumbers(value),
  },
  List() => [for (final item in value) _asJsNumbers(item)],
  _ => value,
};

/// Deep redaction of structured attributes (log attributes, error metadata).
/// Returns a new map and never mutates the input.
Map<String, Object?> redactObject(
  Map<String, Object?> object, [
  RedactOptions opts = const RedactOptions(),
]) {
  try {
    final result = _redactValueAt(
      '',
      object,
      const [],
      opts,
      0,
      Set.identity(),
    );
    return result is Map<String, Object?> ? result : const {};
  } catch (error) {
    // Fail closed: never throw out of redaction, never return the input.
    handleError(error);
    return const {};
  }
}

/// Caller-supplied navigation metadata as it may be sent: key-redacted while
/// masking is on, untouched under `allow`.
Map<String, Object?>? redactMetadata(
  Map<String, Object?>? metadata,
  EffectivePrivacy privacy,
) {
  if (privacy.level == PrivacyLevel.allow || metadata == null) return metadata;
  return redactObject(metadata, privacy.redactOptions());
}

/// Log-surface redaction (the free-text message and the structured
/// attributes) in one place, for captured and explicit logs alike. A no-op
/// when log masking is off.
({String message, Map<String, Object?>? attributes}) redactLogFields(
  EffectivePrivacy privacy,
  String message,
  Map<String, Object?>? attributes,
) {
  if (!privacy.shouldMaskLogs) {
    return (message: message, attributes: attributes);
  }
  final opts = privacy.redactOptions(RedactKind.log);
  return (
    message: redactText(message, opts),
    attributes: attributes == null ? null : redactObject(attributes, opts),
  );
}
