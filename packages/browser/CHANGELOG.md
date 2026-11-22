# Changelog

All notable changes to `@groundcover/browser` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [2.3.0-rc.0] — 2026-11-19

Release candidate for `2.3.0`, published under the `rc` tag. Repeated identical errors are now
merged by default; see Changed.

### Added

- **`options.errors.deduplication`.** Controls the merging of repeated errors below. On by default;
  `{ enabled: false }`, or `false` for short, sends every occurrence.

### Changed

- **Repeated identical errors are merged.** An error loop used to send every occurrence, so one
  failing call could send thousands of identical exceptions in minutes. Now a repeat of an exception
  or error-level log that is still waiting in the current batch is counted on that event instead of
  sent again, so each batch carries one event per distinct error, with `error_repeat_count`
  (exceptions) or `log_repeat_count` (logs) set to the occurrences it stands for. Repeats are the
  same error when they happen on the same page and, for exceptions, are thrown through the same code
  path (the same stack). A merged event keeps the first occurrence's context: timestamp, ids and
  metadata. A merged event counts as one toward `transport.batchSize`, so a loop no longer fills
  batches by itself: it goes out with the batch, on `transport.batchTimeout` or when other events
  fill it. Events without the field stand for one, so the total is the sum of the field; exception
  and error-log counts that count events rather than summing it will read lower.

## [2.2.3] — 2026-11-17

### Fixed

- **A refused API key is no longer silent.** When the ingest endpoint answers 401 or 403, the SDK
  warns on the console once, even with `debug` off, so a wrong `apiKey` or `dsn` no longer looks
  like a working SDK.
- **`data:` and `blob:` URLs are no longer captured as network requests.** They are read from
  memory, not the network. A large `data:` URL, such as an image preview the page reads with
  `fetch`, was copied into every URL field of its event.
- **An out-of-range `sessionMaxDuration` in `updateConfig` keeps the current cap.** It used to
  reset the cap to the 4-hour default, undoing the value chosen at `init`. The warning now names
  the cap in use.

### Changed

- **fflate 0.8.3.** The SDK now depends on fflate 0.8.3, which fixes an infinite loop in fflate's
  ZIP64 parser (GHSA-px8p-9vwx-vf98), and the session-replay compression worker is rebuilt with
  it. The SDK only gzips with fflate and never parses ZIP archives, so it was not exposed; the
  update clears the advisory for scanners that flag the dependency.
- **The README names the key patterns whose separator is flexible** (`api_key`, `access_key`,
  `write_key`, `credit_card`, `card_number`). It used to name the wrong five.

## [2.2.2] — 2026-11-15

### Fixed

- **An interaction's selector names the clicked element when its classes or attribute values
  contain CSS syntax.** A class like `md:flex` or `w-1/2`, as utility-class frameworks write them,
  or an attribute value with a backslash or a line break, made the element's part of the selector
  invalid or match nothing, so `dom_event_selector` named an ancestor, matched no element, or was
  just `*`. Those characters are now escaped; an ordinary class or value comes out as before.

### Changed

