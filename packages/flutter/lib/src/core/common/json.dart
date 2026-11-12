// JSON for what the app hands the SDK unflattened: user properties, and
// whatever an enrichEvent, beforeSend or redact hook puts back.
import 'dart:convert';

/// [value] as JSON, writing what JSON has no form for the way JSON.stringify
/// and flattenAttributes do, so one odd value never costs a whole batch: a
/// non-finite number is null, a map's keys are strings, any other iterable a
/// list, and anything else its string form. Throws only on a cycle.
String encodeJson(Object? value) =>
    jsonEncode(value, toEncodable: _jsonFallback);

Object? _jsonFallback(Object? value) => switch (value) {
  Map() => {for (final MapEntry(:key, :value) in value.entries) '$key': value},
  Iterable() => value.toList(),
  _ => jsonLeaf(value),
};

/// Anything that isn't a map or an iterable, as JSON can carry it: a
/// non-finite number is null, and anything but a JSON scalar its string form.
Object? jsonLeaf(Object? value) => switch (value) {
  null || String() || bool() || int() => value,
  double() => value.isFinite ? value : null,
  _ => '$value',
};

/// [value] as plain JSON data: maps with string keys, lists, and JSON
/// scalars, anything else as [jsonLeaf] writes it, and a cycle marked
/// `[Circular]`. For what the app hands the SDK to keep (user properties,
/// what a hook puts in an event), made once: a batch then neither copies an
/// app object to the isolate that encodes it nor fails on a cycle.
Object? toJsonData(Object? value) =>
    _toJsonData(value, Set<Object>.identity(), 0);

/// [map] as [toJsonData] makes it.
Map<String, Object?> toJsonMap(Map<Object?, Object?> map) =>
    toJsonData(map)! as Map<String, Object?>;

const _maxJsonDataDepth = 32;

Object? _toJsonData(Object? value, Set<Object> seen, int depth) {
  if (value is! Map && value is! Iterable) return jsonLeaf(value);
  if (depth >= _maxJsonDataDepth) return '[Depth Limit]';
  if (!seen.add(value!)) return '[Circular]';
  try {
    return switch (value) {
      Map() => <String, Object?>{
        for (final MapEntry(:key, :value) in value.entries)
          '$key': _toJsonData(value, seen, depth + 1),
      },
      Iterable() => [
        for (final item in value) _toJsonData(item, seen, depth + 1),
      ],
      _ => jsonLeaf(value),
    };
  } finally {
    seen.remove(value);
  }
}

/// [json] decoded, when it is a JSON object; null for anything else,
/// unreadable JSON included. For what a native side hands over.
Map<String, Object?>? decodeJsonObject(String json) {
  try {
    final decoded = jsonDecode(json);
    return decoded is Map<String, Object?> ? decoded : null;
  } catch (_) {
    return null;
  }
}

/// [value] when it is a finite JSON number. Never a numeric string: a
/// native side sends numbers, so a string means its contract already broke.
num? finiteNum(Object? value) => value is num && value.isFinite ? value : null;
