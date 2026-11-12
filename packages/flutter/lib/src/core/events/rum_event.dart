/// An event as `beforeSend` and `enrichEvent` receive it.
library;

import '../common/json.dart';

/// One captured event, as the hooks see it.
///
/// The [attributes] are dot-flattened before the hooks run, so a tap's
/// `interaction_target: {label}` arrives as `'interaction_target.label'`. The
/// one nested exception is `screen`, added after flattening. Timestamps are
/// nanoseconds since the epoch.
///
/// An `enrichEvent` hook may change anything here except [type] and [id], and
/// returns the event (this one or a new one).
final class RumEvent {
  RumEvent({
    required this.type,
    required this.id,
    required this.spanId,
    this.parentSpanId,
    this.traceId,
    this.timestamp,
    this.startTimestamp,
    this.endTimestamp,
    this.spanName,
    Map<String, Object?>? attributes,
  }) : attributes = attributes ?? <String, Object?>{};

  /// The event kind: `interaction`, `network`, `log`, `navigation`, `custom`,
  /// `exception` or `performance`.
  final String type;

  final String id;
  String spanId;
  String? parentSpanId;
  String? traceId;
  int? timestamp;
  int? startTimestamp;
  int? endTimestamp;

  /// `"METHOD path"` on network events only.
  String? spanName;

  Map<String, Object?> attributes;

  /// The event as the wire carries it. A network event has `start_timestamp`
  /// (and `end_timestamp` when known) instead of `timestamp`.
  Map<String, Object?> toJson() => {
    'type': type,
    'id': id,
    'spanId': spanId,
    'parentSpanId': parentSpanId,
    'traceId': traceId,
    if (spanName != null) 'span_name': spanName,
    if (timestamp != null) 'timestamp': timestamp,
    if (startTimestamp != null) 'start_timestamp': startTimestamp,
    if (endTimestamp != null) 'end_timestamp': endTimestamp,
    'attributes': attributes,
  };
}

/// [event] with its attributes copied all the way down, through JSON as the
/// wire carries them, so a hook's changes to the copy never reach it. Next
/// to the class, so a field added to it is copied too.
RumEvent copyRumEvent(RumEvent event) => RumEvent(
  type: event.type,
  id: event.id,
  spanId: event.spanId,
  parentSpanId: event.parentSpanId,
  traceId: event.traceId,
  timestamp: event.timestamp,
  startTimestamp: event.startTimestamp,
  endTimestamp: event.endTimestamp,
  spanName: event.spanName,
  attributes: decodeJsonObject(encodeJson(event.attributes)),
);