- **The package links to its source.** `repository` and `bugs` point at
  [groundcover-com/groundcover-rum](https://github.com/groundcover-com/groundcover-rum).

## [2.2.1] — 2026-11-15

No changes to the SDK's behaviour from `2.2.0`: source comments and documentation only.

## [2.2.0] — 2026-11-10

Stable release of `2.2.0-rc.0`, with no changes since. Issues for thrown or rejected values that
aren't `Error`s start new groups once; see Changed.

### Added

- **Third-party notices.** The package now ships `THIRD_PARTY_NOTICES.md` with the MIT notices of
  fflate and `@rrweb/packer`, whose code its session-replay compression worker bundles.
- **Unhandled rejections of Bluebird promises are reported.** Bluebird announces an unhandled
  rejection with its own `unhandledrejection` event, which the SDK ignored; it is now reported by
  its reason, like a native one.

### Changed

- **`captureException` accepts any value, not only an `Error`.** A string, object or other value was
  dropped without a word; it is now reported as an exception with `error_type` `Error`. A string or
  number is its own message. An object is described by its shape, never its values, so captures of
  the same kind group as one issue even when a field such as a request id changes:
  `Object captured as exception with keys: code, requestId`, the class name for a class instance
  (`Response captured as exception`), and an item count for an array. The value itself is sent in
  `error_metadata.captured_value` as JSON, redacted field by field and cut at 10,000 characters. An
  object with a string `message` keeps its own name, message and stack, and a DOM Event, such as an
  image's `error` event, is described by its type and target
  (`Event captured as exception (type=error, target=img)`).
- **`captureException` takes `unknown`.** Existing calls still compile, but a typed stand-in for it
  written as `(error: Error) => …`, such as a test mock, no longer type-checks.
- **Thrown objects and rejection reasons that aren't `Error`s are described the same way.** A
  rejection's reason was reported as its JSON, and a thrown object without a `message` as
  `Unknown error`; both are now described by their shape
  (`Object captured as promise rejection with keys: code`), with the value in
  `error_metadata.captured_value`. Issues for such values start new groups once.
- **`error_message` is capped at 10,000 characters**, as log messages are. The fingerprint, made
  from the first 400 characters, is unchanged.
- **The SDK no longer adds properties to your `Error` objects.** It defined read-only `fileName`,
  `lineNumber` and `columnNumber` on every uncaught `Error` in Chromium and Safari, and nothing read
  them.
- **`maskErrors` is documented as it works.** It redacts error messages and metadata; stack frames
  are sent as they are.
- **The package `homepage` is the current documentation URL**, and the package's LICENSE carries its
  copyright line.

### Fixed

- **An uncaught throw of a non-`Error` value is reported at its throw site.** `throw "boom"` or
  `throw 0` outside a promise made the SDK's error listener fail, so the error was dropped. It is now
  an exception with the message `boom` and one stack frame at the location the browser reported.
- **An uncaught error whose message contains "Script error" is reported.** The SDK dropped every
  such error, such as RequireJS's `Script error for "<module>"`; it now drops only the browser's
  muted cross-origin `Script error.`, which carries nothing to report.
- **An unhandled rejection whose reason can't be serialized is reported.** A rejection with a
  circular object as its reason made the SDK fail, so it was dropped.
- **A rejection reason's nested secrets are redacted.** Its JSON was scrubbed as free text, which
  masked only the first line under a sensitive key such as `token` or `credit_card`; the reason is
  now redacted field by field.
- **An `Error` from another frame keeps its name and message as a rejection reason.** A same-origin
  iframe's `Error` failed the SDK's `instanceof Error` check and was reported as `{}`.

## [2.1.1] — 2026-10-26

Stable release of `2.1.1-rc.1`. Session replay takes its periodic full snapshot every 5 minutes
instead of every 30 seconds. No configuration or API changes from `2.1.0`. `2.1.1-rc.1` supersedes
`2.1.1-rc.0`.

The type declarations are byte-for-byte those of `2.1.0` and rc.1. The shipped JavaScript differs
from rc.1 only in the text of the removed-option warnings below.

### Changed

- **Session replay's periodic full snapshot (rrweb's `checkoutEveryNms`) runs every 5 minutes**
  instead of every 30 seconds. Each checkout serializes the whole DOM synchronously, inside whichever
  recorded event triggers it (often a click, input or scroll), and uploads the full tree; on a large
  page that is tens of milliseconds of main-thread work. 5 minutes is a common interval for
  rrweb-based recorders, so checkouts run 10× less often and send 10× fewer full snapshots. Every
  recording still starts with a full snapshot. A player that seeks from the nearest earlier full
  snapshot may fetch more data to reach a point deep in a long recording.
- **The warnings for removed options point to this package's README on npm.** The console warnings
  for `enableMasking`, `maskFields` and `eventSampleRate` now name the README section to read
  ("Migrating to 1.0.0" or "Migrating from 1.x to 2.0.0") and link to the npm package page, instead
  of a GitHub link.
- `package.json` no longer has `repository` and `bugs` fields.

## [2.1.0] — 2026-10-12

Stable release of the `2.1.0-rc.0` and `2.1.0-rc.1` line. Adds opt-in canvas capture to session
replay; nothing changes unless `options.replay.canvas.enabled` is set. No breaking changes from
`2.0.0`.

