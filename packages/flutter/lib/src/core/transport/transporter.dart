import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../common/json.dart';
import '../common/logger.dart';
import '../config/config_manager.dart';
import '../config/constants.dart';

/// One batch POST, as the platform sends it.
final class BatchRequest {
  const BatchRequest({required this.headers, required this.body});

  final String method = 'POST';
  final Map<String, String> headers;
  final Uint8List body;
}

/// The one network primitive the core needs; the platform owns how a batch
/// reaches the wire. A live send never awaits it; a delivery does, for the
/// verdict, so it throws when the batch didn't land.
typedef BatchSender =
    Future<void> Function(String endpoint, BatchRequest request);

/// What a [BatchSender] throws when the ingest answers outside 2xx, so the
/// transporter can tell a refused batch from a network failure.
final class IngestRejected implements Exception {
  const IngestRejected(this.status);

  final int status;

  @override
  String toString() => 'the ingest answered $status';
}

/// Statuses that mean the endpoint refuses this SDK's credentials. Every batch
/// after one of these is refused the same way, so the app records nothing
/// until the apiKey or dsn is fixed: that warrants a warning outside debug.
const _credentialRejections = {401, 403};

/// What the core can't do itself, so the platform provides it: gzip (it is
/// dart:io's), and a batch's body built off the UI isolate (dart:isolate's).
abstract interface class Compressor {
  /// [payload] as a request body, built off the UI isolate: JSON as
  /// [encodeJson] writes it, UTF-8, then gzip when [compress]. On any
  /// failure the transporter builds the body inline instead.
  Future<List<int>> encode(
    Map<String, Object?> payload, {
    required bool compress,
  });

  /// Gzip, inline: for a batch sent as the app goes to the background, which
  /// has to be queued before the process is suspended.
  List<int> compressSync(List<int> bytes);
}

/// A batch on its way out: the envelope plus the events.
typedef Batch = ({
  Map<String, Object?> sessionAttributes,
  List<Object?> events,
});

final class Transporter {
  Transporter({
    required this._config,
    required this._sendBatch,
    this._compressor,
  });

  final ConfigManager _config;
  final BatchSender _sendBatch;
  final Compressor? _compressor;

  /// Credential rejections already warned about: one warning per status is
  /// enough to act on, and a batch goes out every few seconds.
  final _warnedStatuses = <int>{};

  /// A refused batch and its events are gone: logged in debug, and warned
  /// about even without debug when the endpoint refuses the credentials,
  /// since that silently drops every batch. As the browser SDK does.
  void _reportRejection(int status, String endpoint) {
    RumDiagnostics.instance.log(
      'Batch rejected by $endpoint with HTTP $status',
    );
    if (_credentialRejections.contains(status) && _warnedStatuses.add(status)) {
      safeWarn(
        '[groundcover] $endpoint rejected a batch with HTTP $status. Check '
        'the apiKey and dsn passed to GroundcoverRum.init(): no RUM data is '
        'recorded until they are accepted.',
      );
    }
  }

  /// [payload] as a request body. The platform builds it off the UI isolate,
  /// JSON, UTF-8 and gzip alike: since Flutter 3.29 the UI isolate is the
  /// platform's main thread, so a body built there is frame time.
  ///
  /// Inline for a [lifecycle] send, which has to be queued before the process
  /// is suspended, sooner than an isolate may answer; and in debug, which
  /// logs the JSON, so builds it here anyway.
  Future<({List<int> data, bool compressed})> _encode(
    Map<String, Object?> payload, {
    required bool lifecycle,
  }) async {
    final options = _config.config.options;
    final compressor = _compressor;
    final enabled = options.transport.compression ?? defaultCompression;
    if (compressor != null && !lifecycle && !options.debug) {
      try {
        final data = await compressor.encode(payload, compress: enabled);
        return (data: data, compressed: enabled);
      } catch (error) {
        // An encoder failure never drops a batch: it is built here instead,
        // and goes out uncompressed.
        handleError(error);
        return (data: utf8.encode(encodeJson(payload)), compressed: false);
      }
    }
    final json = encodeJson(payload);
    if (options.debug) RumDiagnostics.instance.log('Sending batch:', json);
    final bytes = utf8.encode(json);
    if (!enabled || compressor == null) return (data: bytes, compressed: false);
    try {
      return (data: compressor.compressSync(bytes), compressed: true);
    } catch (error) {
      // As above: it goes out uncompressed.
      handleError(error);
      return (data: bytes, compressed: false);
    }
  }

  /// [batch] as the request that carries it; null without an API key, when
  /// nothing is sent. [lifecycle] builds the body inline, as a batch sent
  /// while the app goes to the background must be.
  Future<({String endpoint, BatchRequest request})?> _request(
    Batch batch, {
    required bool lifecycle,
  }) async {
    final config = _config.config;
    final apiKey = config.apiKey;
    if (apiKey.isEmpty) return null;
    final encoded = await _encode({
      'sessionAttributes': batch.sessionAttributes,
      'events': batch.events,
    }, lifecycle: lifecycle);
    return (
      endpoint: '${config.endpoint}/json/rum',
      request: BatchRequest(
        headers: {
          'Content-Type': 'application/json',
          'apikey': apiKey,
          'Content-Encoding': encoded.compressed ? 'gzip' : '',
        },
        body: Uint8List.fromList(encoded.data),
      ),
    );
  }

  /// Sends [batch] and reports whether it was delivered: the request
  /// completed and the platform's sender didn't fail it (a non-2xx answer,
  /// a timeout, no network). [send] is fire-and-forget, as a live batch must
  /// be; the crash drain needs the verdict, to delete a record only once it
  /// landed. False without an API key, when nothing is sent.
  Future<bool> deliver(Batch batch) async {
    String? endpoint;
    try {
      // Not a lifecycle send: nothing is being suspended, so its body, large
      // as a crash record can be, is built off the UI isolate.
      final outgoing = await _request(batch, lifecycle: false);
      if (outgoing == null) return false;
      endpoint = outgoing.endpoint;
      await _sendBatch(outgoing.endpoint, outgoing.request);
      return true;
    } catch (error) {
      if (error is IngestRejected && endpoint != null) {
        _reportRejection(error.status, endpoint);
      } else {
        RumDiagnostics.instance.log('Failed to deliver batch:', error);
      }
      return false;
    }
  }

  Future<void> send(Batch batch, {bool lifecycle = false}) async {
    try {
      final outgoing = await _request(batch, lifecycle: lifecycle);
      if (outgoing == null) {
        RumDiagnostics.instance.log('No API key found');
        return;
      }
      unawaited(
        _sendBatch(outgoing.endpoint, outgoing.request).catchError((
          Object error,
        ) {
          if (error is IngestRejected) {
            _reportRejection(error.status, outgoing.endpoint);
            return;
          }
          RumDiagnostics.instance.log(
            'Network error while sending batch:',
            error,
          );
        }),
      );
    } catch (error) {
      RumDiagnostics.instance.log('Failed to send batch:', error);
    }
  }
}
