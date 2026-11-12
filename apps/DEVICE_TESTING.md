# Device testing against a real groundcover backend

The mobile e2e suite ([`tests/e2e/mobile`](../tests/e2e/mobile)) runs every playground against a
**mock ingest** on `localhost:9393` and asserts on what the SDK *sent*. This guide covers the other
question: point a playground at a **real cluster** and check what the backend *stored*.

They catch different things. The mock proves the wire format; only a real backend proves delivery,
attribution, and how the three stores (events, logs, traces) reshape what arrives.

It applies to all four mobile playgrounds:

| App | SDK | Device-run setup |
| --- | --- | --- |
| [`rn-playground`](rn-playground) | `@groundcover/react-native` | [README → Device runs](rn-playground/README.md#device-runs-against-a-real-cluster) |
| [`flutter-playground`](flutter-playground) | `groundcover_rum` | [README → Device runs](flutter-playground/README.md#device-runs-against-a-real-cluster) |
| [`ios-playground`](ios-playground) | `GroundcoverRum` (native iOS) | [README → Device runs](ios-playground/README.md#device-runs-against-a-real-cluster) |
| [`android-playground`](android-playground) | `rum-android` (native Android) | [README → Device runs](android-playground/README.md#device-runs-against-a-real-cluster) |

A simulator or emulator pointed at a real cluster is a device run too. A physical phone adds
signing (iOS) or a USB install (Android) and nothing else.

---

## 1. Configure

Every playground reads the same five values, each from its own file kept out of git:

| Value | RN (`apps/rn-playground/.env`) | Flutter (a JSON file outside the repo) | iOS (`apps/ios-playground/device.xcconfig`) | Android (`apps/android-playground/device.properties`) |
| --- | --- | --- | --- | --- |
| Ingest host | `EXPO_PUBLIC_GC_DSN` | `GC_DSN` | `GC_DSN` | `gcDsn` |
| Ingest key | `EXPO_PUBLIC_GC_API_KEY` | `GC_API_KEY` | `GC_API_KEY` | `gcApiKey` |
| Preset | `EXPO_PUBLIC_GC_PRESET=device` | `"GC_PRESET": "device"` | `GC_PRESET = device` | `gcPreset=device` |
| Release id (optional) | `EXPO_PUBLIC_GC_RELEASE_ID` | `GC_RELEASE_ID` | `GC_RELEASE_ID` | `gcReleaseId` |
| Debug log (optional) | `EXPO_PUBLIC_GC_DEBUG=1` | `"GC_DEBUG": "1"` | `GC_DEBUG = 1` | `gcDebug=1` |

- **The DSN is the host only**, e.g. `your-cluster.groundcover.com`. The SDK adds `https://` and
  `/json/rum`; pasting the full ingest URL posts to `/json/rum/json/rum` and 404s.
- **Use an ingestion key, never a service-account key.** Every playground compiles the key into the
  build, so treat anything you put here as shipped.
- **A release id that differs per build** (a git sha works) tells two device builds apart when you
  read the data back.

### The `device` preset

`device` is the one preset not tuned for the mock ingest, in every app. The others flush every
500 ms, put a `traceparent` on every host the app calls (third parties included), report 1 s stalls
as hangs and log every event, which are all wrong on a real cluster. `device` instead:

- keeps the SDK's **shipping defaults**: no `native` overrides, so the hang threshold is 2 s on iOS
  and 5 s on Android, frame segments cap at 60 s, and batches flush on the default timer;
- sends `traceparent` only to the hosts the Network tab calls;
- turns the debug log off unless you ask for it;
- reports under cluster **`playground`**, environment **`device-test`**, with the app's own `appId`
  (`rn-playground`, `flutter-playground`, or `native-playground` for both native apps).

RN's `device` preset also turns compression off and excludes the Metro dev server's URLs; its
`src/config-presets.ts` says why.

**Confirm the preset took** on the app's Config tab, which shows `preset: device`. An unset preset
boots the e2e `default` preset, which still sends to your DSN: data arrives, looks plausible, and
is measured wrong.

**The debug log prints every batch, unredacted**, session attributes and identity included, to
`adb logcat` or the Xcode console. Use it to answer "is anything being sent at all?", then turn it
off: it also perturbs the frame timings a device run measures.

**Release builds embed their config.** Every native and Flutter build, and an RN release build,
compiles these values in. After editing the file, rebuild and reinstall; restarting Metro changes
nothing on a release build.

---

## 2. Check the key before building

The apps give no sign that a batch was rejected: a wrong key looks like an app that reports
nothing. Check the key against the ingest endpoint first. The prompts keep the key out of your
shell history (they work in zsh and bash alike), and curl reads the header from stdin so the key
stays out of `ps`:

```bash
printf 'Ingest host: '; read -r GC_DSN
printf 'Ingest key: '; stty -echo; read -r GC_KEY; stty echo; echo
printf 'header = "apikey: %s"\n' "$GC_KEY" |
  curl -s -w '\n%{http_code}\n' -K - -X POST "https://$GC_DSN/json/rum" \
    -H 'Content-Type: application/json' \
    -d '{"sessionAttributes":{},"events":[]}'
```

The body prints above the status code, because two of the `401`s differ only in the body:

| Response | Meaning |
| --- | --- |
| `200` | The key is good. |
| `404` | Nothing serves `/json/rum` on that host: check the DSN. |
| `401 No API key found in request` | The header never arrived: check the header name. |
| `401 Unauthorized` | The key was rejected: it is revoked, from another cluster, or a service-account key. |

A `200` means the receiver accepted the batch. It doesn't prove the data was stored or that reads
work.

| Key | Used for | On `/json/rum` |
| --- | --- | --- |
| Ingestion key | sending telemetry | ✅ |
| Service-account key (`gcsa_…`) | reading through the API (section 5) | ❌ `401` |

---

## 3. Build and install

Each app's README has its device-run build commands (links in the table at the top). Three rules
hold for all of them:

- **Native code reaches the app only through a native rebuild.** The engine each SDK compiles is a
  git-ignored copy written by `node scripts/vendor-engine.mjs` (run from the repo root), and
  `pnpm install` writes it too. After an engine change, write the copy again before building.
- **RN bundles the SDK's built `dist/`, not `src/`.** Run
  `pnpm --filter @groundcover/react-native build` before building the app.
- **Physical iPhones need signing.** Use Xcode with an Apple ID (free accounts expire after 7 days
  and only cover phones plugged into your Mac) or a paid team for TestFlight or ad-hoc builds.
  Give the app a bundle ID that is unique to you.

---

## 4. What to exercise, and in what order

Walk every tab, then run the destructive signals **last**:

1. **Taps**: well-tagged, bare, masked, accessibility-annotated; type into the field and leave it;
   push and pop Detail.
2. **Network**: every client the tab offers, including the POST that carries request and response
   bodies.
3. **Logs**: the platform logger, the SDK logger, handled errors, the privacy fixtures. Scroll
   before tapping: some controls sit below the fold on a small screen.
4. **Custom and Config**: the custom event, `identifyUser`, and the session id, which you need in
   section 5.
5. **Native**: scroll the list for gestures, then switch tabs and come back so the frame segments
   close.
6. **Hang**, then **crash**, then **relaunch**, then **background**.

**Leave at least 15 s between the hang and the crash.** Batches flush every 10 s by default; a
crash sooner kills the process with the hang event still buffered.

**The hang button blocks for 3 s.** That crosses iOS's 2 s threshold but not Android's 5 s one, so
under the `device` preset a hang reports on iOS only. That is the threshold working, not a defect.

**A crash is reported on the next launch**, attributed to the session that died. Relaunch and tap
something: nothing ships before an interaction confirms the new session.

**Repeat anything probabilistic.** If a signal is missing once, run it several times before
concluding it was not sent.

---

## 5. Read the data back

### In the UI

Open the RUM view on the cluster you sent to, and:

- select **all clusters**: the default cluster filter hides `playground`;
- widen the time range: the table's error, screen and user columns count only the events inside it;
- search for the session id from the Custom tab.

### Through the API

[`scripts/dump-rum.sh`](scripts/dump-rum.sh) pulls one session's raw records out of all three
stores, so you can inspect what landed rather than a summary of it. It needs a **service-account**
key (`gcsa_…`), not the ingestion key:

```bash
GC_API_HOST=https://api.<your cluster host> \
GC_API_KEY=<gcsa_… service-account key> \
GC_SESSION_ID=<session id from the Custom tab> \
  apps/scripts/dump-rum.sh ./dumps 60
```

It queries `session_id:"<id>"`, which every store answers. `GC_QUERY` replaces the query with any
other gcql predicate. gcql takes a bare predicate: a leading `| filter …` is a syntax error.

The three stores don't share a schema, and naive cross-store parsing silently returns nothing:

- **events**: attributes live in the `string_attributes` and `float_attributes` maps, and the event
  kind is the top-level `type`. Numbers appear in both maps; pick one. Gesture provenance is
  `interaction_gesture.capture_source`, not `capture_source`.
- **traces**: the useful fields are top-level (`span_name`, `http_status_code`, `request_body`,
  `response_body`).
- **logs**: the message and level are top-level.

The script queries each store separately and prints a record count per file. When a dump comes
back short, run it again before concluding anything.

### Reading tips

- The same main-thread stall is `ANR` on Android and `AppHang` on iOS (`error_fingerprint`), so a
  cross-platform hang query needs both.
- The `namespace` column stays empty unless the app sets `namespace` in its config. No playground
  does.

---

## Gotchas

- **One Metro per machine for RN.** A Metro left running by another checkout owns port 8081 and
  serves *its* bundle and `.env`: the app then runs the wrong code against the wrong DSN. Stop it
  with `pkill -f "expo start"`. Never `lsof -ti:8081 | xargs kill`: `adb reverse` gives the
  emulator an open socket on 8081, so that kills the emulator too.
- **Check the bundle Metro serves** when an RN result is surprising:
  `curl -s "http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&minify=false" | grep -c "<a string only the new build has>"`.
- **CocoaPods needs a UTF-8 locale.** Without `export LANG=en_US.UTF-8`, `pod install` (and so RN's
  prebuild) fails with `Unicode Normalization not appropriate for ASCII-8BIT`.
- **SwiftUI taps on a real device carry less than in e2e.** With accessibility off, as for real
  users, the native iOS SDK names a SwiftUI button by role and component only, with no label. The
  e2e driver turns accessibility on, so the suite sees labels a device run won't.
- **Terminate the app after a run.** A foregrounded iOS app files a frame segment every 60 s while
  idle, so its session keeps growing.