The shipped JavaScript (`index.js`, `index.mjs` and the replay worker) is byte-for-byte rc.1's. The
type declarations differ from rc.1 only in the `replay.canvas.fps` doc comment. Against `2.0.0`, the
declarations add `ReplayCanvasOptions` and the optional `replay.canvas` field, and the exported types
are otherwise unchanged.

### Added

- **Session replay can capture `<canvas>`-rendered content** (e.g. chart data series that replayed
  as empty frames) via `options.replay.canvas`. Off by default. `enabled` maps to rrweb
  `recordCanvas`, `fps` (default 1, clamped to 1–15 with a warning) to `sampling.canvas`, and
  `imageType` / `imageQuality` (default `image/webp` at 0.6) to `dataURLOptions`. Canvas frames are
  pixel snapshots: they increase replay bandwidth and page CPU, and are **not** covered by `privacy`
  text/input masking. WebGL capture is best-effort only (the page's context must use
  `preserveDrawingBuffer: true`).
- **`fps` sets CPU cost and time resolution, not bytes.** rrweb re-encodes every canvas on every
  tick whether or not it changed, so the rate drives CPU even on a static page; a frame identical to
  the previous one is dropped, so bytes grow only when content changes. For scale, 4 fps costs a few
  times the CPU of 1 fps for the same bytes. A canvas state shorter than `1/fps` seconds may not
  appear in the replay, so raise `fps` for animated canvases.
- **Changing `replay.canvas` through `updateConfig` restarts the active recording**, like
  `replay.blockedSelectors` and `privacy`. A partial update merges into the current canvas options,
  so `{ canvas: { fps: 8 } }` keeps capture enabled.
- **README: canvas capture recipes** for dashboards, animated canvases, constrained bandwidth and
  CPU-sensitive pages, with costs for scale.

### Fixed

- **rrweb recorder errors stay inside the SDK.** Observer failures that fire after `record()`
  returns are routed through the SDK's error handler instead of reaching the host page.
- **`updateConfig` restarts the recording only for keys the update itself sets.** An inherited
  (non-own) `privacy` or `replay` key no longer splits the recording without changing the config.

## [2.0.0] — 2026-10-06

