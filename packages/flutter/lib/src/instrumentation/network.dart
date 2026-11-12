// Network capture for everything built on dart:io's HttpClient: package:http's
// IOClient, dio's default adapter and HttpClient itself. One override, set on
// HttpOverrides.global over whatever was there, wraps every client created
// after it. The counterpart of the RN SDK's fetch and XHR patches.
//
// Each wrapper only watches: the caller's request and response go through
// unchanged, a body is copied while it streams past (up to the cap), and any
// internal failure falls back to the plain call. They extend the forwarding
// bases in http_forwarding.dart and override only what they watch.
// cupertino_http and cronet_http don't use dart:io and aren't seen.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import '../core/common/logger.dart';
import '../core/common/patch.dart';
import '../core/common/time.dart';
import '../core/events/network/body.dart';
import '../core/pipeline/rum_pipeline.dart';
import 'http_forwarding.dart';

/// Wraps the global override, whatever it was, so every client created from
/// now on is watched. [pipeline] gives the pipeline once it runs; until then
/// requests pass through unwatched, since a client reads the override when
/// created and keeps it for good. Restored, clients already created keep
/// their wrapper, which stays harmless. A response body not read within
/// [unreadGrace] is reported unavailable.
void installHttpCapture(
  PatchSet patches,
  RumPipeline? Function() pipeline, {
  Clock clock = systemClock,
  Duration unreadGrace = unreadResponseGrace,
}) => patches.install(
  PatchSpec<HttpOverrides?>(
    get: _globalOverrides,
    set: (overrides) => HttpOverrides.global = overrides,
    wrap: (previous) =>
        _CaptureOverrides(previous, pipeline, clock, unreadGrace),
  ),
);

/// How long a response waits for the caller to start reading its body. RN
/// and the browser read a copy of their own; dart:io gives a body one reader,
/// so its copy is taken as the caller reads. A caller that never reads would
/// leave the request unreported, so past this it is reported with its body
/// unavailable. Long enough for the async work an app does before reading
/// (opening the file a download goes to, a platform call).
const unreadResponseGrace = Duration(seconds: 15);

/// RN's warning, word for word, when network capture arms: patterns match the
/// whole URL.
void warnOnPathOnlyPropagationUrls(List<String>? patterns) {
  if (patterns?.any((pattern) => pattern.startsWith('/')) ?? false) {
    safeWarn(
      '[groundcover] tracing.propagationUrls entries are matched against the '
      'full request URL, so a path-only pattern such as "/api/*" matches no '
      'request. Use a full URL pattern, e.g. "https://api.myapp.com/*".',
    );
  }
}

/// The global override. It has no getter, and [HttpOverrides.current] answers
/// with a zone's own override inside `runWithHttpOverrides`; the root zone
/// has none.
HttpOverrides? _globalOverrides() => Zone.root.run(() => HttpOverrides.current);

final class _CaptureOverrides extends HttpOverrides {
  _CaptureOverrides(
    this._previous,
    this._pipeline,
    this._clock,
    this._unreadGrace,
  );

  final HttpOverrides? _previous;
  final RumPipeline? Function() _pipeline;
  final Clock _clock;
  final Duration _unreadGrace;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final inner =
        _previous?.createHttpClient(context) ?? super.createHttpClient(context);
    return _CapturingClient(inner, _pipeline, _clock, _unreadGrace);
  }

  @override
  String findProxyFromEnvironment(Uri url, Map<String, String>? environment) =>
      _previous?.findProxyFromEnvironment(url, environment) ??
      super.findProxyFromEnvironment(url, environment);
}

/// A body in a content-encoding other than identity: not text as it stands.
bool _isEncoded(String? contentEncoding) {
  final encoding = (contentEncoding ?? '').trim().toLowerCase();
  return encoding.isNotEmpty && encoding != 'identity';
}

Map<String, String> _headerMap(HttpHeaders headers) {
  final out = <String, String>{};
  headers.forEach(
    (name, values) => out[name.toLowerCase()] = values.join(', '),
  );
  return out;
}

