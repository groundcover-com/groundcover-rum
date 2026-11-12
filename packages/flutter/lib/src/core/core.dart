/// The SDK's core: config, sessions, redaction, enrichment and batching,
/// behind the `RumPipeline` seam.
///
/// Platform-free. Files here may import only other files in this directory and
/// a short allow-list of pure `dart:` libraries, which the package's tests
/// enforce. Anything the pipeline needs from the platform (storage, clock,
/// transport, device info) is injected from `lib/src/platform/`.
library;
