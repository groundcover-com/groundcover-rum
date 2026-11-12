import 'dart:convert';

import 'package:groundcover_rum/src/core/common/storage.dart';
import 'package:groundcover_rum/src/core/common/time.dart';
import 'package:groundcover_rum/src/core/events/events_pool.dart';
import 'package:groundcover_rum/src/core/pipeline/rum_pipeline.dart';
import 'package:groundcover_rum/src/core/transport/transporter.dart';

final class MapStorage implements PlatformStorage {
  final values = <String, String>{};

  @override
  String? getItem(String key) => values[key];

  @override
  void setItem(String key, String value) => values[key] = value;

  @override
  void removeItem(String key) => values.remove(key);
}

/// One request the pipeline handed to the platform.
final class SentRequest {
  SentRequest(this.url, this.headers, this.body);

  final String url;
  final Map<String, String> headers;
  final List<int> body;

  Map<String, Object?> get batch =>
      jsonDecode(utf8.decode(body)) as Map<String, Object?>;

  Map<String, Object?> get sessionAttributes =>
      batch['sessionAttributes'] as Map<String, Object?>;

  List<Map<String, Object?>> get events =>
      (batch['events'] as List).cast<Map<String, Object?>>();
}

/// A platform with a settable clock that records every request instead of
/// sending it.
final class FakePlatform implements PlatformServices {
  FakePlatform({this.nowMs = 1800000000000, Map<String, Object?>? device})
    : device = device ?? {'source': 'mobile-rum'};

  int nowMs;
  final Map<String, Object?> device;
  final requests = <SentRequest>[];
  final MapStorage mapStorage = MapStorage();

  @override
  PlatformStorage get storage => mapStorage;

  @override
  Clock get clock =>
      () => nowMs;

  @override
  BatchSender get sendBatch => (endpoint, request) async {
    requests.add(SentRequest(endpoint, request.headers, request.body));
  };

  @override
  Compressor? get compressor => null;

  @override
  DeviceAttributesProvider get deviceAttributes =>
      () => device;

  /// None by default: most tests don't drive the native engine.
  @override
  NativeCrashStore? crashStore;
}

/// Lets the transporter's async send run to completion.
Future<void> drain() => Future<void>.delayed(Duration.zero);