/// What a request body is captured as when it isn't text to keep, from its
/// headers alone; null when it is.
String? _requestBodyLabel(Map<String, String> headers) =>
    classifyBody(headers['content-type'] ?? '') ??
    (_isEncoded(headers['content-encoding']) ? BodyPlaceholder.binary : null);

/// The body's length as its reader gets it, or -1 when unknown. A body dart:io
/// decodes is unknown until read: its Content-Length counts the encoded
/// bytes, which a small gzip body's overhead makes more than it decodes to.
int _readLength(HttpClientResponse response) =>
    response.compressionState == HttpClientResponseCompressionState.decompressed
    ? -1
    : response.contentLength;

/// What a response body is captured as when its head decides it; null when
/// it has to be read.
String? _responseBodyLabel(
  String method,
  HttpClientResponse response,
  Map<String, String> headers,
) {
  if (isKnownEmptyResponse(
    method: method,
    status: response.statusCode,
    headers: headers,
  )) {
    return '';
  }
  final contentType = headers['content-type'] ?? '';
  if (isEventStream(contentType)) return BodyPlaceholder.responseUnreadable;
  final label = classifyBody(contentType);
  if (label != null) return label;
  // Still compressed, so not text as read: dart:io decodes only gzip, and
  // only with autoUncompress on.
  if (_isEncoded(headers['content-encoding']) &&
      response.compressionState !=
          HttpClientResponseCompressionState.decompressed) {
    return BodyPlaceholder.binary;
  }
  if (_readLength(response) >= maxNetworkBodyBytes) {
    return BodyPlaceholder.responseTooLarge;
  }
  return null;
}

/// The URL dart:io builds for `open(method, host, port, path)`: the path may
/// carry a query, and a `#` in it is encoded, never a fragment.
Uri _openUrl(String host, int port, String path) {
  var fragmentStart = path.length;
  var queryStart = path.length;
  for (var i = path.length - 1; i >= 0; i--) {
    switch (path.codeUnitAt(i)) {
      case 0x23: // #
        fragmentStart = i;
        queryStart = i;
      case 0x3f: // ?
        queryStart = i;
    }
  }
  String? query;
  var rest = path;
  if (queryStart < fragmentStart) {
    query = path.substring(queryStart + 1, fragmentStart);
    rest = path.substring(0, queryStart);
  }
  return Uri(scheme: 'http', host: host, port: port, path: rest, query: query);
}

/// A body as it streams past, kept up to the cap; past it, only the fact.
/// This bounds memory: [capBody] decides the limit.
final class _BodyCopy {
  final _bytes = BytesBuilder();
  bool _overflow = false;

  bool get isEmpty => _bytes.isEmpty && !_overflow;

  bool _fits(int length) {
    if (_overflow) return false;
    if (_bytes.length + length <= maxNetworkBodyBytes) return true;
    _overflow = true;
    _bytes.clear();
    return false;
  }

  void add(List<int> chunk) {
    if (_fits(chunk.length)) _bytes.add(chunk);
  }

  /// [text] as [encoding] writes it. Each character is at least a byte, so
  /// one longer than the room left overflows without being encoded.
  void addText(String text, Encoding encoding) {
    if (_fits(text.length)) add(encoding.encode(text));
  }

  /// The body as text, or [tooLarge] at or over the cap. Takes the bytes:
  /// the copy is empty afterwards.
  String take(String tooLarge) => _overflow
      ? tooLarge
      : capBody(
          utf8.decode(_bytes.takeBytes(), allowMalformed: true),
          maxNetworkBodyBytes,
          tooLarge,
        );
}

enum _Stage { open, responded, done }

/// One request, from open to its report, which happens once: when its body
/// is finished with, when it fails, or never if the caller cancels it.
final class _Observation {
  _Observation(
    this._pipeline,
    this._clock,
    this.unreadGrace,
    String method,
    this.url,
  ) : method = method.toUpperCase(),
      _startMs = _clock();

  final RumPipeline _pipeline;
  final Clock _clock;
  final Duration unreadGrace;
  final String method;
  final String url;
  final int _startMs;
  var _stage = _Stage.open;
  var _requestHeaders = const <String, String>{};
  var _requestBody = '';
  var _status = 0;
  var _responseHeaders = const <String, String>{};
  int? _endMs;