Stable release of the `2.0.0-rc.0` and `2.0.0-rc.1` line. **Contains breaking changes from `1.x`** —
see [Migrating from 1.x to 2.0.0](./README.md#migrating-from-1x-to-200).

The shipped `dist/` is byte-for-byte rc.1's — nothing landed after it, in the browser package or in
the shared core it bundles; the version field, this entry and the migration guide's install command
are the only differences in the package. Network and exception shaping now live in the core shared
with `@groundcover/react-native`; the `/json/rum` envelope keeps its shape, and what changes on the
wire is listed below.

Against `1.0.9`, the exported `EventTypes`, `PrivacyOptions`, `Redactor`, `RedactField`, `RedactKind`
and `PrivacyLevel` are structurally identical. `SDKOptions` drops `eventSampleRate`, `init()` requires
`appId`, and `updateConfig()` no longer types `appId`. TypeScript enforces `appId` on every `init()`
call, but flags the two removed fields only where they are written directly in an object literal: a
variable or spread that also carries valid fields still compiles (an initialization config spread
into `updateConfig()`, say) and reaches the runtime handling below.

### Changed (breaking)

- **Event-level sampling is removed.** `options.eventSampleRate` warns and is ignored, on `init` and
  on `updateConfig`; use `options.sessionSampleRate` to select whole sessions. Rates are not
  converted.
- **`appId` is required and fixed per SDK instance.** It must be a non-blank string, its value is
  preserved exactly, the first successful `init` wins (later calls are ignored; a failed init may be
  retried), and `updateConfig` rejects any update that contains `appId`.

### Changed

- **`span_name` carries the upper-cased method**, like `operation.name`: `fetch(url, { method: "post" })`
  is the span `POST /path`, not a separate `post /path`. A missing method reads `UNKNOWN`.
- **An opaque host object passed without a key is labelled `opaque_node`** (was `dom_node`) by the
  enricher's placeholder. Keyed placeholders are unchanged.

### Fixed

- **`tracing.propagationUrls` treats only `*` as a wildcard.** Every other character kept its regex
  meaning, so `https://api.example.com/*` also matched `https://api-example.com/…` and trace headers
  (plus any `tracing.origin` header) were sent to lookalike hosts.
- **A path pattern such as `"/api/*"` matches same-origin requests only, whether they are written as
  relative or absolute URLs.** XHR requests opened with a relative URL were never matched (XHR stores
  the resolved URL), and a protocol-relative `//other-host/api/…` was. Patterns are matched against
  the URL the browser actually requests, so `https://app/api/../private` no longer matches
  `https://app/api/*`.
- **`fetch` events keep their trace ids when a configured header name has capitals.** `fetch` stores
  request headers lowercased, so `traceIdHeaderName: "X-Trace-Id"` or
  `propagationHeaders: ["X-Custom"]` never matched on read-back.
- **A read-only `fetch` no longer costs the XHR capture** (and no longer throws out of
  initialization); the two transports are instrumented independently.
- **Navigation instrumentation wraps the history methods present at initialization**, keeping a
  router that wrapped them after the SDK was constructed.

## [1.0.9]

Stable release of `1.0.9-rc.0`. The shipped `dist/` is byte-for-byte the RC's — nothing landed after
it, in the browser package or in the shared core it bundles; the version field and this entry are the
only differences in the package.

A wire-level ordering fix — sessions could report a start time later than events they carried,
producing negative session durations — plus two `enrichEvent` corrections. No API change and no
configuration change: the `/json/rum` envelope keeps the same shape, and only the value of
`session_start_time` on a rotated session changes.

### Fixed

- **A rotated session could report a `session_start_time` later than events it shipped with.** The
  new session's start was stamped from a second `Date.now()` read taken *after* the rotation's
  logging, buffer drain, host hooks and storage writes — milliseconds after the enricher had already
  timestamped the very event that triggered the rotation. So the event that opened a session could
  predate the session by a few milliseconds, and downstream that yields `endTime < startTime` and a
  negative `durationMilli`. The start is now derived from the earliest trusted time that belongs to
  the new session: the triggering event, any events a no-cluster flush left buffered, or the rotation
  instant when neither qualifies. Candidates are only trusted within one idle window and never in the
  future, so an `enrichEvent` that returns milliseconds where nanoseconds belong cannot backdate a
  session — which matters because the start time also drives the max-duration and inactivity clocks,
  and a 1970 value would otherwise rotate the session on every subsequent event. Rotations not driven
  by an event, the id/start write order, and the activity-clock reset that keeps a rotated session
  unconfirmed are all unchanged.

  Two cases are deliberately out of scope and still behave as before: a start stamped at SDK
  initialization (no events exist yet to reconcile against), and a client whose clock is uniformly
  wrong (the start, the events and the current reading all share one offset, so the SDK cannot detect
  it — the envelope stays self-consistent, but absolute correctness needs a trusted server clock).

- **`enrichEvent` no longer runs after session reconciliation.** The hook that drives session
  rotation fired *before* `enrichEvent`, but it is `enrichEvent`'s return value that enters the
  batch — so a hook that moved an event's timestamp earlier could ship an event predating the very
  session it opened, defeating the ordering guarantee above for a supported transformation.
  Reconciliation now runs on the final, enriched event, still before it is enqueued. `beforeSend`
  ordering is unchanged, `enrichEvent` still receives the pre-enrichment event, and a throwing
  `enrichEvent` still drops the event as before.

- **An unusable `enrichEvent` return value now drops the event.** The hook's result was cast to an
  event and buffered with no runtime check, so a callback that forgot to return, or returned a scalar
  or an object without a `type`, put `null` (or a bare value) into the `events` array on the wire. Such
  a result is now rejected and **the event is discarded**, matching what an `enrichEvent` that *throws*
  has always done. The un-enriched event is deliberately not sent as a fallback: `enrichEvent` is the
  documented way to scrub `sendCustomEvent` payloads (which are not auto-redacted), so shipping the
  original would leak exactly the data a failed scrubber was meant to remove. The SDK logs once rather
  than on every event. A well-formed result, including one that replaces the event object wholesale, is
  honoured exactly as before.

## [1.0.8]

Stable release of the `1.0.8-rc.0` … `1.0.8-rc.7` line, plus one fix that landed after rc.7 (passing
`console.assert()` calls are no longer captured — first item under **Fixed**).

The public API is unchanged: `EventTypes`, `SDKOptions`, `PrivacyOptions` and `Redactor` are
structurally identical to 1.0.7, the published bundle contains the same 10 files, and the
`/json/rum` wire format is unchanged (pinned by a golden characterization suite). The generated
declarations are no longer byte-for-byte identical to 1.0.7 — core's internal event types are now
generic over the event vocabulary so the React Native package can extend it — but the exported
surface is the same and `attributes.location` is still on the browser event map.

### Changed

- **`sessionSampleRate: 0` now samples nothing.** It was previously treated as "unset" by a falsy
  check, so configuring `0` sampled *every* session — the exact opposite of the intent. If you set
  `sessionSampleRate: 0` today and rely on the current (inverted) behaviour, sessions will stop
  being collected when you upgrade.
- **The session sampling verdict is now re-rolled per session.** It is documented as "decided once
  per session", but nothing ever removed the stored decision, so in practice it was decided once per
  browser-storage lifetime and every session after the first rotation inherited the original
  verdict. The decision is now cleared when a session rotates (inactivity gap, max-duration cap, or
  a new session id supplied by the host). Re-supplying the *same* session id is still a continuation
  and keeps its verdict.

### Fixed

- **A passing `console.assert()` is no longer captured as a log.** `console.assert(cond, …)` prints
  nothing when `cond` is truthy, but the SDK recorded *every* call as a `log` event — so assertions
  that passed silently filled RUM with lines the console itself never showed. Only failing
  assertions are captured now, matching the console's own semantics. Landed after `1.0.8-rc.7`.
- **`groundcover.startNavigation()` / `endNavigation()` can no longer throw into your code.** The
  manual navigation API read `location.href` with no error boundary, so on a page with an
  instrumented or restricted `location` getter the exception propagated out of the SDK and into the
  caller's own stack. The automatic navigation path was already contained; these two now are as
  well.
- **The current view's title is no longer discarded when view derivation fails.** The error boundary
  around the browser's view provider returned a hardcoded empty view, so a throw anywhere after the
  document title had already been read (a hostile `location` getter, a user-supplied redactor)
  silently dropped a title that was perfectly good — the no-location path has always preserved it.
  The title is now read first under its own guard, and both failure paths report through the SDK's
  error handler instead of swallowing: a view provider failing on every event is a real signal, not
  something to hide.
- **Session rotation could stop permanently if a host hook threw.** The in-progress flag was set
  before the host's rotation-context hook ran but only cleared in a `finally` that the hook sat
  outside, so a throw left it stuck — silently disabling all further session rotation for the life
  of the page. Not reachable through the browser SDK's own hook, but the surrounding error handling
  swallowed the throw without resetting the flag, so it would have failed invisibly.
- **Configuration option groups were shared between SDK instances.** `privacy`, `tracing`,
  `transport` and `replay` groups the caller didn't supply were held by reference from the shared
  defaults, so multiple SDK instances in one page aliased the same objects (and the module-level
  defaults themselves).
- **A failed batch send could raise an unhandled promise rejection** instead of logging, when
  `options` was absent on the resolved config.

### Internal

- The platform-agnostic pipeline (config, session policy, event enrichment, batching, redaction,
  transport) now lives in `@groundcover/rum-core`, an unpublished workspace package, inlined into
  this bundle at build time. It compiles with no DOM lib so platform coupling fails the build, and
  the network send, storage, device metadata and view derivation are injected by this package.
  Groundwork for the React Native SDK; no effect on the published browser artifact.

## [1.0.5]

### Added

- **Network request & response body capture.** `fetch` and XHR request/response bodies are recorded —
  including `fetch(new Request(url, { body }))` (openapi-fetch), where the body lives on the `Request`
  and was previously dropped. Bodies are read from a clone taken before the request is sent, so the
  app's copy is never consumed.

### Changed

- **Unified, fail-closed body capture across every path.** `init.body`, `Request`-object, XHR
  request/response, and fetch response capture now share one contract: each emits either a complete
  body within the size cap or a placeholder — never a truncated, partial, or binary body (which
  breaks `redactBody`'s structured pass and can leak nested secrets). Over-cap →
  `[request body too large]` / `[response body too large]`; slow or never-closing read →
  `[… body unavailable]`; binary/multipart classified by content-type → `[binary data]`, a typed
  label (`[image data]`, `[pdf data]`, …), or `[form data]`. Redaction runs *before* truncation so
  sensitive keys in a within-cap body are always masked.

### Fixed

- **Fetch response bodies are now hardened like request bodies.** Responses are classified
  by content-type (binary → placeholder, no mojibake) and their read is bounded by a timeout, so a
  slow or never-ending response stream can no longer stall the network event. An over-cap response is
  placeholdered instead of emitting an unredactable truncated slice.

## [1.0.2]

### Changed

- **Custom events no longer count as user-presence for session inactivity.** `sendCustomEvent` is a
  programmatic API commonly called from timers, background jobs and polling loops, so a custom event
  is no longer treated as proof a human is present: it does not refresh the activity clock and cannot
  trigger an inactivity-gap session rotation. Custom events still flush and still count toward the
  max-duration cap. Real interaction remains covered by `dom.event` / `navigation` / `pageload` and by
  the raw-input presence monitor (scroll / pointer / key / touch).

## [1.0.1]

### Fixed

- **README images now render on npm.** The logo used a relative path and the CI badge pointed at a
  private repository, so both 404'd on the npm package page. The logo is now served from the
  published package via jsDelivr and the CI-status badge was removed.

## [1.0.0]

First major release. This version restructures the configuration API by concern and finalizes the
privacy model. It contains **breaking changes** — see [Migrating to 1.0.0](./README.md#migrating-to-100).

### Changed

- **Breaking — `options` is restructured by concern.** Distributed-tracing, transport and replay
  knobs now live in nested groups, `environment` is de-duplicated (top-level only), and
  `userIdentifier` is renamed to `user`:

  | `0.x` | `1.0.0` |
  |---|---|
  | `userIdentifier` | `user` |
  | `options.tracePropagationUrls` | `options.tracing.propagationUrls` |
  | `options.tracePropagationHeaders` | `options.tracing.propagationHeaders` |
  | `options.tracePropagationTraceIdHeaderName` | `options.tracing.traceIdHeaderName` |
  | `options.tracePropagationSpanIdHeaderName` | `options.tracing.spanIdHeaderName` |
  | `options.traceOrigin` | `options.tracing.origin` |
  | `options.batchSize` / `options.batchTimeout` | `options.transport.batchSize` / `options.transport.batchTimeout` |
  | `options.enableCompression` | `options.transport.compression` |
  | `options.sessionReplay.blockedSelectors` | `options.replay.blockedSelectors` |

  Flat options (`debug`, `sessionSampleRate`, `eventSampleRate`, `enabledEvents`, `excludedUrls`,
  `sessionMaxDuration`, `beforeSend`, `enrichEvent`) and the `privacy` group are unchanged. Nested
  groups merge one level deep on `updateConfig` — and `tracing.origin` / `privacy.replay` one level
  deeper — so a partial update preserves sibling keys (e.g. updating `tracing.origin.name` keeps
  `origin.value`).

### Removed

- **Breaking — removed the deprecated masking flags `options.enableMasking` and `options.maskFields`.**
  Use `options.privacy` instead: `enableMasking: true` → `privacy.level: 'mask-all'`, explicit
  `enableMasking: false` → `privacy.level: 'allow'`, and `maskFields` → `privacy.maskSelectors` /
  `privacy.sensitiveKeys`. The removed flags are **ignored, not reinterpreted** — passing either one
  now emits a `console.warn` pointing to this migration so the change isn't silent.

### Included since the previous release

These shipped ahead of 1.0.0 and are part of this major:

- **Privacy on by default.** Unified `options.privacy` config drives masking for both session replay
  and non-replay events (DOM / network / logs / errors), defaulting to `mask-sensitive`. Sensitive
  request/response headers, bodies, and URL query params are redacted; built-in auth headers are
  always stripped. Opt out with `privacy.level: 'allow'`.
- **Web Worker offloading.** Session-replay packing and outgoing-batch gzip run in a dedicated inline
  worker, with a transparent main-thread fallback under strict CSP / sandboxed iframes / SSR.
- **Configurable, lazily-enforced `sessionMaxDuration`** (default 4h, range 1 min–8h) plus 30-minute
  inactivity-gap session rotation.
