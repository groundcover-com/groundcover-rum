import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import '../core/common/json.dart';
import '../core/transport/transporter.dart';

/// Sends a batch over dart:io. dart:io traffic is subject to neither
/// Android's cleartext rules nor iOS's App Transport Security.
final class HttpBatchSender {
  HttpBatchSender({this.timeout = defaultTimeout})
    : _client = _plainClient()
        ..connectionTimeout = timeout
        ..maxConnectionsPerHost = maxConnections;

  /// A client the app's `HttpOverrides.global` never builds: the app's
  /// override (a pinned CA, a `badCertificateCallback`) is for its own
  /// traffic, and through it pinning would fail every batch, or an
  /// accept-all callback would send the ingest key unverified. Built this
  /// way, the SDK's own sends also never reach its network capture.
  static HttpClient _plainClient() =>
      HttpOverrides.runWithHttpOverrides(HttpClient.new, _NoOverrides());

  /// RN's budget for a batch POST (RN_SEND_TIMEOUT_MS).
  static const defaultTimeout = Duration(seconds: 30);

  /// Sends beyond these wait for a connection, as OkHttp and NSURLSession
  /// queue RN's. dart:io's default is unbounded: a burst of events would open
  /// a socket, and a TLS handshake, per batch at once.
  static const maxConnections = 2;

  final Duration timeout;
  final HttpClient _client;

  /// Sends [batch], stopping the request at [timeout] as RN's
  /// AbortController does: a hung ingest must not hold a socket per batch.
  /// A Future's own timeout only stops waiting, and the request goes on.
  Future<void> call(String endpoint, BatchRequest batch) async {
    HttpClientRequest? request;
    StreamSubscription<List<int>>? body;
    final expired = Completer<void>();
    final deadline = Timer(timeout, () {
      final error = TimeoutException('batch send', timeout);
      expired.completeError(error, StackTrace.current);
      // Before the response, the abort fails the request; after it, dart:io
      // ignores an abort, and cancelling the body closes the connection.
      request?.abort(error);
      unawaited(body?.cancel());
    });

    Future<void> send() async {
      final open = await _client.postUrl(Uri.parse(endpoint));
      // Queued for a connection past the deadline, when there was nothing to
      // stop yet: stopped now, before a byte of it goes out.
      if (expired.isCompleted) {
        open
          ..abort()
          ..done.ignore();
        return;
      }
      request = open;
      for (final MapEntry(:key, :value) in batch.headers.entries) {
        // An empty Content-Encoding means "not compressed"; send no header.
        if (value.isNotEmpty) open.headers.set(key, value);
      }
      open.add(batch.body);
      final response = await open.close();
      // Read to the end, so the connection can be reused.
      await (body = response.listen(null)).asFuture<void>();
      // Not delivered: the transporter reports it, and the crash drain keeps
      // the record for the next launch.
      if (response.statusCode < 200 || response.statusCode > 299) {
        throw IngestRejected(response.statusCode);
      }
    }

    final sending = send();
    try {
      await Future.any([sending, expired.future]);
    } finally {
      deadline.cancel();
      // A send stopped by the deadline fails later, or never ends.
      sending.ignore();
      expired.future.ignore();
    }
  }
}

/// HttpOverrides' own behaviour: a plain dart:io client.
final class _NoOverrides extends HttpOverrides {}

/// Gzip through dart:io, and a batch's body built on a short-lived isolate,
/// so the UI isolate doesn't drop frames over it. Every body, however small:
/// handing the payload over costs the UI isolate a copy of its maps and lists
/// (strings are shared), which costs less than building the body inline at
/// every batch size, a single event's included.
final class GzipCompressor implements Compressor {
  @override
  Future<List<int>> encode(
    Map<String, Object?> payload, {
    required bool compress,
  }) => _encodeOffIsolate(payload, compress);

  @override
  List<int> compressSync(List<int> bytes) => gzip.encode(bytes);
}

// Top-level, so the closure Isolate.run sends captures the payload and the
// flag alone: never the transporter, the config, or the hooks it holds. A
// payload an isolate can't take (something a hook put in) throws here, and
// the transporter builds that body inline.
Future<List<int>> _encodeOffIsolate(
  Map<String, Object?> payload,
  bool compress,
) => Isolate.run(() => _encodeBody(payload, compress));

List<int> _encodeBody(Object? payload, bool compress) {
  final bytes = utf8.encode(encodeJson(payload));
  return compress ? gzip.encode(bytes) : bytes;
}