  bool get hasResponse => _stage == _Stage.responded;

  /// The request as it went out: its headers, and its body or a label.
  void sent(Map<String, String> headers, String body) {
    _requestHeaders = headers;
    _requestBody = body;
  }

  /// The response's head arrived. Stamped now, before the body is read, so
  /// reading never inflates the duration.
  void responded(int status, Map<String, String> headers) {
    if (_stage != _Stage.open) return;
    _stage = _Stage.responded;
    _status = status;
    _responseHeaders = headers;
    _endMs = _clock();
  }

  void finish(String responseBody) {
    if (_stage != _Stage.responded) return;
    _report(responseBody: responseBody);
  }

  /// Failed before a response: status 0.
  void failed(Object error) {
    if (_stage != _Stage.open) return;
    _endMs = _clock();
    _report(
      errorType:
          error is TimeoutException ||
              (error is SocketException && error.message.contains('timed out'))
          ? NetworkErrorType.timeout
          : NetworkErrorType.networkFailure,
    );
  }

  /// Cancelled by the caller: never reported.
  void discard() => _stage = _Stage.done;

  void _report({String responseBody = '', NetworkErrorType? errorType}) {
    _stage = _Stage.done;
    try {
      _pipeline.submit(
        NetworkCapture(
          method: method,
          url: url,
          startMs: _startMs,
          endMs: _endMs ?? _clock(),
          status: _status,
          requestHeaders: _requestHeaders,
          requestBody: _requestBody,
          responseHeaders: _responseHeaders,
          responseBody: responseBody,
          errorType: errorType,
        ),
      );
    } catch (error) {
      handleError(error);
    }
  }
}

final class _CapturingClient extends ForwardingHttpClient {
  _CapturingClient(super.inner, this._pipeline, this._clock, this._unreadGrace);

  final RumPipeline? Function() _pipeline;
  final Clock _clock;
  final Duration _unreadGrace;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) =>
      _watch(method, () => url, () => inner.openUrl(method, url));

  @override
  Future<HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) => _watch(
    method,
    () => _openUrl(host, port, path),
    () => inner.open(method, host, port, path),
  );

  Future<HttpClientRequest> _watch(
    String method,
    Uri Function() url,
    Future<HttpClientRequest> Function() open,
  ) async {
    _Observation? observation;
    Map<String, String> trace = const {};
    try {
      final pipeline = _pipeline();
      if (pipeline != null) {
        final text = '${url()}';
        if (pipeline.capturesUrl(text)) {
          observation = _Observation(
            pipeline,
            _clock,
            _unreadGrace,
            method,
            text,
          );
          trace = pipeline.traceHeadersFor(text);
        }
      }
    } catch (error) {
      handleError(error);
      observation = null;
    }
    if (observation == null) return open();

    // What a request that fails to connect is reported with: RN's failed
    // fetch keeps its trace ids too.
    observation.sent(trace, '');
    final HttpClientRequest request;
    try {
      // dart:io connects here, so a refused connection fails here.
      request = await open();
    } catch (error) {
      observation.failed(error);
      rethrow;
    }
    try {
      // dart:io's own headers, before the caller has set any: not recorded
      // unless the caller changes them, as RN records only the caller's.
      final defaults = _headerMap(request.headers);
      _setAll(request.headers, trace);
      return _CapturingRequest(request, observation, trace, defaults);
    } catch (error) {
      handleError(error);
      return request;
    }
  }
}

/// Headers dart:io writes from the body itself, never the caller's.
const _framingHeaders = {'content-length', 'transfer-encoding'};

void _setAll(HttpHeaders headers, Map<String, String> values) {
  for (final MapEntry(:key, :value) in values.entries) {
    headers.set(key, value);
  }
}

final class _CapturingRequest extends ForwardingHttpClientRequest {
  _CapturingRequest(
    super.inner,
    this._observation,
    this._trace,
    this._defaults,
  );

  final _Observation _observation;
  final Map<String, String> _trace;
  final Map<String, String> _defaults;
  bool _sending = false;

