// Build-time environment and the preset vocabulary, the counterpart of
// apps/rn-playground/src/config-env.ts. Values come from --dart-define (or
// --dart-define-from-file=e2e/<platform>.json), which Dart reads only through
// constant String.fromEnvironment calls, so each one is spelled out here.

const _dsn = String.fromEnvironment('GC_DSN');
const _apiKey = String.fromEnvironment('GC_API_KEY');
const _preset = String.fromEnvironment('GC_PRESET');
const _releaseId = String.fromEnvironment('GC_RELEASE_ID');
const _debug = String.fromEnvironment('GC_DEBUG');

/// Where batches go when no DSN is compiled in: a port nothing listens on, so
/// a stray manual build sends nowhere rather than somewhere real.
const mockDsn = 'localhost:9999';
const mockApiKey = 'dev-key';

String get dsn => _dsn.trim().isEmpty ? mockDsn : _dsn.trim();
String get apiKey => _apiKey.trim().isEmpty ? mockApiKey : _apiKey.trim();
String get releaseId => _releaseId.trim().isEmpty ? '1.0.0' : _releaseId.trim();

/// The preset compiled in with `--dart-define=GC_PRESET=<name>`, or empty.
String get compiledPreset => _preset.trim();

/// `--dart-define=GC_DEBUG=1`: turns the `device` preset's SDK debug logging
/// on, which prints every batch unredacted. The other presets always log.
bool get debugRequested => _debug.trim() == '1';

/// The hosts the Network tab calls on a real DSN, as whole-URL globs: the
/// `device` preset's trace targets. Anchored past the host with a `/`, so a
/// suffix lookalike (`httpbin.org.evil.example`) doesn't match.
const devicePropagationUrls = ['https://httpbin.org/*'];

/// Whether the DSN is the local mock ingest on :9393, which serves the echo
/// endpoints on its sibling port :9394.
bool get echoIsLocalMock => RegExp(r':9393(?=$|/)').hasMatch(dsn);

/// The echo target for the Network screen. The SDK skips requests to its own
/// ingest, so the echo lives on the mock's sibling port; a manual run against a
/// real DSN falls back to httpbin.
String get echoUrl {
  if (!echoIsLocalMock) return 'https://httpbin.org/anything';
  final base = dsn
      .replaceAll(RegExp(r'/+$'), '')
      .replaceFirst(RegExp(r':9393(?=$|/)'), ':9394');
  return '$base/__echo';
}
