// dart:io's three HTTP client interfaces, forwarded whole to the instance
// each wraps. Network capture (network.dart) extends these and overrides only
// what it watches, so its own file holds decisions and this one holds none.
// Hand-written on purpose: the compiler names any member a new dart:io adds,
// and Flutter has no mirrors to forward by.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// An [HttpClient] that does what [inner] does. Every convenience verb goes
/// through [open] or [openUrl], as dart:io's own do, so a subclass that
/// overrides those two sees every request.
abstract class ForwardingHttpClient implements HttpClient {
  ForwardingHttpClient(this.inner);

  final HttpClient inner;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) =>
      inner.openUrl(method, url);

  @override
  Future<HttpClientRequest> open(
    String method,
    String host,
    int port,
    String path,
  ) => inner.open(method, host, port, path);

  @override
  Future<HttpClientRequest> get(String host, int port, String path) =>
      open('get', host, port, path);

  @override
  Future<HttpClientRequest> getUrl(Uri url) => openUrl('get', url);

  @override
  Future<HttpClientRequest> post(String host, int port, String path) =>
      open('post', host, port, path);

  @override
  Future<HttpClientRequest> postUrl(Uri url) => openUrl('post', url);

  @override
  Future<HttpClientRequest> put(String host, int port, String path) =>
      open('put', host, port, path);

  @override
  Future<HttpClientRequest> putUrl(Uri url) => openUrl('put', url);

  @override
  Future<HttpClientRequest> delete(String host, int port, String path) =>
      open('delete', host, port, path);

  @override
  Future<HttpClientRequest> deleteUrl(Uri url) => openUrl('delete', url);

  @override
  Future<HttpClientRequest> patch(String host, int port, String path) =>
      open('patch', host, port, path);

  @override
  Future<HttpClientRequest> patchUrl(Uri url) => openUrl('patch', url);

  @override
  Future<HttpClientRequest> head(String host, int port, String path) =>
      open('head', host, port, path);

  @override
  Future<HttpClientRequest> headUrl(Uri url) => openUrl('head', url);

  @override
  bool get autoUncompress => inner.autoUncompress;

  @override
  set autoUncompress(bool value) => inner.autoUncompress = value;

  @override
  Duration? get connectionTimeout => inner.connectionTimeout;

  @override
  set connectionTimeout(Duration? value) => inner.connectionTimeout = value;

  @override
  Duration get idleTimeout => inner.idleTimeout;

  @override
  set idleTimeout(Duration value) => inner.idleTimeout = value;

  @override
  int? get maxConnectionsPerHost => inner.maxConnectionsPerHost;

  @override
  set maxConnectionsPerHost(int? value) => inner.maxConnectionsPerHost = value;

  @override
  String? get userAgent => inner.userAgent;

  @override
  set userAgent(String? value) => inner.userAgent = value;

  @override
  void addCredentials(
    Uri url,
    String realm,
    HttpClientCredentials credentials,
  ) => inner.addCredentials(url, realm, credentials);

  @override
  void addProxyCredentials(
    String host,
    int port,
    String realm,
    HttpClientCredentials credentials,
  ) => inner.addProxyCredentials(host, port, realm, credentials);

  @override
  set authenticate(
    Future<bool> Function(Uri url, String scheme, String? realm)? f,
  ) => inner.authenticate = f;

  @override
  set authenticateProxy(
    Future<bool> Function(String host, int port, String scheme, String? realm)?
    f,
  ) => inner.authenticateProxy = f;

  @override
  set badCertificateCallback(
    bool Function(X509Certificate cert, String host, int port)? callback,
  ) => inner.badCertificateCallback = callback;

  @override
  set connectionFactory(
    Future<ConnectionTask<Socket>> Function(
      Uri url,
      String? proxyHost,
      int? proxyPort,
    )?
    f,
  ) => inner.connectionFactory = f;

  @override
  set findProxy(String Function(Uri url)? f) => inner.findProxy = f;

  @override
  set keyLog(Function(String line)? callback) => inner.keyLog = callback;

  @override
  void close({bool force = false}) => inner.close(force: force);
}

/// An [HttpClientRequest] that does what [inner] does.
abstract class ForwardingHttpClientRequest implements HttpClientRequest {
  ForwardingHttpClientRequest(this.inner);

  final HttpClientRequest inner;

  @override
  Future<HttpClientResponse> get done => inner.done;

  @override
  Future<HttpClientResponse> close() => inner.close();

  @override
  void abort([Object? exception, StackTrace? stackTrace]) =>
      inner.abort(exception, stackTrace);

  @override
  void add(List<int> data) => inner.add(data);

  @override
  Future<void> addStream(Stream<List<int>> stream) => inner.addStream(stream);

  @override
  void write(Object? object) => inner.write(object);

  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      inner.writeAll(objects, separator);

  @override
  void writeCharCode(int charCode) => inner.writeCharCode(charCode);

  @override
  void writeln([Object? object = '']) => inner.writeln(object);

  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      inner.addError(error, stackTrace);

  @override
  Future<void> flush() => inner.flush();

  @override
  bool get bufferOutput => inner.bufferOutput;

  @override
  set bufferOutput(bool value) => inner.bufferOutput = value;

  @override
  int get contentLength => inner.contentLength;

  @override
  set contentLength(int value) => inner.contentLength = value;

  @override
  Encoding get encoding => inner.encoding;

  @override
  set encoding(Encoding value) => inner.encoding = value;

  @override
  bool get followRedirects => inner.followRedirects;

  @override
  set followRedirects(bool value) => inner.followRedirects = value;

  @override
  int get maxRedirects => inner.maxRedirects;

  @override
  set maxRedirects(int value) => inner.maxRedirects = value;

  @override
  bool get persistentConnection => inner.persistentConnection;

  @override
  set persistentConnection(bool value) => inner.persistentConnection = value;

  @override
  HttpConnectionInfo? get connectionInfo => inner.connectionInfo;

  @override
  List<Cookie> get cookies => inner.cookies;

  @override
  HttpHeaders get headers => inner.headers;

  @override
  String get method => inner.method;

  @override
  Uri get uri => inner.uri;
}

/// An [HttpClientResponse] that does what [inner] does.
abstract class ForwardingHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  ForwardingHttpClientResponse(this.inner);

  final HttpClientResponse inner;

  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => inner.listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  X509Certificate? get certificate => inner.certificate;

  @override
  HttpClientResponseCompressionState get compressionState =>
      inner.compressionState;

  @override
  HttpConnectionInfo? get connectionInfo => inner.connectionInfo;

  @override
  int get contentLength => inner.contentLength;

  @override
  List<Cookie> get cookies => inner.cookies;

  @override
  Future<Socket> detachSocket() => inner.detachSocket();

  @override
  HttpHeaders get headers => inner.headers;

  @override
  bool get isRedirect => inner.isRedirect;

  @override
  bool get persistentConnection => inner.persistentConnection;

  @override
  String get reasonPhrase => inner.reasonPhrase;

  @override
  Future<HttpClientResponse> redirect([
    String? method,
    Uri? url,
    bool? followLoops,
  ]) => inner.redirect(method, url, followLoops);

  @override
  List<RedirectInfo> get redirects => inner.redirects;

  @override
  int get statusCode => inner.statusCode;
}