  // The SDK's trace headers win over a caller's, as in RN's fetch path:
  // set again as the request starts going out, while headers are mutable.
  void _send() {
    if (_sending) return;
    _sending = true;
    try {
      _setAll(inner.headers, _trace);
    } catch (error) {
      handleError(error);
    }
  }

  final _body = _BodyCopy();
  Future<HttpClientResponse>? _done;

  void _tap(void Function() copy) {
    try {
      copy();
    } catch (error) {
      handleError(error);
    }
  }

  // What was sent, read as the request goes out: the headers the caller set
  // and the SDK's trace headers, and the body if its headers say it is text.
  void _seal() {
    try {
      final headers = {
        for (final MapEntry(:key, :value) in _headerMap(inner.headers).entries)
          if (!_framingHeaders.contains(key) && _defaults[key] != value)
            key: value,
      };
      _observation.sent(
        headers,
        _body.isEmpty
            ? ''
            : _requestBodyLabel(headers) ??
                  _body.take(BodyPlaceholder.requestTooLarge),
      );
    } catch (error) {
      handleError(error);
    }
  }

  @override
  Future<HttpClientResponse> get done =>
      _done ??= inner.done.then(_onResponse, onError: _onFailure);

  @override
  Future<HttpClientResponse> close() {
    _send();
    _seal();
    final closed = inner.close();
    if (_done == null) {
      return _done = closed.then(_onResponse, onError: _onFailure);
    }
    // dart:io's close() returns done, already observed; another client's
    // may not, and its error must not go unhandled.
    closed.ignore();
    return _done!;
  }

  HttpClientResponse _onResponse(HttpClientResponse response) {
    try {
      // A protocol switch (a WebSocket's handshake): no body, and its socket
      // leaves HTTP. RN's and the browser's capture never see one, since
      // fetch and XHR carry no WebSockets, so it isn't reported.
      if (response.statusCode == HttpStatus.switchingProtocols) {
        _observation.discard();
        return response;
      }
      final headers = _headerMap(response.headers);
      _observation.responded(response.statusCode, headers);
      final label = _responseBodyLabel(_observation.method, response, headers);
      if (label != null) {
        _observation.finish(label);
        return response;
      }
      return _ObservedResponse(response, _observation);
    } catch (error) {
      handleError(error);
      return response;
    }
  }

  Never _onFailure(Object error, StackTrace stackTrace) {
    _observation.failed(error);
    Error.throwWithStackTrace(error, stackTrace);
  }

  @override
  void abort([Object? exception, StackTrace? stackTrace]) {
    // Before a response, a cancel: never reported, as RN reports no
    // cancelled fetch. A client's own timeout reads the same here (dio aborts
    // for both) unless it aborts with a TimeoutException, which then fails
    // the request as ERR_TIMEOUT. After the response dart:io ignores it, and
    // the body streams on.
    if (!_observation.hasResponse && exception is! TimeoutException) {
      _observation.discard();
    }
    inner.abort(exception, stackTrace);
  }

  @override
  void add(List<int> data) {
    _send();
    _tap(() => _body.add(data));
    inner.add(data);
  }

  @override
  Future<void> addStream(Stream<List<int>> stream) {
    _send();
    return inner.addStream(
      stream.map((chunk) {
        _tap(() => _body.add(chunk));
        return chunk;
      }),
    );
  }

  @override
  void write(Object? object) {
    _send();
    _tap(() => _body.addText('$object', encoding));
    inner.write(object);
  }

  /// One pass through [write], as dart:io's own writeAll makes: the caller's
  /// iterable may be readable once (a generator over a file), and joining it
  /// for the copy first would leave dart:io an empty body to send.
  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) {
    final iterator = objects.iterator;
    if (!iterator.moveNext()) return;
    write(iterator.current);
    while (iterator.moveNext()) {
      if (separator.isNotEmpty) write(separator);
      write(iterator.current);
    }
  }

  @override
  void writeCharCode(int charCode) {
    _send();
    _tap(() => _body.addText(String.fromCharCode(charCode), encoding));
    inner.writeCharCode(charCode);
  }

  @override
  void writeln([Object? object = '']) {
    _send();
    _tap(() => _body.addText('$object\n', encoding));
    inner.writeln(object);
  }
}

