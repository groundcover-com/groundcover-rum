import '../common/ids.dart';
import '../common/json.dart';
import '../common/logger.dart';
import '../common/time.dart';
import 'rum_event.dart';

/// A caller-supplied occurrence time (ns), or [fallback] when it is not
/// usable. 0 is a legitimate value; a negative one is not.
int _validTimestamp(int? supplied, int fallback) =>
    supplied != null && supplied >= 0 ? supplied : fallback;

const _maxFormatDepth = 10;

/// What [EventEnricher.enrich] takes. One shaper per captured signal builds
/// it; the enricher adds ids, a timestamp and the platform's attributes.
final class EnrichInput {
  const EnrichInput({
    required this.type,
    this.attributes = const {},
    this.timestamp,
    this.endTimestamp,
    this.spanName,
    this.traceId,
    this.spanId,
  });

  final String type;
  final Map<String, Object?> attributes;

  /// When it happened (ns), or null for now; a network event's start.
  final int? timestamp;

  /// A network event's end (ns).
  final int? endTimestamp;
  final String? spanName;
  final String? traceId;
  final String? spanId;
}

/// Turns a built event into a wire event: ids, a timestamp, dot-flattened
/// attributes, and the platform's own attributes (the current screen) merged
/// last, so they win over a user attribute of the same name.
final class EventEnricher {
  EventEnricher({
    required IdGenerator idGenerator,
    required this._clock,
    this._platformAttributes,
    this.reservedAttributeKeys = const [],
  }) : _ids = idGenerator;

  final IdGenerator _ids;
  final Clock _clock;
  final Map<String, Object?> Function()? _platformAttributes;

  /// The keys [_platformAttributes] stamps. Paths that merge free-form user
  /// attributes into an event strip these first.
  final List<String> reservedAttributeKeys;

  Map<String, Object?> _platform() {
    final contributor = _platformAttributes;
    if (contributor == null) return const {};
    try {
      return contributor();
    } catch (error) {
      RumDiagnostics.instance.log(
        '[event-enricher] platform attribute contributor threw; continuing without it',
        error,
      );
      return const {};
    }
  }

  RumEvent enrich(EnrichInput input) {
    final now = msToNs(_clock());
    final EnrichInput(:type, :spanId, :traceId, :spanName) = input;
    final event = RumEvent(
      type: type,
      id: _ids.generateId(),
      spanId: (spanId == null || spanId.isEmpty)
          ? _ids.generateSpanId()
          : spanId,
      traceId: (traceId == null || traceId.isEmpty)
          ? _ids.generateTraceId()
          : traceId,
      parentSpanId: '',
      spanName: (spanName == null || spanName.isEmpty) ? null : spanName,
      attributes: {...flattenAttributes(input.attributes), ..._platform()},
    );
    if (type == 'network') {
      event.startTimestamp = _validTimestamp(input.timestamp, now);
      event.endTimestamp = input.endTimestamp;
    } else {
      event.timestamp = _validTimestamp(input.timestamp, now);
    }
    return event;
  }
}

/// Dot-flattens nested maps (`{a: {b: 1}}` to `{'a.b': 1}`). A list keeps its
/// place, and each map inside it is flattened under `key[index]`, which is the
/// shape the wire's stack traces take; any other iterable is a list. Values
/// JSON cannot carry are made safe here, once, by [jsonLeaf]: a non-finite
/// number becomes null (as JSON.stringify does), and any other object its
/// string form.
Map<String, Object?> flattenAttributes(
  Map<Object?, Object?> object, [
  String prefix = '',
  Set<Object>? visited,
  int depth = 0,
]) {
  final seen = visited ?? Set<Object>.identity();
  if (depth >= _maxFormatDepth) {
    return {prefix.isEmpty ? 'depth_limit' : prefix: '[Depth Limit]'};
  }
  if (!seen.add(object)) {
    return {prefix.isEmpty ? 'circular_reference' : prefix: '[Circular]'};
  }
  try {
    final out = <String, Object?>{};
    for (final MapEntry(:key, :value) in object.entries) {
      final newKey = prefix.isEmpty ? '$key' : '$prefix.$key';
      if (value is Map) {
        out.addAll(flattenAttributes(value, newKey, seen, depth + 1));
      } else if (value is Iterable) {
        out[newKey] = _flattenList(_asList(value), newKey, seen, depth);
      } else {
        out[newKey] = jsonLeaf(value);
      }
    }
    return out;
  } catch (error) {
    RumDiagnostics.instance.log(
      '[event-enricher.flattenAttributes] Error formatting event object',
      error,
    );
    return {
      prefix.isEmpty ? 'format_error' : prefix: '[Error formatting object]',
    };
  } finally {
    seen.remove(object);
  }
}

/// A list's items, each map among them flattened under `key[index]`. The list
/// itself joins [seen]: a nested list is walked through `asMap()`, a new
/// object every time, which would never be seen twice.
Object? _flattenList(
  List<Object?> list,
  String key,
  Set<Object> seen,
  int depth,
) {
  if (!seen.add(list)) return '[Circular]';
  try {
    return [
      for (final (i, item) in list.indexed)
        if (item is Map)
          flattenAttributes(item, '$key[$i]', seen, depth + 1)
        else if (item is Iterable)
          seen.contains(item)
              ? '[Circular]'
              : flattenAttributes(
                  _asList(item).asMap(),
                  '$key[$i]',
                  seen,
                  depth + 1,
                )
        else
          jsonLeaf(item),
    ];
  } finally {
    seen.remove(list);
  }
}

List<Object?> _asList(Iterable<Object?> items) =>
    items is List<Object?> ? items : items.toList();
