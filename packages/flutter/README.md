<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@groundcover/browser/assets/logo.png" alt="groundcover" width="240" />
</p>

<h1 align="center">RUM — Flutter SDK</h1>

<p align="center">
  <a href="https://pub.dev/packages/groundcover_rum"><img src="https://img.shields.io/pub/v/groundcover_rum.svg?include_prereleases" alt="pub version" /></a>
</p>

groundcover's Real User Monitoring (RUM) SDK for Flutter apps on iOS and Android. It sends the same
`/json/rum` format as [`@groundcover/browser`](https://www.npmjs.com/package/@groundcover/browser)
and [`@groundcover/react-native`](https://www.npmjs.com/package/@groundcover/react-native), so
Flutter sessions land in the same backend and dashboards as your web and React Native RUM.

The SDK captures sessions, network requests with distributed tracing, screen navigation, taps,
typing and gestures, errors, logs, custom events and user identity in Dart. Through a native engine
compiled into the plugin it also captures **native crashes, app hangs (ANR), app start and time to
interactive**, and from Flutter's own frame timings, **frame vitals**. Privacy masking is **on by
default**.

> **Release candidate.** Session replay is not included. iOS and Android only: Flutter web apps
> use [`@groundcover/browser`](https://www.npmjs.com/package/@groundcover/browser), and desktop
> isn't supported.

See the [groundcover RUM documentation](https://docs.groundcover.com/investigate/real-user-monitoring-rum)
for the product guide; this README is the Flutter SDK's documentation.

---

## Table of contents

- [Install](#install)
- [Before you start](#before-you-start)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Privacy & data masking](#privacy--data-masking)
- [What is captured](#what-is-captured)
- [Network capture](#network-capture)
- [Errors](#errors)
- [Native features](#native-features)
- [Architecture](#architecture)
- [Coverage & limitations](#coverage--limitations)
- [Session lifecycle](#session-lifecycle)
- [Performance considerations](#performance-considerations)
- [Testing your app](#testing-your-app)
- [API reference](#api-reference)

---

## Install

```bash
flutter pub add groundcover_rum:0.0.1-rc.4
```

The native side is a regular Flutter plugin. iOS builds it through Swift Package Manager or
CocoaPods (either works, and both bring [KSCrash](https://github.com/kstenerud/KSCrash) for crash
capture), and on Android the plugin declares the `INTERNET` permission itself, since the Flutter
app template grants it only to debug and profile builds.

One thing to check on iOS: the plugin needs iOS 13.4 or later. Apps created before Flutter 3.47
target iOS 13.0 by default. Raise the Runner target's minimum deployment to 13.4 in Xcode, and with
CocoaPods also set `platform :ios, '13.4'` in `ios/Podfile`.

### Supported vs tested

**Supported** is what the code requires: every API the SDK uses sits at or below these floors, and
anything above them is version-guarded per feature. **Tested** is what CI builds and runs on a
device for every change.

| | Supported | Tested every build |
|---|---|---|
| Flutter | `>= 3.44` (Dart 3.12) | 3.47.5, debug builds |
| iOS | 13.4+ | Simulator (iPhone 17 Pro) under the latest stable Xcode |
| Android | API 23+ | Emulator, API 34 |

Your app's own floor is the higher of these and your Flutter version's: apps created with
Flutter 3.47 target iOS 15 and Android API 24. The untested span is not known to be broken; it is
unproven. If you run the SDK outside the tested row and hit something, please open an issue at
https://github.com/groundcover-com/groundcover-rum/issues.

---

## Before you start

`init` needs three values from your groundcover account:

- **`apiKey`**: an ingestion key of type **RUM**, from **Settings → Access → Ingestion Keys**.
- **`dsn`**: your groundcover ingestion endpoint, such as `https://example.platform.grcv.io`.
- **`cluster`**: the cluster name your RUM data is filtered by.

groundcover's RUM data source wizard shows all three: its React Native snippet has your key, `dsn`
and `cluster` filled in, and the Flutter config takes the same values.

---

## Quick start

Await `init` before `runApp`, wrap the app in `GroundcoverWidget`, and add the navigator observer:

```dart
import 'package:flutter/material.dart';
import 'package:groundcover_rum/groundcover_rum.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await GroundcoverRum.init(const GroundcoverConfig(
      apiKey: 'your-rum-ingestion-key',
      dsn: 'https://example.platform.grcv.io', // a bare host gets https://
      cluster: 'your-cluster',
      environment: 'production',
      appId: 'my-app',
      releaseId: '1.0.0',
      options: GroundcoverOptions(
        // Send distributed-tracing headers to your own API hosts:
        tracing: TracingOptions(propagationUrls: ['https://api.myapp.com/*']),
      ),
    ));
  } on GroundcoverInitException catch (error) {
    // The SDK couldn't start, and the app runs unmonitored. Caught, a
    // monitoring failure never keeps the app from opening.
    debugPrint('groundcover: $error');
  }
  // Above MaterialApp: taps, typing and gestures are read from here.
  runApp(const GroundcoverWidget(child: MyApp()));
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    // Navigations between named routes. With go_router:
    // GoRouter(observers: [GroundcoverNavigatorObserver()], routes: ...)
    navigatorObservers: [GroundcoverNavigatorObserver()],
    routes: {'/': (_) => const HomeScreen()},
  );
}
```

- **Await `init`**. It completes once the SDK runs (a
  session that isn't sampled included), typically within tens of milliseconds: one native round
  trip for the saved session and the device info, which times out after 3 seconds and starts the
  SDK with empty storage rather than fail. **Calls made before it completes are dropped** with a
  warning, unlike the React Native SDK, which queues them. The one exception is
  `markAppInteractive`, which records when it was called whenever that is.
- **It throws `GroundcoverInitException`** when the SDK can't start: a blank `appId`, a call off the
  root isolate, or a failed start, whose error is the exception's `cause`. Catch it, as above, so
  the app still opens. Calling `init` again retries; until one succeeds, the first SDK call warns
  once that init failed and why. A call while one is starting, or after one started, gets that
  one's result.
- **`GroundcoverWidget`** goes above `MaterialApp`. It adds nothing to the layout and observes
  pointers without taking any from the app. It reads taps and gestures, and a pointer down anywhere
  confirms the session: until the user touches the app or brings it back to the foreground, nothing
  is sent, so a launch nobody sees (a background fetch, a push) sends no events. Keep it even with
  `interaction` turned off, or only a return to the foreground confirms a session. Crash reports
  from earlier launches are the exception: they go out at every launch.
- **`GroundcoverNavigatorObserver`** turns each change of the top named route into a `navigation`
  event and stamps the current screen on every event. A route without a name isn't tracked: see
  [Naming screens](#naming-screens).
- **Zones.** The SDK needs no zone of its own. If the app runs in `runZonedGuarded`, call
  `ensureInitialized`, `init` and `runApp` all inside the zone, and call
  `GroundcoverRum.captureException` from the zone's handler: an uncaught async error in a guarded
  zone goes to that handler, not to the `PlatformDispatcher.onError` the SDK listens to. Sent
  through `captureException`, those errors arrive with `error_handled: true`. Framework errors
  (`FlutterError`) still arrive by themselves.

### Naming screens

The observer names a screen from its route's `RouteSettings.name`, and **a route without a name is
not tracked**: it sends no `navigation` event, and events on it carry the screen before it. A
`MaterialPageRoute` pushed directly has no name unless you give it one:

```dart
Navigator.of(context).push(
  MaterialPageRoute(
    settings: const RouteSettings(name: 'Checkout'),
    builder: (_) => const CheckoutScreen(),
  ),
);
```

- **Named routes** (`routes:` and `pushNamed`) are named already. In `onGenerateRoute`, pass the
  `settings` it receives on to the route you build (`MaterialPageRoute(settings: settings, ...)`):
  Flutter doesn't name that route for you, and without it the route isn't tracked.
- **go_router**: a route's `builder` page is named after the route's `name`, or its path. A
  `pageBuilder` builds its own page, so pass the name on:
  `pageBuilder: (context, state) => MaterialPage(name: state.name ?? state.path, child: ...)`.
  Navigations inside a `ShellRoute` reach the router's observers from go_router 17; on earlier
  versions, give the shell route its own `observers: [GroundcoverNavigatorObserver()]`.
- **Dialogs and bottom sheets** are mostly unnamed, so the screen they open over stays current.
- **Anything else** (a tab bar that switches without a route change, a custom router): call
  [`startNavigation` / `endNavigation`](#navigation).

### Check that data arrives

1. Set `debug: true` in `GroundcoverOptions` for the first run. Errors are silent without it: a
   wrong key or `dsn` fails each batch with nothing in the console, and an empty `cluster` holds
   every event.
2. Run the app and **touch it once**. Nothing is sent until a touch, or a return to the
   foreground, confirms that a user is there.
3. Within about 10 seconds the console shows `[groundcover] Sending batch:` and the events. A
   `Network error while sending batch:` line names the problem: `the ingest answered 401` is the
   key, and a connection error is the `dsn`.
4. In groundcover, open **RUM**. It shows web sessions by default: switch the dropdown in the header
   from **Web** to **Mobile**.

Turn `debug` off again for release builds.

From there, enrich the data:

```dart
GroundcoverRum.identifyUser(const RumUser(id: 'u_123', email: 'user@example.com', organization: 'acme'));
GroundcoverRum.captureException(error, stackTrace: stackTrace, metadata: {'feature': 'checkout'});
GroundcoverRum.logger.warn('Payment retry', {'provider': 'stripe', 'attempt': 2});
GroundcoverRum.sendCustomEvent('plan_upgraded', {'plan': 'pro'});
```

---

## Configuration reference

`GroundcoverRum.init` takes a `GroundcoverConfig`: connection and identity at the top level, and
every behavioural option under `options`, grouped by concern. Names follow the React Native SDK's,
in Dart's types: a `Duration` where RN takes milliseconds (`hangThreshold` for `hangThresholdMs`), a
`Pattern` where it takes `string | RegExp`, an enum where it takes a string (`PrivacyLevel.maskAll`
for `"mask-all"`).

```dart
GroundcoverConfig(
  // Connection & identity
  apiKey: ..., dsn: ..., cluster: ..., environment: ..., appId: ...,
  namespace: ..., releaseId: ..., user: ..., sessionId: ...,

  options: GroundcoverOptions(
    enabledEvents: ..., sessionSampleRate: ..., sessionMaxDuration: ...,
    debug: ..., excludedUrls: ...,
    appVersion: ..., appBuild: ...,
    beforeSend: ..., enrichEvent: ...,
    privacy: PrivacyOptions(...),
    tracing: TracingOptions(...),
    transport: TransportOptions(...),
    native: NativeOptions(...),
  ),
)
```

### Top-level (connection & identity)

| Field | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `String` | ✅ | An ingestion key of type RUM (see [Before you start](#before-you-start)). With an empty key nothing is sent. |
| `dsn` | `String` | ✅ | Your groundcover ingestion endpoint, with or without a scheme; a bare host gets `https://`. Batches go to `{dsn}/json/rum`. |
| `cluster` | `String` | ✅ | Target groundcover cluster. With an empty cluster, events are held, up to 500, rather than sent. |
| `environment` | `String` | ✅ | Deployment environment, such as `production` or `staging`. |
| `appId` | `String` | ✅ | The application's identity, reported as the service name. Must not be blank (`init` throws), and is fixed at init. |
| `namespace` | `String?` | — | Logical grouping for the app. |
| `releaseId` | `String?` | — | Release identifier, such as a semver or a commit hash. |
| `user` | `RumUser?` | — | The user at init; the same shape as [`identifyUser`](#identifyuser). |
| `sessionId` | `String?` | — | Start with this session id instead of a generated or persisted one, to share one session across surfaces. A new id starts a new session; the id already stored continues it, unless that session has expired, when a generated id replaces it. |
| `options` | `GroundcoverOptions?` | — | Behavioural options, below. |

### `options`: top-level knobs

| Option | Type | Default | Description |
|---|---|---|---|
| `enabledEvents` | `List<RumEventName>?` | all | Which signals to capture. **Null or empty means all.** Members: `interaction`, `network`, `logs`, `navigation`, `exceptions`, and the [native](#native-features) `crashes`, `hangs`, `appStart`, `vitals`. Fixed at init. |
| `sessionSampleRate` | `double?` | `1` | The share of sessions to record, from 0 to 1, drawn at `init`. See [Session lifecycle](#session-lifecycle). Fixed at init. |
| `sessionMaxDuration` | `Duration?` | 4 hours | Target longest session, between 1 minute and 8 hours. Outside that, a warning, and the default at init or the current value in an update. See [Session lifecycle](#session-lifecycle). |
| `debug` | `bool?` | `false` | Prints the SDK's diagnostics, each batch it sends included, with a `[groundcover]` prefix. Misconfiguration warnings print whatever this says. |
| `excludedUrls` | `List<Pattern>?` | none | Requests the network capture skips. See [below](#excludedurls). The SDK's own ingest requests are always skipped. |
| `appVersion` | `String?` | the bundle's | The app version on the session attributes. See [App version stamping](#app-version-stamping). Fixed at init. |
| `appBuild` | `String?` | the bundle's | The app build on the session attributes. Fixed at init. |
| `beforeSend` | `bool Function(RumEvent)?` | none | Drop gate: return `false` to discard an event. See below. |
| `enrichEvent` | `RumEvent Function(RumEvent)?` | none | Change an event before it is queued, and return it. See below. |
| `privacy` | `PrivacyOptions?` | masking on | See [Privacy & data masking](#privacy--data-masking). |
| `tracing` | `TracingOptions?` | none | See [`options.tracing`](#optionstracing). |
| `transport` | `TransportOptions?` | see below | See [`options.transport`](#optionstransport). |
| `native` | `NativeOptions?` | see below | Tuning for the [native features](#native-features). Fixed at init. |

#### `beforeSend` / `enrichEvent`

Both hooks receive each event after privacy redaction and the SDK's own enrichment, with its
attributes **dot-flattened**: the exact shape the SDK puts on the wire. A tap's
`interaction_target: {label: ...}` arrives as the key `'interaction_target.label'`, and a network
request's URL as `'url.full'`. The one nested exception is `screen` (`{name, key}`), which is added
after flattening. Timestamps are nanoseconds since the epoch.

| `RumEvent` field | Type | Meaning |
|---|---|---|
| `type` | `String` | The event kind (below). Read-only. |
| `id` | `String` | The event's id. Read-only. |
| `attributes` | `Map<String, Object?>` | The flattened attributes. |
| `timestamp` | `int?` | When it happened. Null on a network event, which has the next two instead. |
| `startTimestamp` / `endTimestamp` | `int?` | A network request's start and end. |
| `traceId` / `spanId` / `parentSpanId` | `String?` / `String` / `String?` | Trace context; a traced request's ids are the ones its headers carried. |
| `spanName` | `String?` | `"METHOD path"`, on network events only. |

`toJson()` gives the event as the wire carries it.

`RumEvent.type` is one of `interaction`, `network`, `log`, `navigation`, `custom`, `exception` and
`performance`. `beforeSend` runs first, then `enrichEvent`, which may change anything but `type` and
`id`:

```dart
options: GroundcoverOptions(
  beforeSend: (event) =>
      // Attributes are flat: read them with the dotted key.
      !(event.type == 'network' &&
          '${event.attributes['url.full']}'.contains('/health')),
  enrichEvent: (event) => event..attributes['tenant'] = 'acme',
),
```

A hook isn't a constant, so drop `const` from `GroundcoverConfig` when you pass one. A hook that
throws drops the event. What a hook prints, and anything it sends through
`GroundcoverRum`, is dropped too: sent, it would run the hook again, and again. On the
[crash path](#crash-delivery) the hooks run as well.

#### App version stamping

`appVersion` and `appBuild` go on the session attributes as `app.version` and `app.build` (`app.id`
comes from `appId`). Left out, they are read from the bundle: `CFBundleShortVersionString` and
`CFBundleVersion` on iOS, `versionName` and the version code on Android. A configured value wins.

#### `excludedUrls`

| Pattern | Matches |
|---|---|
| `RegExp` | Anywhere in the URL. |
| `String` with `*` or `?` | A glob, anywhere in the URL: `*` is any run of characters. `?` currently matches only a literal `.`, so for a URL with a query string use a `RegExp`, or a `*` where its `?` is. |
| Any other `String` | The whole URL, exactly. |

URLs are matched as `dart:io` prints them: lower-case host, no default port.

### `options.privacy`

Data masking, **on by default**. See [Privacy & data masking](#privacy--data-masking) for the full
reference.

### `options.tracing`

Distributed-tracing headers on outgoing requests.

| Option | Type | Default | Description |
|---|---|---|---|
| `propagationUrls` | `List<String>?` | none | Request URLs that get tracing headers: each matched against the **full** URL, with `*` as the only wildcard. |
| `propagationHeaders` | `List<String>?` | `['traceparent']` | Header names that carry the W3C trace context. When set, they replace `traceparent`: list it too to keep it. |
| `traceIdHeaderName` | `String?` | none | An extra header carrying the trace id, in decimal. |
| `spanIdHeaderName` | `String?` | none | An extra header carrying the span id, in decimal. |
| `origin` | `TracingOrigin?` | none | An extra header, `origin.name: origin.value`, on traced requests. |

```dart
options: GroundcoverOptions(
  tracing: TracingOptions(propagationUrls: ['https://api.myapp.com/*']),
),
```

> Only `*` is a wildcard in `propagationUrls`; every other character matches literally, so an
> unescaped `.` can't send your trace headers to a look-alike host. A path-only pattern such as
> `'/api/*'` matches nothing (the SDK warns once at startup): with no origin to scope it to, it
> would send your trace headers to every host serving that path.

The trace context is `traceparent: 00-<trace id>-<span id>-01`. The SDK's headers replace any the
request already set under the same names, and a name that isn't a valid HTTP header name is skipped.

Trace headers go only on requests the SDK captures: not on one `excludedUrls` matches, not with
`network` left out of `enabledEvents`, not before `init` completes, and not in a session that isn't
sampled. A redirect `dart:io` follows for the app carries them to its target, whatever host that
is.

### `options.transport`

Batching and delivery.

| Option | Type | Default | Description |
|---|---|---|---|
| `batchSize` | `int?` | `10` | Events buffered before a batch is sent; `0` sends each event as it comes. Navigation, interaction and performance events never trigger a send on their own: they go with the next one, or on the timeout. A negative value means the default. |
| `batchTimeout` | `Duration?` | 10 s | Longest a batch waits before it is sent anyway. Zero or less means the default. |
| `compression` | `bool?` | `true` | Gzip outgoing batches. |

### `options.native`

| Option | Type | Default | Description |
|---|---|---|---|
| `hangThreshold` | `HangThreshold?` | 2 s on iOS, 5 s on Android | How long the main thread must be blocked before a hang is reported. iOS has no system hang bar; Android's own ANR bar is 5 s. `HangThreshold(duration)` sets both platforms; `HangThreshold.perPlatform(ios: ..., android: ...)` sets one or both, and a platform left out keeps its own default. Outside 250 ms to 60 s, the default. |
| `vitalsMaxSegment` | `Duration?` | 60 s | Longest a frame-vitals segment runs before it is closed anyway. Segments end on a screen change or on backgrounding: this is a safety valve, not a cadence. Outside 1 s to 5 minutes, the default. |
| `tti` | `TtiMode?` | `TtiMode.auto` | What counts as interactive for [time to interactive](#time-to-interactive). |

These tune the native features; `enabledEvents` is the one way to turn one off.

### Updating config at runtime

`GroundcoverRum.updateConfig(GroundcoverConfigUpdate(...))` changes the configuration after init.
`GroundcoverConfigUpdate` takes `apiKey`, `dsn`, `cluster`, `environment`, `namespace`,
`releaseId`, `user`, `clearUser` and `options`, a `GroundcoverOptionsUpdate` with every option
that isn't fixed at init. What is fixed at init isn't part of the update types, so an update can't
look as if it changed it:

- **`appId`** is the application's identity.
- **`sessionId`** isn't a config value: use [`setSessionId`](#getsessionid--setsessionid).
- **`enabledEvents`**, **`sessionSampleRate`**, **`appVersion`**, **`appBuild`** and **`native`**:
  listeners and the native engine are set up once, and the sampling verdict is drawn then, so a
  later value would say one thing while the SDK did another. Configure the next launch instead.

In an update, null means "unchanged". `privacy`, `tracing` and `transport` merge field by field, so
a partial update keeps the group's other fields; `excludedUrls` and the hooks are replaced whole. A
hook set at init can be replaced but not removed. Empty strings are ignored, so an update can't
clear `namespace` or `releaseId`.

```dart
GroundcoverRum.updateConfig(const GroundcoverConfigUpdate(
  options: GroundcoverOptionsUpdate(
    transport: TransportOptions(batchSize: 20), // batchTimeout and compression kept
    privacy: PrivacyOptions(level: PrivacyLevel.maskAll),
  ),
));
```

A new `user` merges into the current identity. To forget it, on logout for example, set
`clearUser`:

```dart
GroundcoverRum.updateConfig(const GroundcoverConfigUpdate(clearUser: true));
```

---

## Privacy & data masking

Masking is **on by default** (`PrivacyLevel.maskSensitive`). One `level` is the master switch;
per-surface toggles and a custom hook refine it.

| `level` | Network, logs, errors | Interaction labels |
|---|---|---|
| `maskSensitive` **(default)** | Sensitive fields redacted: bodies, query parameters, headers, log and error fields | Captured |
| `maskAll` | Same as `maskSensitive` | Also masked: the label, hint and value text of every interaction |
| `allow` | Nothing the app sends is redacted, except sensitive headers (below) | Captured |

> **Sensitive headers are always redacted, even under `allow`.** The headers in
> [Built-in sensitive patterns](#built-in-sensitive-patterns) keep their name and have their value
> replaced with `[REDACTED]` at every level.
>
> **Typed text is never captured at any level.** An input interaction records that a field was
> edited and which one, never the value.

### Apple privacy manifest

The iOS plugin ships a `PrivacyInfo.xcprivacy`, bundled through Swift Package Manager and
CocoaPods alike, with the same answers as the React Native and native iOS SDKs. It declares the
required-reason APIs the SDK calls (UserDefaults, `CA92.1`; file timestamps, `C617.1`) and the data
it collects: crash data, performance data, other diagnostic data and product interaction, plus user
ID, email address and name if you pass them to `identifyUser` (or `user` in `GroundcoverConfig`).
All of it is marked as linked to the user, since once you identify users every event carries that
identity, and none of it is used for tracking.

Xcode's privacy report (Organizer → Control-click an archive → **Generate Privacy Report**) merges
this with your app's other manifests. Use it as the starting point for your App Store privacy
labels: drop email or name there if your app never sends them, and declare whatever `properties`
holds.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `level` | `PrivacyLevel?` | `maskSensitive` | The master switch. |
| `maskNetworkBodies` | `bool?` | `true`¹ | Redact request and response bodies. |
| `maskNetworkQueryParams` | `bool?` | `true`¹ | Redact URL query parameters. |
| `maskLogs` | `bool?` | `true`¹ | Redact log messages and attributes. |
| `maskErrors` | `bool?` | `true`¹ | Redact error messages and metadata. Stack frames are sent as they are. |
| `sensitiveKeys` | `List<String>?` | none | Extra case-insensitive key substrings to treat as sensitive, added to the built-ins. |
| `redact` | `Redactor?` | none | A per-leaf hook (below). |
| `maskInteractionLabels` | `bool?` | on only under `maskAll` | Mask interaction labels, hints and values under any level. The role, component, component path and state stay: they are structural. |

¹ Each `mask*` toggle defaults **on** unless `level` is `allow`, which turns them all off.

```dart
options: GroundcoverOptions(
  privacy: PrivacyOptions(
    sensitiveKeys: ['account_no'],
    maskInteractionLabels: true, // mask labels without going all the way to maskAll
  ),
),
```

#### Built-in sensitive patterns

Always treated as sensitive, case-insensitively; your `sensitiveKeys` are added on top.

- **Key substrings**, matched inside a body or query key: `token`, `secret`, `passwd`, `password`,
  `api_key`, `access_key`, `write_key`, `auth`, `bearer`, `credential`, `cvv`, `ssn`,
  `credit_card`, `card_number`. For `api_key`, `access_key`, `write_key`, `credit_card` and
  `card_number` the separator is optional and may be `_` or `-`, so `apikey`, `api_key` and
  `api-key` are the same. Kept specific so that a bare `card` or `session` doesn't swallow
  `cardinality` or `session_id`.
- **Headers**, redacted at every level including `allow`: `authorization`, `cookie`, `set-cookie`,
  and any name containing `token`, `key`, `secret`, `passwd`, `password`, `auth`, `bearer` or
  `credential`. Broader than body keys, so a bare `key` still catches `x-api-key`.
- **Query and form parameter names**, matched as a *whole* key and never inside JSON bodies, which
  covers the OAuth callback: `code`, `state`, `session_state`, `id_token`, `access_token`,
  `refresh_token`, `token`. Whole-key only, because inside a body `code` and `state` usually mean an
  HTTP status and UI state.

Values nested deeper than 8 levels are redacted whole, so nothing below the walk's limit leaks.

### Per-widget masking with `GroundcoverPrivate`

To mask one region's interaction labels **under any level**, wrap it in `GroundcoverPrivate`. Every
interaction on a widget inside it (taps, gestures and input) has its label, hint and value replaced
with `***`, and so does a control outside it whose label would be read from text inside it. The
role, component and component path stay. It is the counterpart of RN's `dataPrivate`.

```dart
GroundcoverPrivate(child: ProfileCard()) // every tap inside is masked
```

### The `redact` hook

`redact` is called on **each leaf value** the redaction walk visits in headers, query parameters,
JSON or form bodies, log attributes, error and crash metadata, and navigation metadata (which
arrives with `kind` `log`), never on a map or list: the SDK walks those itself. Return a replacement
string, number or bool, or **null to keep the SDK's default** (`'[REDACTED]'` when the field is
sensitive, the value otherwise), so a hook that cares about one field can't switch masking off
elsewhere. A hook that throws keeps the default too.

Free text (a log message, an error or crash message, a body that isn't JSON or a form) goes to the
hook once, whole, with `key: ''`, an empty `path` and `sensitive: false`. A non-null return replaces
the SDK's own scrub of that text, which redacts the values of `key=value`, `key: value` and
`"key":"value"` pairs under sensitive keys.

```dart
options: GroundcoverOptions(
  privacy: PrivacyOptions(
    redact: (field) {
      // field.key, field.value, field.path, field.kind, field.sensitive
      if (field.key == 'email') return '[email]';
      return null; // the SDK's default
    },
  ),
),
```

`field.kind` is a `RedactKind`: `requestBody`, `responseBody`, `query`, `header`, `log` or `error`.
As with `beforeSend`, a hook isn't a constant: drop `const` from the `GroundcoverConfig` that
carries it.

> **The hook overrides the built-in masking.** Under `maskSensitive` and `maskAll` it runs on every
> leaf, sensitive headers included, and whatever it returns replaces `[REDACTED]`. A catch-all such
> as `redact: (field) => field.value` therefore sends `authorization`, `cookie` and every sensitive
> body field as they are, and turns off the scrub of every log and error message. Return null for
> anything you don't handle. Under `allow` the hook isn't consulted at all, so the built-in header
> list still wins.

Unlike RN's hook, a Dart hook can't replace a value with null, since null is how it defers.

> **Custom events are not redacted.** `sendCustomEvent`'s attributes are values you chose to send;
> scrub them in `enrichEvent` if they can carry personal data.

---

## What is captured

| Signal | How | Wire type |
|---|---|---|
| Sessions | Persisted across launches; rotated after 30 minutes without the user or past `sessionMaxDuration`. Backgrounding flushes | session attributes |
| Network | Every `dart:io` `HttpClient` created after `init`, which covers `package:http`'s default client and dio's default adapter. See [Network capture](#network-capture) | `network` |
| Distributed tracing | A W3C `traceparent` on requests matching `tracing.propagationUrls` | `network` trace and span ids |
| Navigation | `GroundcoverNavigatorObserver` on named routes, or `startNavigation` / `endNavigation` | `navigation` |
| Taps, gestures | `GroundcoverWidget` reads pointers; the target is found in the widget tree, so it works with accessibility off | `interaction` (`tap`, `long_press`, `swipe`, `scroll`, `pinch`) |
| Typing | One event per finished edit of a text field, from focus changes: it lost focus with a different text than it gained it with. Never the text | `interaction` (`input`) |
| Errors | `FlutterError.onError` and `PlatformDispatcher.instance.onError`, chained to the handlers already set; and `captureException`. See [Errors](#errors) | `exception` |
| Logs | `debugPrint` (at level `log`), and `GroundcoverRum.logger` | `log` |
| Custom events | `GroundcoverRum.sendCustomEvent` | `custom` |
| Identity | `identifyUser`, and `GroundcoverConfig.user` | session attributes |
| Native crashes | KSCrash on iOS; a chained uncaught-exception handler and, from API 30, the system's exit records on Android. Sent on the next launch, under the session they happened in | `exception` (`error_metadata.fatal: true`) |
| App hangs | The native watchdog: a main-thread stall past `hangThreshold` that the app recovered from. Dart runs on the main thread, so a long Dart stall is one | `exception` (`ANR` / `AppHang`) |
| App start | Process start to the first frame, measured natively; and time to interactive | `performance` (`app_start_cold`, `_warm`, `_hot`, `_tti`) |
| Frame vitals | Flutter's frame timings: slow and frozen frames and the time they lost, per screen | `performance` (`frames_delay_total`) |

### Interactions

`GroundcoverWidget` classifies each pointer sequence when it ends:

| Interaction | When |
|---|---|
| `tap` | Moved no more than 10 dp on either axis, within 500 ms |
| `long_press` | Moved no more than 10 dp, for longer than 500 ms |
| `swipe` | Moved at least 32 dp, released at 300 dp/s or faster |
| `scroll` | Moved at least 32 dp, released slower than 300 dp/s; or cancelled by the system after moving, marked `partial` |
| `pinch` | Two or more pointers at once |
| `input` | A text field lost focus with a different text than it gained it with |

A pointer that moves more than 10 dp but less than 32 dp, and isn't cancelled, is no interaction.
Input comes from focus changes rather than pointers, so it doesn't need `GroundcoverWidget`.

Each carries `interaction_target` (`component`, `label`, `role`, `hint`, and `state` and `value`
when the widget has them), `interaction_component_path` (the app's own widgets from the outside in,
such as `HomeScreen > CheckoutCard`), and, except for input, `interaction_coordinates`. Gestures
other than a tap add `interaction_gesture`: `direction` (for a swipe or a scroll), `distance_dp`,
`velocity_dp_s`, `duration_ms`, `pointer_count`, `partial` when cancelled, and
`capture_source: 'dart'`.

**How a target is named**, as in the RN SDK: from the widget under the finger up through its
ancestors, the first label found. An explicit label (`Semantics(label:)`, a `Tooltip`, a text
field's `labelText`, else its hint or placeholder) comes before the text a widget shows or holds.
So a control's visible text beats a different accessibility label around it, and
`Text(semanticsLabel:)` names only a glyph (`→`, an icon). A text field is never named by the text
it holds. Text longer than 200 characters, or without a letter or digit, is no label. The `role`
(`button`, `link`, `checkbox`, `switch`, `radio`, `adjustable`, `textbox`) comes from the control,
and `state` (`selected`, `checked`, `expanded`, `disabled`) from the nearest `Semantics`.

### Auto-captured vs manual

| Signal | Auto-captured | Manual API |
|---|---|---|
| Network requests | ✅ (`dart:io`, `package:http`, dio) | — |
| Uncaught errors | ✅ (`FlutterError`, `PlatformDispatcher`) | `captureException(error, stackTrace:, metadata:)` |
| Taps and gestures | ✅ (`GroundcoverWidget`) | — |
| Typing (edit finished) | ✅ (focus changes) | — |
| Native crashes | ✅ | — |
| App hangs | ✅ | — |
| App start | ✅ | — |
| Time to interactive | ✅ (first screen) | `markAppInteractive()` |
| Frame vitals | ✅ | — |
| Screen navigation | ✅ (`GroundcoverNavigatorObserver`) | `startNavigation` / `endNavigation` |
| Logs | ✅ (`debugPrint`) | `logger.{log,info,warn,error,debug,trace}` |
| Custom events | — | `sendCustomEvent(name, attributes)` |
| User identity | — | `identifyUser(user)` |

### Session attributes

Every batch carries the session: `session_id`, `session_start_time`, `service.name` (the `appId`),
`cluster`, `env`, `namespace`, `releaseId`, `user`, and the device: `source: 'mobile-rum'`,
`os.name` (`ios` or `android`) and `os.version` (the iOS version, or the Android API level),
`device.model`, `device.brand`, `device.codename` (Android only), `device.screen` (logical size,
scale and font scale), `app.id`, `app.version`, `app.build`, and
`sdk: {name: 'groundcover_rum', version}`. `service.name` is one key with a dot in it; `os`,
`device`, `app` and `sdk` are nested objects, so `os.name` is the `name` inside `os`.

---

## Network capture

The SDK installs an `HttpOverrides.global` at `init`, so every `dart:io` `HttpClient` created after
that is watched: `package:http`'s default client and dio's default adapter both build on it. Each
request is reported once, with its method, URL, status, the headers the app set, the response
headers, timings (from the request's start to its response headers, so reading the body isn't
counted) and its bodies, all redacted per your [privacy](#privacy--data-masking) settings.

The wrappers only watch: the request and response pass through unchanged, a body is copied while it
streams past, and any internal failure falls back to the plain call.

- **Your own `HttpOverrides`.** Set it before `GroundcoverRum.init`, which wraps it. One set after
  `init` replaces the SDK's. A client created inside `HttpOverrides.runWithHttpOverrides` uses that
  zone's override, and isn't seen.
- **Clients created before `init` is called** (an `http.Client()` built eagerly at startup) are
  never watched, and requests made before `init` completes pass through unwatched.
- **Bodies** are kept when their content type is text (`text/*`, JSON, XML, form-urlencoded,
  JavaScript, GraphQL) and under 5,000 bytes. A larger body is replaced by `[response body too
  large]` (or the request's), never cut; binary, multipart or still-compressed bodies, and bodies
  with no content type, by a label such as `[image data]`, `[form data]` or `[binary data]`.
- **Bodies are read as the app reads them**; the SDK never consumes one. A body the app abandons,
  or doesn't start reading within 15 seconds of the response, is `[response body unavailable]`, and
  the request is reported then. A request still in flight when the app goes to the background is
  reported when it completes and sent with a later batch, or lost if the app is killed meanwhile.
- **Failures.** A request that fails before any response is reported with status `0` and
  `error.type` `ERR_TIMEOUT` (a timeout) or `ERR_NETWORK_FAILURE`. A request the app aborts before
  its response isn't reported, as in the other SDKs; that includes dio's `sendTimeout` and
  `receiveTimeout`, which abort the same way. An abort with a `TimeoutException` is reported as
  `ERR_TIMEOUT`.
- **Redirects** that `dart:io` follows for the app (`followRedirects`, the default, which
  `package:http` and dio use) are one request, and carry the trace headers to every hop. A redirect
  the app follows itself, with `HttpClientResponse.redirect()`, is reported as its 3xx alone: the
  next request goes out unwatched.
- **WebSocket handshakes** aren't reported: their 101 has no body, and the other SDKs never see
  one either. A handshake the server refuses is reported as an ordinary request.
- **Not covered:** `cupertino_http` and `cronet_http`, which don't go through `dart:io`.

---

## Errors

Uncaught errors are reported with `error_handled: false`, then passed to whatever handler was set
before `init`, whose behaviour is unchanged: what it prints through `debugPrint` isn't sent again
as a log, and a null `FlutterError.onError` stays silent. Set your own handlers before
`GroundcoverRum.init`, or chain to the ones you replace. A `FlutterError` marked `silent` is
skipped. An app in `runZonedGuarded` reports its zone's uncaught errors itself, from the zone's
handler (see [Quick start](#quick-start)), and through `captureException` they arrive with
`error_handled: true`.

Handled errors go through `captureException`, with `error_handled: true`:

```dart
try {
  await checkout();
} catch (error, stackTrace) {
  GroundcoverRum.captureException(error, stackTrace: stackTrace, metadata: {'step': 'payment'});
}
```

Without a `stackTrace`, the error's own is used, else the call's.

An `exception` event carries `error_type` (the Dart type name), `error_message`, `error_stacktrace`
(frames, innermost first, without the SDK's own), `error_fingerprint`, `error_handled` and, when
given, `error_metadata`. The message and metadata are redacted under `maskErrors`.

**Obfuscated builds.** With `--split-debug-info` (which `--obfuscate` requires), each frame keeps
its raw addresses under the build id. groundcover doesn't symbolicate them server-side, so keep
each release's `--split-debug-info` output to read them. `--obfuscate` also renames Dart types, so
an obfuscated build's `error_type`, and its interactions' `component` and component path, change
from build to build, and its errors group per build.

---

## Native features

Native crashes, app hangs, app start and time to interactive come from a native engine (Swift on
iOS, Kotlin on Android) compiled into the plugin. It is the engine `@groundcover/react-native`
ships, so these signals mean the same in both SDKs. Frame vitals are Flutter's own and are measured
in Dart: native frame hooks don't see the surface Flutter draws on. There is nothing to set up.

Each is a separate `enabledEvents` name, so you can keep crash reporting while dropping frame
vitals:

```dart
options: GroundcoverOptions(
  // Leave a name out to turn that feature off (for crashes, see Crash delivery).
  // Null or empty (the default): all.
  enabledEvents: [
    RumEventName.interaction, RumEventName.network, RumEventName.logs,
    RumEventName.navigation, RumEventName.exceptions, RumEventName.crashes,
  ],
  native: NativeOptions(
    // Main-thread block before a hang is reported. Prefer perPlatform when
    // tuning: one Duration also replaces Android's 5 s default.
    hangThreshold: HangThreshold.perPlatform(ios: Duration(milliseconds: 1500)),
    vitalsMaxSegment: Duration(seconds: 60),
    tti: TtiMode.auto,
  ),
),
```

### Crash delivery

A crash ends the process, so nothing can be sent as it happens. The engine stores the report with
a snapshot of the session, and the SDK sends it on the **next launch, under the session it happened
in**, with the crash-time timestamp and screen. It is sent at every launch, before any touch and
even when the new launch isn't sampled; a crash in a session that wasn't sampled is dropped.

Delivery is **at least once**: a record is deleted only after groundcover accepts it, so a crash on
a plane is reported when the app next runs with a network. A retry can deliver the same crash
twice; `error_metadata.crash_report_id` is stable across attempts, so a duplicate can be
recognised. Up to 10 reports wait on disk, the oldest dropped first.

**Leaving `crashes` out of `enabledEvents` stops capturing new crashes, not delivering old ones.**
A report captured in an earlier run that had `crashes` on, and not yet delivered, still goes out at
the next launch, as in the React Native SDK. On Android that is a crash the handler wrote down as
it happened; on iOS, KSCrash reports are only collected while `crashes` is on.

The crash path runs `beforeSend` and `enrichEvent` itself. `beforeSend` returning `false`, or
throwing, drops the report for good; an `enrichEvent` that throws costs only its changes, and the
report still goes out.

Crash events carry `error_metadata.native: true`, `fatal: true` and `crash_report_id`, and the
platform's own fields: `crash_source` (`kscrash`, `jvm_handler` or `exit_info`); on iOS `signal`,
`signal_code`, `mach_exception`, `fault_address`, `thread_count`, `crashed_thread`,
`app_image_uuid`, `app_image_load_address` and `foreground`; on Android `thread_name` and `causes`
from the crash handler, or `exit_reason` and `exit_importance` from the exit records.
`error_type` is the platform's own name for the failure, such as `EXC_BAD_ACCESS`,
`java.lang.IllegalStateException`, `ANR` or `NativeCrash`.

On Android, ANRs and native (NDK) crashes that killed the app are recovered from the system's exit
records on API 30+ (`error_metadata.recovered: false`). That is part of crash capture: it needs
`crashes` in `enabledEvents`, not `hangs`. Below API 30 the process is killed without a trace, and
they are invisible.

#### When another crash reporter is present

**A crash reporter with handlers of its own runs alongside this SDK.** A reporter that doesn't use
KSCrash installs its own handlers and passes a crash on to the reporter installed before it: both
SDKs record the crash, and both report it. The SDK's device tests don't cover this pairing; if you
run one, please open an issue at https://github.com/groundcover-com/groundcover-rum/issues with
what you see. On Android the SDK chains to whatever handler it finds and passes every crash on, so
a second reporter needs nothing there either.

**A crash reporter built on KSCrash** (its Swift package or pod depends on KSCrash) is different:
KSCrash is one per process. If that reporter installs first, this one leaves KSCrash's store alone,
since reading it would delete the other reporter's reports before they were sent. Native crash
capture is then unavailable, and the SDK warns once at init; every other signal still runs. If this
SDK installs first, the other reporter can't capture crashes, and it may delete this SDK's unsent
crash reports when it reads the store they share. Keep one of the two for iOS crashes: start the
other reporter before this SDK, or leave its crash reporting out.

### Querying hangs: `error_type` differs per platform

| Platform | `error_type` | `error_message` |
|---|---|---|
| Android | `ANR` | `Main thread blocked for 5503ms` |
| iOS | `AppHang` | `Main thread blocked for 2101ms` |

Each platform's own term, as the React Native SDK reports it. **A query for one finds half your
hangs**; match both:

```
error_type IN ("ANR", "AppHang")
```

A hang is reported once the main thread recovers, with `error_metadata.recovered: true`,
`hang_duration_ms` and `hang_started_at`. Android adds the main thread's stack, taken when the stall
is first seen; it holds JVM frames only, so a stall in Dart shows the engine's entry point rather
than your Dart code. A stall the app never recovers from is an Android exit-record `ANR`
(`recovered: false`, API 30+, with `crashes` enabled); on iOS it isn't reported.

**What the watchdogs can see.** Each checks the main thread on a fixed cadence: every 0.5 s on
Android, and on iOS every fifth of the threshold, between 0.1 s and 1 s (0.4 s at the 2 s
default). A stall is reported reliably once it exceeds the threshold plus one check interval.
Its duration is measured from the main thread's last heartbeat (every 0.5 s on Android, 0.1 s on
iOS), so it errs long by at most one heartbeat, never short. Both pause in the background.

### Frame vitals

Frame vitals are captured **per screen**, not on a timer. The SDK counts every frame Flutter
reports and keeps one open *segment*, which closes and becomes one `performance` event when:

| `performance_segment_reason` | When |
|---|---|
| `navigation` | The user left the screen |
| `background` | The app left the foreground |
| `safety` | The segment ran longer than `vitalsMaxSegment` (60 s) |

A segment closed by a navigation belongs to the screen being **left**: its frames were drawn there.
Frames are placed by when they were drawn, not when Flutter reports them: a frame being built when
the screen changes, as it is with GoRouter and the other declarative routers, is the new screen's.
The close waits up to 5 seconds for a frame still being drawn; one that arrives later still is
dropped rather than counted on the next screen. Frames drawn before the first screen belong to it.

Each segment is one `frames_delay_total` event:

| Attribute | Meaning |
|---|---|
| `performance_metric_value` | `frames_delay_total`, in **milliseconds**: every slow frame's time beyond the frame budget, summed. The time the user spent waiting, not one frame's duration |
| `performance_frames_slow` / `performance_frames_frozen` | The counts |
| `performance_refresh_rate_hz` | The display's refresh rate, as Flutter reports it |
| `performance_frame_budget_ms` | The budget each frame was judged against |
| `performance_segment_reason` | One of the three reasons above |
| `start_timestamp` / `end_timestamp` | The segment's bounds, in epoch nanoseconds |
| `screen` | The screen the frames were drawn on |

A frame is judged on its `FrameTiming.totalSpan`, from vsync to the end of rasterization. It is
**slow** past `1000 / (refreshRate - 1)` ms, one frame interval with a vsync's tolerance, and
**frozen** past 700 ms; frozen frames are slow too. Normalize by time to compare screens:
`frames_delay_total` per second of `end_timestamp - start_timestamp`. There is
deliberately no slow-frame *rate*: Flutter reports only the frames it drew, so an idle screen draws
none, and a ratio would measure how busy the screen was rather than how smooth.

A segment with no frames isn't reported, which keeps "nothing drawn" apart from "nothing slow".
Segments drawn while the session is idle (30 minutes without the user) are dropped, as are ones
that started before the current session.

### App start

| Metric | iOS | Android |
|---|---|---|
| `app_start_cold` | Process start to the first frame the system drew for the app. A prewarmed launch is anchored at the moment the app loaded instead, and marked `cold_prewarmed` | Process start to the first frame, when the first activity is created fresh (not restored from saved state) within 10 s of the process start |
| `app_start_warm` | — | Otherwise the first activity's creation to its first frame; and any activity created later in a live process. No TTI |
| `app_start_hot` | A return to the foreground (`willEnterForeground`) to the next display refresh | An activity started with none started before, to the frame callback after it resumes |

Every start ends at a frame the system drew, which comes before Flutter's own first frame (or, for
a hot start, before Flutter redraws). Starts longer than 60 s are discarded. Each event carries
`performance_metric_name`, `performance_metric_value` (ms) and `performance_metric_navigation_type`
(`cold`, `cold_prewarmed`, `warm` or `hot`), and waits up to 5 seconds for the first screen, so it
carries the screen it landed on.

### Time to interactive

TTI (`app_start_tti`) runs from the cold start's anchor to the moment the app became **usable**,
and is never below the cold start. Only the app knows when that is:

- `TtiMode.auto` (default): the first screen landing, from the navigator observer or a manual
  navigation. Honest as a *floor*: it comes before that screen's own data loads.
- `TtiMode.manual`: you decide. Call `GroundcoverRum.markAppInteractive()` once, when the first
  screen is genuinely ready:

```dart
// NativeOptions(tti: TtiMode.manual), then, once the first screen's data has arrived:
GroundcoverRum.markAppInteractive();
```

The time is taken at the call, even before `init` has completed, so it is never distorted by SDK
startup. Only the first call counts. A warm or hot start has no TTI.

---

## Architecture

Every live event goes through one pipeline, in Dart, from capture to ingest. There are two capture
sources: the Dart instrumentation, and the native engine, whose hangs and app-start signals arrive
over one event channel. Both converge on the same redaction and enrichment.

```
 Dart capture: pointers, navigation, HTTP, errors, logs, frame timings
 Native engine: hangs, app start                 (event channel)
        │
        ▼
 redact ─▶ enrich (ids, timestamps, screen) ─▶ beforeSend ─▶ enrichEvent
        ─▶ session reconcile ─▶ batch ─▶ gzip ─▶ POST {dsn}/json/rum
```

1. **Capture.** An instrumentation builds a typed capture record, stamped at the moment it
   happened.
2. **Redact.** Sensitive payload is masked per the resolved [`privacy`](#privacy--data-masking).
3. **Enrich.** The SDK adds the id, span and trace ids, timestamps and `screen`, and flattens the
   attributes.
4. **`beforeSend`**, then **`enrichEvent`**: your hooks, on the redacted, enriched event.
5. **Reconcile.** The final event drives the session: a rotation takes the new session's start
   from it.
6. **Batch.** Buffered and sent on `transport.batchTimeout`, on backgrounding, and on reaching
   `transport.batchSize`, except that `navigation`, `interaction` and `performance` events never
   trigger the size flush on their own: a buffer of taps and screen changes ships on the timeout.
7. **Send.** Gzipped (`transport.compression`) and posted with the `apikey` header.

**Crashes take a different path.** A crash isn't a live signal: there is no runtime left to send
it. The engine writes the record and a snapshot of the session to disk, and on the next launch the
SDK rebuilds the event and sends it under the stored session, as a batch of its own: it skips the
live buffer, so it isn't held for a touch.
See [Crash delivery](#crash-delivery).

---

## Coverage & limitations

- **No session replay.**
- **iOS and Android only.** Flutter web apps use `@groundcover/browser`. The plugin declares no
  desktop platform.
- **One groundcover SDK per app.** A native app that embeds Flutter (add-to-app) can't also run
  groundcover's native iOS or Android SDK: each would start its own crash reporter and session.
- **Not symbolicated server-side.** Obfuscated Dart frames arrive as addresses and stripped iOS
  frames as the image and the offset into it, with the build id or binary UUID recorded so they
  can be resolved: keep each release's `--split-debug-info` output and dSYMs. Android JVM frames
  keep their class and method names in a debug build only: in a release build R8 shortens the
  app's and plugins' frames (`vd.run`), and groundcover doesn't retrace them, so keep each
  release's `mapping.txt` to read them.
- **`print` isn't captured**: capturing it takes a zone, which Flutter no longer recommends. Use
  `debugPrint` or `GroundcoverRum.logger`. The SDK's own diagnostics go to `print` for the same
  reason: they never feed back into what it reports.
- **`cupertino_http` and `cronet_http`** aren't seen. See [Network capture](#network-capture).
- **Unnamed routes** are skipped: a `MaterialPageRoute` pushed without `RouteSettings`, a route
  `onGenerateRoute` builds without its `settings`, a go_router `pageBuilder` page without a name,
  most dialogs and bottom sheets. See
  [Naming screens](#naming-screens). An app with nested navigators adds an observer to each; tab
  bars that switch without a route change call `startNavigation` / `endNavigation`.
- **Leaving `navigation` out of `enabledEvents`** drops the navigation events only: screens are
  still tracked, and every other event, frame vitals and app start included, carries the screen it
  happened on.
- **Other isolates**: `init` must run on the root isolate. Calls from another isolate warn and do
  nothing.
- **More than one Flutter engine calling `init`** (add-to-app with a `FlutterEngineGroup`, or a
  background entrypoint that starts the SDK): the native engine is one per process, and its
  signals, crash snapshot and crash delivery assume one owner. Start the SDK from one engine only.
- **An engine that lives without its screen** (add-to-app with a prewarmed or cached
  `FlutterEngine`, or an iOS app without scenes woken in the background): a return from the
  background can be missed, or reported when the user isn't there. A missed one costs the events
  between opening the app and the first touch when 30 minutes or more have passed.
- **The last moment before backgrounding, in frame vitals**: Flutter reports frame timings in
  batches of up to a second, and the segment that closes on backgrounding ships at once rather
  than waiting for them, so frames drawn in that last second can be missing from it.
- **Android sees ANRs and native crashes that killed the app only on API 30+**, where the system
  keeps exit records. On iOS a hang the app never recovers from isn't reported.
- **Live batches aren't retried.** A batch groundcover doesn't accept is lost; only crash reports
  are kept until delivered.

---

## Session lifecycle

**Persistence.** The session (its id, start, last activity and sampling verdict) is stored
natively, in `UserDefaults` on iOS and `SharedPreferences` on Android, so a session survives app
restarts. If storage doesn't answer within 3 seconds at `init`, the SDK starts with empty storage:
a fresh session, and nothing lost but continuity.

**Rotation is activity-driven, not timer-driven**, so the limits are checked when the user comes
back rather than while nobody is there:

- **30 minutes without the user** (no touch, no return to the foreground) and the next activity
  starts a new session. The same check runs at `init`, so a launch after a long break starts a
  fresh one.
- **Past `sessionMaxDuration`** (4 hours by default), the next event starts a new session. An idle
  or backgrounded app keeps its id past the cap until activity resumes.
- What the old session buffered is sent under its own id first. The new session's start is taken
  from the earliest event that belongs to it, normally the one that started it, so a session never
  starts after an event it carries.

**A session is confirmed by the user.** A new session sends nothing until a touch or a return to
the foreground confirms it; until then up to 500 events are held, and the newest dropped past that.
A session that ends unconfirmed (one nobody touched) is discarded with its buffer.

**Sampling** is drawn at `init` and stored with the session, so a session keeps its verdict across
restarts. A session that starts while the app runs (after 30 idle minutes, or past
`sessionMaxDuration`) is recorded for the rest of that process, and its verdict is drawn at the next
launch; `setSessionId` keeps the current verdict. A session that isn't sampled captures nothing, and
`getSessionId()` returns `''`.

`getSessionId()` returns the current id (`''` before `init` completes). `setSessionId([id])` sends
what the current session buffered (discarded if nobody confirmed it) and starts a new session,
with `id` or a generated one; the new session waits for the user to confirm it like any other.

---

## Performance considerations

- **Batching and compression.** Events are buffered (`transport.batchSize`, `transport.batchTimeout`)
  and gzipped, so the SDK makes few requests with small payloads. Each batch's body, its JSON and
  its gzip, is built on a short-lived isolate, off the UI isolate (with `debug` on, which logs the
  JSON, it is built inline). On backgrounding, the batch is built inline and sent at once.
- **Sampling.** Cap volume with `sessionSampleRate`, which selects whole sessions. A session that
  isn't sampled costs the app almost nothing: the HTTP wrapper steps aside, and no capture listener
  or hang watchdog starts. What stays on: the app lifecycle listener, crash capture and the delivery
  of earlier crashes, and the native app-start anchors, which every launch sets before sampling is
  known. An unsampled session sends no app-start or TTI event.
- **Scope what you capture.** Drop noisy endpoints with `excludedUrls`, and turn off what you
  don't need with `enabledEvents`. Each native signal is separate (`crashes`, `hangs`, `appStart`,
  `vitals`).
- **Network capture never consumes a body.** It copies the bytes streaming past, up to the cap, and
  a body over the cap stops being copied.
- **Interactions** cost, per pointer down, a search of the on-screen element tree by paint bounds
  and a walk up from the widget found; for each ancestor without a label, a search of up to 64
  descendants for text.
- **The watchdogs are cheap but not free.** Hang detection runs on a watchdog thread; the main
  thread only answers it, every 100 ms on iOS and every 500 ms on Android, and both pause in the
  background. Frame vitals ride Flutter's own frame-timing callback and emit one
  event per screen segment; lowering `native.vitalsMaxSegment` raises event volume and splits a
  screen's stats.
- **No background timers** for sessions: rotation runs only on real activity.

---

## Testing your app

Once started, the SDK keeps timers (its batch flush), wraps `debugPrint` and listens to the native
engine, and Flutter's test binding fails a widget test that leaves any of that behind when its body
ends. In a test that runs `GroundcoverRum.init`, end the test body with
`GroundcoverRumTesting.reset()` (`package:groundcover_rum/testing.dart`), which stops the SDK
and undoes everything it installed; a later `init` starts afresh. In a `testWidgets`, run `init`
through `tester.runAsync`, since it waits on real asynchronous work:

```dart
testWidgets('checkout', (tester) async {
  await tester.runAsync(() => GroundcoverRum.init(config));
  await tester.pumpWidget(const GroundcoverWidget(child: MyApp()));
  // ...
  await GroundcoverRumTesting.reset(); // in the body: tearDown runs after the binding's checks
});
```

In a plain `test()`, `tearDown(GroundcoverRumTesting.reset)` is enough. Or guard `init` behind a
flag your tests turn off.

The same library has hooks for end-to-end harnesses, not for production code: they move the
persisted session state, crash the app, or block its main thread. `backdateLastActivity(by)` and
`backdateSessionStart(by)` move the session's last activity or start `by` a `Duration` into the
past, and `forgetSession()` drops the session; each shows on the next launch, as it would in the
field. To see a native crash arrive, call `GroundcoverRumTesting.triggerTestCrash()` and launch the
app again: the crash is reported on that launch. It and `blockMainThread` work on a simulator or a
build that carries a provisioning profile on iOS (development, Ad Hoc and Enterprise builds, release
builds among them), and in a debuggable app on Android. They do nothing in App Store and TestFlight
builds or in an Android build that isn't debuggable. Never ship a call to them. To check crash
capture where they do nothing, crash the app from your own native code.

---

## API reference

All calls are static members of `GroundcoverRum`. Apart from `init`, none throws into the app.

| Call | Description |
|---|---|
| `await init(config)` | Starts the SDK; throws `GroundcoverInitException` if it can't. Calls made before it completes are dropped. |
| `identifyUser(user)` | Stamps the user on every batch from now on, merged into any identity set before. |
| `updateConfig(update)` | Changes config after init. Can't change what is [fixed at init](#updating-config-at-runtime); `clearUser: true` forgets the user. |
| `sendCustomEvent(name, [attributes])` | A custom business event. Not redacted. |
| `captureException(error, {stackTrace, metadata})` | Reports a handled error as an `exception` event. |
| `logger.{log,info,warn,error,debug,trace}(message, [attributes])` | Structured logging. |
| `getSessionId()` | The current session id (`''` before init or when not sampled). |
| `await setSessionId([id])` | Sends the current buffer and starts a new session. |
| `startNavigation(screen, {key, metadata})` / `endNavigation([metadata])` | Manual screen tracking. A blank `screen` is never reported. |
| `stopNavigationTracking()` | `GroundcoverNavigatorObserver` stops reporting; manual navigations still report. |
| `markAppInteractive()` | Marks the app usable, for [TTI](#time-to-interactive) under `TtiMode.manual`. Counts before `init` completes too; only the first call counts. |

The package also exports the widgets `GroundcoverWidget` and `GroundcoverPrivate`, the
`GroundcoverNavigatorObserver`, `GroundcoverInitException`, `RumLogger` (the type of
`GroundcoverRum.logger`), and the types `GroundcoverConfig`,
`GroundcoverConfigUpdate`, `GroundcoverOptions`, `GroundcoverOptionsUpdate`, `RuntimeOptions`,
`PrivacyOptions`, `PrivacyLevel`, `RedactField`, `RedactKind`, `Redactor`, `TracingOptions`,
`TracingOrigin`, `TransportOptions`, `NativeOptions`, `HangThreshold`, `TtiMode`, `RumEventName`,
`RumUser`, `RumEvent`, `BeforeSend` and `EnrichEvent`. `package:groundcover_rum/testing.dart`
exports `GroundcoverRumTesting`.

### `identifyUser`

```dart
GroundcoverRum.identifyUser(const RumUser(
  id: 'u_123',
  email: 'user@example.com',
  organization: 'acme',
));
```

`RumUser` fields, all optional: `id`, `email`, `name`, `role`, `organization`, `properties`.

### `captureException`

```dart
GroundcoverRum.captureException(error, stackTrace: stackTrace, metadata: {'feature': 'checkout'});
```

Emits an `exception` event with `error_handled: true`. Metadata is redacted per your privacy
config.

### `logger`

One method per level; the second argument is a map of attributes:

```dart
GroundcoverRum.logger.warn('Checkout failed', {'orderId': 'ord_42', 'attempt': 2});
GroundcoverRum.logger.error('Payment error', {'provider': 'stripe'});
```

`debugPrint` lines are captured at level `log`; a line containing `groundcoverIgnore` is skipped.

### `sendCustomEvent`

```dart
GroundcoverRum.sendCustomEvent('plan_upgraded', {'plan': 'pro', 'seats': 5});
```

Custom events are sent whatever `enabledEvents` says, and aren't redacted.

### Navigation

Automatic: add the observer to each navigator, or to your router (see [Quick start](#quick-start)).
Each route instance gets its own key (`Detail-3`), so two visits to one screen are told apart.

Manual, when a screen change isn't a route change (a tab bar, a page view):

```dart
GroundcoverRum.startNavigation('Checkout', metadata: {'from': 'cart'});
// …
GroundcoverRum.endNavigation();
```

The screen is current from `startNavigation`, and the `navigation` event is sent at
`endNavigation`, with both calls' metadata. Route arguments are never captured: they often carry
ids and tokens.

### `getSessionId` / `setSessionId`

```dart
final id = GroundcoverRum.getSessionId();     // '' before init
await GroundcoverRum.setSessionId('my-id');   // send the buffer, start this session
await GroundcoverRum.setSessionId();          // the same, with a generated id
```