/// A response whose body is copied as the caller reads it. The observation
/// finishes once: with the body when it ends, its too-large placeholder past
/// the cap, or the unavailable one if it failed, was cut short or cancelled,
/// or was never read at all.
final class _ObservedResponse extends ForwardingHttpClientResponse {
  _ObservedResponse(super.inner, this._observation) {
    // A body the caller never reads would never be reported.
    _unread = Timer(_observation.unreadGrace, () => _finish(complete: false));
  }

  final _Observation _observation;
  late final Timer _unread;
  final _body = _BodyCopy();
  int _received = 0;
  bool _finished = false;

  void _finish({required bool complete}) {
    if (_finished) return;
    _finished = true;
    _unread.cancel();
    try {
      // A body cut off with no error handler listening ends with just a
      // done; the length it promised gives it away.
      final length = _readLength(inner);
      final whole = complete && (length < 0 || _received >= length);
      _observation.finish(
        whole
            ? _body.take(BodyPlaceholder.responseTooLarge)
            : BodyPlaceholder.responseUnavailable,
      );
    } catch (error) {
      handleError(error);
    }
  }

  /// The caller follows the redirect itself, so this response's body is
  /// never read: reported now, not after the wait for a read. dart:io sends
  /// the next request on its own, never through this client, so that one
  /// isn't reported or traced (in the README).
  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) {
    _finish(complete: false);
    return inner.redirect(method, url, followLoops);
  }

  void _tap(List<int> chunk) {
    try {
      _received += chunk.length;
      _body.add(chunk);
    } catch (error) {
      handleError(error);
    }
  }

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) {
    final subscription = _ObservedSubscription(this, cancelOnError ?? false)
      ..onData(onData)
      ..onError(onError)
      ..onDone(onDone);
    // dart:io's own subscription, so a second listen throws here as it would
    // unwrapped.
    subscription._source = inner.listen(
      subscription._data,
      onError: subscription._error,
      onDone: subscription._done,
    );
    _unread.cancel();
    return subscription;
  }
}

/// The caller's subscription to an observed body: dart:io's own underneath,
/// with whatever handlers the caller sets, at listen or later (drain() and
/// asFuture() set theirs after), each seen on its way through.
final class _ObservedSubscription implements StreamSubscription<List<int>> {
  _ObservedSubscription(this._response, this._cancelOnError);

  final _ObservedResponse _response;
  final bool _cancelOnError;
  late final StreamSubscription<List<int>> _source;
  void Function(List<int> data)? _handleData;
  Function? _handleError;
  void Function()? _handleDone;

  void _data(List<int> chunk) {
    _response._tap(chunk);
    _handleData?.call(chunk);
  }

  void _error(Object error, StackTrace stackTrace) {
    _response._finish(complete: false);
    final handler = _handleError;
    // dart:io ends a failed body with only a done for a listener with no
    // error handler, so a caller without one hears nothing more here.
    if (handler == null) return;
    if (_cancelOnError) unawaited(_source.cancel());
    if (handler is void Function(Object, StackTrace)) {
      handler(error, stackTrace);
    } else if (handler is void Function(Object)) {
      handler(error);
    }
  }

  void _done() {
    _response._finish(complete: true);
    _handleDone?.call();
  }

  @override
  void onData(void Function(List<int> data)? handleData) =>
      _handleData = handleData;

  @override
  void onError(Function? handleError) => _handleError = handleError;

  @override
  void onDone(void Function()? handleDone) => _handleDone = handleDone;

  @override
  void pause([Future<void>? resumeSignal]) => _source.pause(resumeSignal);

  @override
  void resume() => _source.resume();

  @override
  bool get isPaused => _source.isPaused;

  @override
  Future<void> cancel() {
    _response._finish(complete: false);
    return _source.cancel();
  }

  @override
  Future<E> asFuture<E>([E? futureValue]) {
    final result = Completer<E>();
    onDone(() => result.complete(futureValue as E));
    onError((Object error, StackTrace stackTrace) {
      cancel().whenComplete(() => result.completeError(error, stackTrace));
    });
    return result.future;
  }
}
