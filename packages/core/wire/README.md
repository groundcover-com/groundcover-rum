# Wire fixtures

The part of the `/json/rum` wire contract every groundcover SDK shares, as plain JSON. Each file
is one request exactly as the SDK sends it, so it reads as "this call puts this on the wire". There
is no format to learn: every SDK's golden test makes the call, takes the request, and deep-compares
it with the file.

| SDK | Golden test |
| --- | --- |
| `@groundcover/browser` | `packages/browser/src/wire-format-golden.test.ts` |
| `@groundcover/react-native` | `packages/react-native/src/wire-format-golden.test.ts` |
| `groundcover_rum` | `packages/flutter/test/wire_format_golden_test.dart` |
| `GroundcoverRum` (iOS) | `packages/ios/Tests/GroundcoverRumTests/Core/WireFormatGoldenTests.swift` |
| `rum-android` | `packages/android/rum-android/src/test/kotlin/com/groundcover/rum/core/WireFormatGoldenTest.kt` |

The iOS golden reads these files from its test bundle, through the `Wire` symlink next to it: a
simulator test can't always read the checkout itself.

## Files

| File | The request after presence and this one call |
| --- | --- |
| `config.json` | Not a request: the SDK config every golden starts from (a bare-host DSN, `batchSize: 0` so every flushing event sends, compression off). |
| `custom-event.json` | `sendCustomEvent("purchase", {"amount": 42, "nested": {"sku": "abc"}})` |
| `log-event.json` | a `warn` log, `"golden log line"`, with `{"context": "checkout"}` |
| `exception-event.json` | `captureException` of a handled `Error("golden failure")` with metadata `{"stage": "test"}` |
| `exception-repeat-event.json` | Browser and React Native only, until the other SDKs merge repeats. With `config.json` but `transport.batchSize: 10`, so the calls share one batch: the same `captureException` as above, made from one call site at +0 s, +1 s and +2 s, then the app is hidden or backgrounded. The flush sends one request with one exception: the first occurrence, with `error_repeat_count: 3`. |

Presence is the platform's genuine user signal: a pointer event on the web, a tap on mobile.

## Checking one

1. Fix the clock at **1 800 000 000 000 ms** (2027-01-15T08:00:00Z). The times in the files are
   the nanosecond values that gives, so a millisecond value or a wrong start is a different number.
2. Start the SDK with `config.json`, send presence, make the call, and let the send finish. The
   SDK must send exactly one request.
3. Take out what the files leave out:
   - the random ids, after checking their format: `sessionAttributes.session_id` and each event's
     `id` (32 lowercase hex), `spanId` (16 lowercase hex) and `traceId` (16 zeros, then 16
     lowercase hex);
   - what only this platform sends: its own event types (the browser's `pageload`, a tap's
     `interaction`), session attributes (`browser`, `userAgent`; `app`, `device`, `os`, `source`)
     and event attributes (`location`, `screen`);
   - `error_stacktrace`, whose frames are each platform's own.
4. Deep-compare the rest with the file: `url`, `headers`, and the decoded body. Nothing may be
   missing or extra. Nanoseconds near 1.8e18 step in 256 ns as a double, so a port holding exact
   64-bit integers compares them as doubles.

## Behaviour every golden also tests

Not files: these are plain tests, written in each SDK's own golden. The TS goldens hold the
reference versions, under these names:

- **Presence gate:** nothing is sent before genuine user presence, and events held before it ship
  once it comes ("does not transmit anything before genuine … presence").
- **Sampling:** with `sessionSampleRate: 0` nothing is sent, even after presence.
- **Session identity:** every flush in one session carries the same `session_id`, and it is the
  id the SDK reports.
- **Session start:** no batch claims its session started after an event it carries. Consumers
  derive session duration from last event − `session_start_time`.
- **Rotation ordering:** a session rotated by `sessionMaxDuration` never starts after the event
  that triggered it, both when time passes while the trigger is sent (a `beforeSend` that moves
  the clock) and when an `enrichEvent` moves the trigger's timestamp earlier.

## Changing one

A file changes only when what core sends changes on purpose. Edit it by hand to the new request;
the diff is the wire change. Then run every golden. One that fails is a real divergence: fix that
SDK, defaulting to the browser's behaviour.
