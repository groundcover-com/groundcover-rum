<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@groundcover/browser/assets/logo.png" alt="groundcover" width="240" />
</p>

<h1 align="center">RUM — Android SDK</h1>

groundcover's Real User Monitoring (RUM) SDK for native Android apps, in Kotlin or Java. It sends
the same `/json/rum` format as [`@groundcover/browser`](https://www.npmjs.com/package/@groundcover/browser),
[`@groundcover/react-native`](https://www.npmjs.com/package/@groundcover/react-native) and
[`groundcover_rum`](https://pub.dev/packages/groundcover_rum) (Flutter), so Android sessions land in
the same RUM views as your web, React Native and Flutter sessions.

The SDK captures sessions, screens (Activities, Fragments and Navigation Compose), taps, gestures
and text input (never the text), OkHttp requests with distributed tracing, logs, errors, custom
events and user identity, plus **crashes, ANRs, app hangs, app start, time to interactive and frame
vitals**. Privacy masking is **on by default**.

> **Release candidate.** Session replay is not included.

See the [groundcover RUM documentation](https://docs.groundcover.com/investigate/real-user-monitoring-rum)
for the product guide; this README is the Android SDK's documentation.

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Before you start](#before-you-start)
- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Privacy & data masking](#privacy--data-masking)
- [What is captured](#what-is-captured)
- [Network capture](#network-capture)
- [Logs](#logs)
- [Errors](#errors)
- [Native features](#native-features)
- [Session lifecycle](#session-lifecycle)
- [Coverage & limitations](#coverage--limitations)
- [Java](#java)
- [R8 / ProGuard and permissions](#r8--proguard-and-permissions)
- [Testing your app](#testing-your-app)
- [API reference](#api-reference)

---

## Requirements

| | Requirement |
|---|---|
| Android | API 23 and up (`minSdk 23`). Frame vitals need API 24; ANRs and native crashes are reported from API 30. |
| `compileSdk` | 36 or higher: the libraries are built against API 36, and their AAR metadata requires it. |
| Java | The libraries are compiled to Java 17 bytecode. |
| Kotlin | Compiled with Kotlin 2.0 as the language and API version; depends on `kotlin-stdlib` 2.0.21. Java-only apps can use the SDK too: see [Java](#java). |
| AndroidX | `rum-android` depends on `androidx.annotation` only. It reads Fragments (`androidx.fragment`) and Jetpack Compose when your app has them, and adds neither. |
| `rum-android-okhttp` | OkHttp 4.12.0 or newer. |
| `rum-android-compose` | Compose runtime and UI 1.7.0 and `androidx.navigation` 2.8.0, or newer. |
| `rum-android-timber` | Timber 5.0.1 or newer. |

The optional modules declare these versions as minimums: when your app uses a newer one, Gradle
picks yours.

---

## Install

The artifacts are on Maven Central (`mavenCentral()` in your repositories). In your app module:

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.groundcover:rum-android:0.0.1-rc.3")

    // Optional: one per integration your app uses.
    implementation("com.groundcover:rum-android-okhttp:0.0.1-rc.3")
    implementation("com.groundcover:rum-android-compose:0.0.1-rc.3")
    implementation("com.groundcover:rum-android-timber:0.0.1-rc.3")
}
```

```groovy
// build.gradle
dependencies {
    implementation 'com.groundcover:rum-android:0.0.1-rc.3'

    // Optional: one per integration your app uses.
    implementation 'com.groundcover:rum-android-okhttp:0.0.1-rc.3'
    implementation 'com.groundcover:rum-android-compose:0.0.1-rc.3'
    implementation 'com.groundcover:rum-android-timber:0.0.1-rc.3'
}
```

| Artifact | Add it when | It gives you |
|---|---|---|
| `rum-android` | Always | The SDK: `Groundcover`, its configuration, screens from Activities and Fragments, taps and gestures (in Compose too), crashes, hangs, app start and frame vitals. |
| `rum-android-okhttp` | Your app makes requests with OkHttp, directly or through a library you hand the client to (Retrofit, for example) | `GroundcoverOkHttpInterceptor` and `GroundcoverEventListener`. See [Network capture](#network-capture). |
| `rum-android-compose` | Your app navigates with a Navigation Compose `NavHost`, or you want to mark Compose content private | `GroundcoverNavigationEffect` and `Modifier.groundcoverPrivate()`. |
| `rum-android-timber` | Your app logs through Timber | `GroundcoverTree`. See [Logs](#logs). |

Each optional module brings `rum-android` and the library it integrates. The SDK declares the
`INTERNET` permission itself (see [R8 / ProGuard and permissions](#r8--proguard-and-permissions)).

---

## Before you start

`Groundcover.start` needs three values from your groundcover account:

- **`apiKey`**: an ingestion key of type **RUM**, from **Settings → Access → Ingestion Keys**.
- **`dsn`**: your groundcover ingestion endpoint, such as `https://example.platform.grcv.io`. A
  value that starts with `http` is used as given, and any other value gets `https://` in front, so a
  bare host works too. Batches are posted to `{dsn}/json/rum`.
- **`cluster`**: the cluster name your RUM data is filtered by.

And two that describe your app: **`environment`** (such as `production` or `staging`, sent as
`env`), and **`appId`**, your app's identity, sent as the service name (`service.name`) and as
`app.id`. It must not be blank.

---

## Quick start

Start the SDK in your `Application` class:

```kotlin
import android.app.Application
import android.util.Log
import com.groundcover.rum.Groundcover
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverInitException
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.TracingOptions

class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            Groundcover.start(
                this,
                GroundcoverConfig(
                    apiKey = "your-rum-ingestion-key",
                    dsn = "https://example.platform.grcv.io",
                    cluster = "your-cluster",
                    environment = "production",
                    appId = "my-android-app",
                    releaseId = "1.4.0",
                    options = GroundcoverOptions(
                        // Send distributed-tracing headers to your own API hosts:
                        tracing = TracingOptions(propagationUrls = listOf("https://api.myapp.com/*")),
                    ),
                ),
            )
        } catch (e: GroundcoverInitException) {
            // The SDK couldn't start, and the app runs unmonitored.
            Log.w("MyApp", "groundcover", e)
        }
    }
}
```

Register the class in `AndroidManifest.xml` if it isn't already: `<application android:name=".MyApp" …>`.
In Java, build the config with its builder (every class is in `com.groundcover.rum`):

```java
// In your Application's onCreate():
GroundcoverConfig config = new GroundcoverConfig.Builder(
        "your-rum-ingestion-key", "https://example.platform.grcv.io",
        "your-cluster", "production", "my-android-app")
    .releaseId("1.4.0")
    .options(new GroundcoverOptions.Builder()
        .tracing(new TracingOptions.Builder()
            .propagationUrls(Collections.singletonList("https://api.myapp.com/*"))
            .build())
        .build())
    .build();
try {
    Groundcover.start(this, config);
} catch (GroundcoverInitException e) {
    Log.w("MyApp", "groundcover", e);
}
```

- **Call `start` once, early in `Application.onCreate`**: a crash before it isn't recorded, and a
  second call does nothing. It runs in the app's main process only (named after the package unless
  the manifest renames it), and returns without starting in any other.
- **It throws `GroundcoverInitException` only for an invalid start**: a blank `appId`, or a null
  context or config from Java. Any later failure leaves the app running unmonitored, with the reason
  in the [debug log](#check-that-data-arrives).
- **It waits up to a second** for the session, so `Groundcover.sessionId` is set when it returns.
  Every other call returns at once and never throws; the work happens on a background thread.
- **Calls made before `start` are dropped**, except `markAppInteractive`.

### Screens

Screens are tracked from three sources. Inside one Activity, the innermost wins:

- **Activities**, named by class (`CheckoutActivity`).
- **Fragments** in a `FragmentActivity` (an `AppCompatActivity` is one): the innermost of your own
  Fragments that is shown, so a tab host gives way to the tab it shows.
- **Navigation Compose**: add `GroundcoverNavigationEffect` (from `rum-android-compose`) beside
  each `NavHost`. Each destination is named by its route pattern (`order/{id}`), so ids in the path
  are never captured.

```kotlin
import com.groundcover.rum.compose.GroundcoverNavigationEffect

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    GroundcoverNavigationEffect(navController)
    NavHost(navController, startDestination = "home") {
        composable("home") { HomeScreen(onOpenOrder = { id -> navController.navigate("order/$id") }) }
        composable("order/{id}") { OrderScreen() }
    }
}
```

Each screen instance gets its own key (`CheckoutActivity-2`, or the back-stack entry's id), so two
instances of one screen are told apart. Returning to an instance that is still alive, such as
going back to an Activity or popping back to an entry, reuses its key. Dialogs and bottom sheets aren't screens: the screen under them stays
current ([what counts](#coverage--limitations)). For a screen none of these see, such as a custom
tab bar:

```kotlin
Groundcover.startNavigation("Settings", metadata = mapOf("from" to "profile"))
// …
Groundcover.endNavigation()
```

The screen is current from `startNavigation`, and the `navigation` event is sent at
`endNavigation`, with both calls' metadata. `Groundcover.stopNavigationTracking()` turns the
automatic sources off for the rest of the process; manual navigations still report.

### Check that data arrives

1. Set `debug = true` in `GroundcoverOptions` for the first run. The SDK then logs what it does to
   logcat, under the tag `groundcover`.
2. Run the app and **touch it once**. Nothing is sent until a touch, or a return to the foreground,
   shows that a user is there.
3. Within about 10 seconds logcat shows `[groundcover] Sending batch:` and the events.
   `Network error while sending batch` means the request failed or the ingest didn't answer with a
   2xx: check `apiKey` and `dsn`. `No API key found` means `apiKey` is empty, and
   `skipping flush: no cluster` that `cluster` is.

Turn `debug` off again for release builds. From there, enrich the data:

```kotlin
Groundcover.identifyUser(RumUser(id = "u_123", email = "user@example.com", organization = "acme"))
Groundcover.logger.warn("Payment retry", mapOf("provider" to "stripe", "attempt" to 2))
Groundcover.sendCustomEvent("plan_upgraded", mapOf("plan" to "pro"))
```

---

## Configuration reference

`Groundcover.start` takes a `GroundcoverConfig`: connection and identity at the top level, and
every behavioural option in `GroundcoverOptions`, grouped by concern. Names follow the React Native
SDK's; durations are milliseconds and end in `Ms`. Every option is optional, and null means the
default. Kotlin code uses named arguments; every class also has a `Builder`, for [Java](#java).

### `GroundcoverConfig`

| Field | Type | Required | Description |
|---|---|---|---|
| `apiKey` | `String` | yes | A RUM ingestion key. With an empty key nothing is sent. |
| `dsn` | `String` | yes | Your ingestion endpoint, with or without a scheme. Batches go to `{dsn}/json/rum`. |
| `cluster` | `String` | yes | Target groundcover cluster. While it is empty, events are held, up to 500, rather than sent. |
| `environment` | `String` | yes | Deployment environment, sent as `env`. |
| `appId` | `String` | yes | The app's identity, sent as `service.name` and `app.id`. Must not be blank. Fixed at start. |
| `namespace` | `String?` | — | Logical grouping for the app. |
| `releaseId` | `String?` | — | Release identifier, such as a version or a commit hash. |
| `user` | `RumUser?` | — | The user at start: `id`, `email`, `name`, `role`, `organization` and `properties`. Sent with every batch as `user`, unmasked. |
| `sessionId` | `String?` | — | Start with this session id instead of a generated or persisted one, to share a session with another surface. A new id starts a new session; the id already stored continues it, unless that session has expired. Fixed at start. |
| `options` | `GroundcoverOptions` | — | Everything below. |

### `GroundcoverOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `enabledEvents` | `List<RumEventName>?` | all | Which signals to capture; null or empty means all. See below. Fixed at start. |
| `sessionSampleRate` | `Double?` | `1.0` | The share of sessions to record, from 0 to 1. See [Session lifecycle](#session-lifecycle). Fixed at start. |
| `sessionMaxDurationMs` | `Long?` | 4 hours | The longest a session runs, from 1 minute to 8 hours. A value outside that range logs a warning and keeps the default (at start) or the current value (in an update). |
| `debug` | `Boolean?` | `false` | Logs what the SDK does, each batch included, to logcat under the tag `groundcover`. Misconfiguration warnings are logged either way. |
| `excludedUrls` | `List<UrlPattern>?` | none | Requests network capture skips. See [Excluded URLs](#excluded-urls). |
| `beforeSend` | `BeforeSend?` | none | Return `false` to drop an event. See below. |
| `enrichEvent` | `EnrichEvent?` | none | Change an event before it is queued, and return it. See below. |
| `privacy` | `PrivacyOptions?` | masking on | See [Privacy & data masking](#privacy--data-masking). |
| `tracing` | `TracingOptions?` | none | See [`TracingOptions`](#tracingoptions). |
| `transport` | `TransportOptions?` | see below | See [`TransportOptions`](#transportoptions). |
| `appVersion` | `String?` | the package's `versionName` | Sent as `app.version`. Fixed at start. |
| `appBuild` | `String?` | the package's version code | Sent as `app.build`. Fixed at start. |
| `native` | `NativeOptions?` | see below | Tuning for the [native features](#native-features). Fixed at start. In Java, `nativeOptions(…)` on the builder. |
| `hooks` | `NativeHooks` | all on | The automatic capture hooks. See [`NativeHooks`](#nativehooks). Fixed at start. |

`enabledEvents` takes `RumEventName` values: `INTERACTION`, `NETWORK`, `LOGS`, `NAVIGATION`,
`EXCEPTIONS` (`captureException`), and the native `CRASHES`, `HANGS`, `VITALS` and `APP_START`.
Custom events are always sent. Leaving out `NAVIGATION` drops the `navigation` events only: screens
are still tracked, and every other event carries the screen it happened on.

#### `beforeSend` / `enrichEvent`

Both run on the SDK's background thread for each `RumEvent`, after privacy masking. Its `type` is
`interaction`, `network`, `log`, `navigation`, `custom`, `exception` or `performance`; `type` and
`id` are read-only, and `enrichEvent` may change the rest: `attributes`, `timestamp` (nanoseconds
since the epoch; a network event has `startTimestamp` and `endTimestamp` instead), `traceId`,
`spanId`, `parentSpanId` and `spanName` (`"METHOD path"` on network events). Attributes are
dot-flattened, as they are sent: a tap's `interaction_target: {label}` arrives as the key
`"interaction_target.label"`, and a request's URL as `"url.full"`. The one nested attribute is
`screen` (`{name, key}`).

```kotlin
GroundcoverOptions(
    // Attributes are flat: read them by their dotted key.
    beforeSend = { event ->
        !(event.type == "network" && event.attributes["url.full"].toString().contains("/health"))
    },
    enrichEvent = { event -> event.apply { attributes["tenant"] = "acme" } },
)
```

`beforeSend` runs first. A hook that throws drops the event, and so does an `enrichEvent` that
returns null from Java; on a [crash report](#crashes-and-anrs), whose hooks run too, a throwing
`enrichEvent` sends the report as built. Anything a hook sends through `Groundcover` is dropped:
sent, it would run the hook again.

#### `NativeHooks`

Each automatic capture hook is on by default. Turn one off when your own instrumentation clashes
with it, and send what it captured through the API instead.

| Hook | Default | What it does |
|---|---|---|
| `activities` | `true` | Screens from each Activity's lifecycle. |
| `fragments` | `true` | Screens from each Fragment's lifecycle, and show/hide tab switches. |
| `windowCallback` | `true` | Taps and gestures, read through a wrapper around each window's callback that passes every event on unchanged. With it off, a touch no longer counts as [user presence](#session-lifecycle). |
| `textFields` | `true` | One `input` event when editing a text field ends. Needs `windowCallback` too. |

#### `TracingOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `propagationUrls` | `List<String>?` | none | Request URLs that get [trace headers](#trace-headers). A pattern must match the whole URL, and `*` is its only wildcard: `https://api.myapp.com/*`. |
| `propagationHeaders` | `List<String>?` | `traceparent` | The headers that carry the W3C trace context. Setting it replaces `traceparent`: list it too to keep it. |
| `traceIdHeaderName` | `String?` | none | A header that also carries the trace id, in decimal. |
| `spanIdHeaderName` | `String?` | none | A header that also carries the span id, in decimal. |
| `origin` | `TracingOrigin?` | none | A header, `TracingOrigin(name, value)`, added to every traced request. |

#### `TransportOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `batchSize` | `Int?` | `10` | Events buffered before a batch is sent. `0` sends each event on its own; a negative value means the default. A navigation, interaction or performance event that fills the batch doesn't send it: the next other event or the timeout does. |
| `batchTimeoutMs` | `Long?` | `10000` | The longest a batch waits before it is sent anyway. `0` or less means the default. |
| `compression` | `Boolean?` | `true` | Gzip each batch. |

#### `NativeOptions`

These only tune the native features; `enabledEvents` is the one way to turn one off.

| Option | Type | Default | Description |
|---|---|---|---|
| `hangThresholdMs` | `Long?` | `5000` | How long the main thread must be blocked before a hang is reported; 5 s is Android's own ANR threshold. A value outside 250 ms to 60 s means the default. |
| `vitalsMaxSegmentMs` | `Long?` | `60000` | The longest a frame-vitals segment runs before it is closed anyway. A value outside 1 s to 5 minutes means the default. |
| `tti` | `TtiMode?` | `AUTO` | Which moment counts as interactive. See [App start and time to interactive](#app-start-and-time-to-interactive). |

### Updating config at runtime

`Groundcover.updateConfig(GroundcoverConfigUpdate(...))` changes `apiKey`, `dsn`, `cluster`,
`environment`, `namespace`, `releaseId`, `user`, and through `GroundcoverOptionsUpdate`,
`sessionMaxDurationMs`, `debug`, `excludedUrls`, `beforeSend`, `enrichEvent`, `privacy`, `tracing`
and `transport`. A null field, or an empty string, keeps the current value, so an update can't
remove a hook; `privacy`, `tracing` and `transport` merge field by field. Everything else is fixed
at start and isn't part of the update types.

```kotlin
Groundcover.updateConfig(
    GroundcoverConfigUpdate(
        environment = "staging",
        options = GroundcoverOptionsUpdate(
            privacy = PrivacyOptions(level = PrivacyLevel.MASK_ALL),
        ),
    ),
)

// At logout, so the next user's events don't carry this identity:
Groundcover.updateConfig(GroundcoverConfigUpdate(user = UserUpdate.Clear))
```

`UserUpdate.Set(user)` merges into the identity as `identifyUser` does: the fields it gives replace
the current ones, and the rest stay.

---

## Privacy & data masking

Masking is on by default, at `PrivacyLevel.MASK_SENSITIVE`.

| Level | What is masked |
|---|---|
| `MASK_SENSITIVE` (default) | Sensitive values in request and response bodies, query parameters, headers, log messages and attributes, error messages and metadata, and navigation metadata; and the tap labels of [views you mark private](#marking-views-private). |
| `MASK_ALL` | All of the above, plus the label, hint and value text of every tap and input, as `***`. |
| `ALLOW` | Nothing, except credential headers, which are redacted under every level. Private views and `maskInteractionLabels` still mask tap labels. |

| `PrivacyOptions` | Type | Default | Description |
|---|---|---|---|
| `level` | `PrivacyLevel?` | `MASK_SENSITIVE` | The master switch above. |
| `maskNetworkBodies` | `Boolean?` | on | Mask request and response bodies. |
| `maskNetworkQueryParams` | `Boolean?` | on | Mask URL query parameters, and strip `user:password@` from URLs. |
| `maskLogs` | `Boolean?` | on | Mask log messages and attributes. |
| `maskErrors` | `Boolean?` | on | Mask error messages, metadata and the messages in the cause chain. Stack frames are sent as they are. |
| `sensitiveKeys` | `List<String>?` | none | Extra key substrings to treat as sensitive, case-insensitive, added to the built-in ones. |
| `redact` | `Redactor?` | none | A per-value hook; see [below](#the-redact-hook). |
| `maskInteractionLabels` | `Boolean?` | off | Mask tap and input labels under any level. Always on under `MASK_ALL`. |

The four `mask…` surface toggles are off under `ALLOW`, whatever they say.

**What counts as sensitive.** A key containing `token`, `secret`, `passwd`, `password`, `api_key`,
`access_key`, `write_key`, `auth`, `bearer`, `credential`, `cvv`, `ssn`, `credit_card` or
`card_number`, in any case, plus your `sensitiveKeys`. In the five compound words the `_` may also
be `-` or nothing.
In query strings and form bodies, `code`, `state`, `session_state`, `id_token`, `access_token`,
`refresh_token` and `token` count too. Headers named `authorization`, `cookie` or `set-cookie`, or
whose name contains `key` or one of the words above, are redacted under every level, unless your
[`redact` hook](#the-redact-hook) returns a value for one.

**How values are masked.** A sensitive value becomes `[REDACTED]`. JSON bodies are walked key by
key: a sensitive key holding an object or array is redacted whole, and so is anything nested more
than 8 levels deep. Form bodies and query strings are masked key by key. Other text (log and error
messages, bodies that aren't JSON) is scanned for `key=value`, `key: value` and `"key": "value"`
pairs with a sensitive key. Custom event attributes and the user identity are sent as given.

### Marking views private

```kotlin
cardNumberView.groundcoverPrivate = true              // a View, and everything inside it

Text(cardholderName, Modifier.groundcoverPrivate())   // Compose, from rum-android-compose
```

In Java: `GroundcoverViews.setGroundcoverPrivate(view, true)`. A tap on a private view, or inside
it, is sent with its label, hint and value as `***`, whatever the level; its role, state and
component path stay. The view itself, and what TalkBack reads, are unchanged.

Typed text is never captured: a text field's contents are never read for a label, and an `input`
event names the field by its content description (an `EditText` falls back to its hint).

### The `redact` hook

```kotlin
PrivacyOptions(
    sensitiveKeys = listOf("iban"),
    redact = Redactor { field ->
        when {
            field.kind == RedactKind.HEADER && field.key.equals("x-tenant-id", ignoreCase = true) -> "[tenant]"
            field.key == "email" -> "[email]"
            else -> null // keep the SDK's default
        }
    },
)
```

`redact` runs on the SDK's background thread for each value masking looks at. Its `RedactField` has
the value's `key` and full key `path`, the `value` (a string, number, Boolean or null, never a map
or list), the `kind` of surface (`REQUEST_BODY`, `RESPONSE_BODY`, `QUERY`, `HEADER`, `LOG` or
`ERROR`; navigation metadata comes as `LOG`), and whether the built-in rules or `sensitiveKeys`
would mask it (`sensitive`). A whole string (a log or error message, or a body that is neither JSON
nor form data) comes once, with an empty `key` and `path`.

Return a replacement string, number or Boolean, or null to keep the default: `[REDACTED]` when
`sensitive`, the value otherwise. For a whole string, a non-null result replaces the built-in scan
of that string. A hook that throws gets the default for that value. It is called only for the
surfaces being masked, so never under `ALLOW`.

> **The hook overrides the built-in masking.** What it returns replaces `[REDACTED]`, sensitive
> headers included: a catch-all such as `Redactor { it.value }` sends `authorization`, `cookie` and
> every sensitive field as they are. Return null for anything you don't handle.

---

## What is captured

| Event type | What | Source |
|---|---|---|
| `interaction` | Taps, long presses, swipes, scrolls and pinches; one `input` per finished text-field edit | A wrapper around each window's callback (`NativeHooks.windowCallback` and `textFields`) |
| `network` | OkHttp requests, with trace ids | `GroundcoverOkHttpInterceptor`. See [Network capture](#network-capture) |
| `log` | Log lines | `Groundcover.logger`, and Timber through `GroundcoverTree`. See [Logs](#logs) |
| `exception` | Handled errors; crashes, ANRs and native crashes, sent on the next launch; hangs the app recovered from | `captureException`; the uncaught-exception handler and the system's exit records; the hang watchdog. See [Errors](#errors) and [Native features](#native-features) |
| `navigation` | Screen changes, with the screen left and how long it was shown | Activities, Fragments, `GroundcoverNavigationEffect`, and `startNavigation` / `endNavigation` |
| `performance` | App start (`app_start_cold`, `app_start_warm`, `app_start_hot`), time to interactive (`app_start_tti`), frame vitals (`frames_delay_total`) | The SDK's native layer. See [Native features](#native-features) |
| `custom` | Your own events | `Groundcover.sendCustomEvent` |

Every event carries the screen it happened on as `screen: {name, key}`, empty before the first
screen.

### Interactions

| Interaction | When |
|---|---|
| `tap` | One finger, moved at most 10 dp from where it went down, lifted within 500 ms |
| `long_press` | The same, held longer than 500 ms |
| `swipe` | One finger lifted at least 32 dp from where it went down, moving at 300 dp/s or faster |
| `scroll` | One finger lifted at least 32 dp from where it went down, moving slower |
| `pinch` | Two or more fingers at once |
| `input` | Editing a text field (an `EditText` or a Compose field) ended with a different text than it began with: focus left the field or its window, Enter, or a tap outside it |

A finger that moves more than 10 dp but lifts less than 32 dp from where it went down is no
interaction. A swipe, scroll or pinch the system cancels is still sent, marked `partial`; a cancelled
tap or long press isn't.

Each carries `interaction_target` (`component`, `label`, `role`, `hint`, and `state` and `value`
when there are any), `interaction_component_path` (the innermost ten views from the outside in, such
as `DecorView > LinearLayout > MaterialButton`), and, except for input, `interaction_coordinates` in
dp. Gestures other than a tap add `interaction_gesture`: `direction` (swipe and scroll),
`distance_dp`, `velocity_dp_s`, `duration_ms`, `pointer_count`, `partial` and
`capture_source: "native"`. The target is named as TalkBack would: the View under the finger (or
its nearest clickable ancestor) by its content description, else its text, else the text inside it,
up to 200 characters; a Compose element by its merged semantics. `role` (`button`, `checkbox`,
`switch`, `radio`, `textfield`, `image`, and more) comes from what the element reports to TalkBack.

### Session attributes

Every batch carries the session: `session_id`, `session_start_time`, `service.name` (the `appId`),
`cluster`, `env`, `namespace`, `releaseId`, `user`, and the device: `source: "mobile-rum"`,
`os.name` (`android`) and `os.version` (the API level), `device.model`, `device.brand`,
`device.codename`, `device.screen` (size in dp, scale and font scale), `app.id`, `app.version`,
`app.build`, and `sdk: {name: "groundcover-rum-android", version}`.

---

## Network capture

Add the interceptor and the event listener to each `OkHttpClient` you build:

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(GroundcoverOkHttpInterceptor())
    .eventListenerFactory(GroundcoverEventListener.Factory())
    .build()
```

- **`GroundcoverOkHttpInterceptor`**, an application interceptor, records each request as a
  `network` event and adds trace headers to the ones `propagationUrls` matches. The request and
  response your code sees are unchanged apart from those headers.
- **`GroundcoverEventListener`** records when the response headers arrived, which the interceptor
  uses as the request's end. OkHttp takes one event listener factory per client: if yours already
  has one, leave this out, and each request ends when the interceptor's `proceed` returns.

Each event has the method, the full URL (`url.full`) and its path (`http.route`), the status, the
request and response headers and bodies (`gc.request.body`, `gc.response.body`), the start and end
times, the trace and span ids, and a span name of `METHOD path`. A request that gets no response has
status `0` and `error.type` `ERR_TIMEOUT` (a socket or call timeout) or `ERR_NETWORK_FAILURE`. A
call your app cancels isn't reported, except a server-sent event stream (`text/event-stream`),
which is reported as it opens, since an app ends one by cancelling it.

### Bodies

The SDK never consumes a body your code reads. A **request body** is copied only when OkHttp can
write it more than once (not a one-shot or duplex body), its length is known and under 5,000 bytes,
and its type is text. A **response body** is never read by the SDK: as your code reads it, the first
5,000 bytes are kept, and the request is reported once your code has read to the end or closed the
body, so a response your code never reads or closes isn't reported. A body known to be empty is
reported at once.

Text is `text/*`, JSON and XML (`+json` and `+xml` included), form-encoded, JavaScript and GraphQL.
Any other body becomes a placeholder such as `[image data]`, `[binary data]` or `[form data]`
(multipart); one of 5,000 bytes or more, `[request body too large]` or `[response body too large]`;
one that couldn't be read, `[request body unavailable]` or `[response body unavailable]`. Bodies,
headers and query parameters are then [masked](#privacy--data-masking).

### Trace headers

A request whose URL matches `tracing.propagationUrls` gets a fresh
`traceparent: 00-<trace id>-<span id>-01` (or your `propagationHeaders`), plus `traceIdHeaderName`,
`spanIdHeaderName` and `origin` when you set them. Its `network` event carries the same ids.

A request that already carries a propagation header, set by your code or by an interceptor added
before groundcover's, gets none of the SDK's headers: its own trace context goes out unchanged, and
its event records those ids. To keep another tracer's context, add its interceptor before
`GroundcoverOkHttpInterceptor`. A request that isn't captured gets no trace headers either: an
excluded URL, any request while `NETWORK` is left out of `enabledEvents`, or one in a session that
isn't sampled.

### Excluded URLs

| Pattern | Matches |
|---|---|
| `UrlPattern.of(Regex(…))`, or `UrlPattern.of(Pattern.compile(…))` | Anywhere in the URL. |
| `UrlPattern.of("…")` with `*` or `?` | A glob, anywhere in the URL: `*` is any run of characters, `?` any one character. |
| Any other `UrlPattern.of("…")` | The whole URL, exactly. |

```kotlin
GroundcoverOptions(
    excludedUrls = listOf(
        UrlPattern.of("*/health*"),
        UrlPattern.of(Regex("^https://analytics\\.")),
    ),
)
```

URLs are matched as OkHttp prints them: lower-case scheme and host, and no default port. In
Kotlin, `UrlPattern.Text(…)` and `UrlPattern.Expression(…)` are the same as `of`. The SDK's own
uploads are never captured.

**Other HTTP clients.** Only OkHttp is captured. `HttpURLConnection`, any client that doesn't send
through an `OkHttpClient` built as above, and `WebView` requests aren't.

---

## Logs

```kotlin
Groundcover.logger.info("Checkout started")
Groundcover.logger.warn("Payment retry", mapOf("provider" to "stripe", "attempt" to 2))
```

`Groundcover.logger` has `log`, `info`, `warn`, `error`, `debug` and `trace`, each sent as a `log`
event at that level, with the attributes beside the message. The keys `message`, `level` and
`screen` are the event's own and are dropped from your attributes. A message is cut at 10,000
characters. Messages and attributes are masked by `maskLogs`. Logcat (`android.util.Log`) isn't
captured.

### Timber

```kotlin
Timber.plant(GroundcoverTree())            // INFO and above
Timber.plant(GroundcoverTree(Log.DEBUG))   // DEBUG and above
```

`GroundcoverTree`, from `rum-android-timber`, sends each message at or above its `minPriority`
(`Log.INFO` by default) as a log event, with the Timber tag as the `tag` attribute and a throwable
as `throwable` (its `toString()`). `VERBOSE` becomes `trace`, `DEBUG` `debug`, `INFO` `info`,
`WARN` `warn`, and `ERROR` and `ASSERT` `error`. A message containing `groundcoverIgnore` isn't
sent. Lines logged before `Groundcover.start` are dropped.

---

## Errors

```kotlin
try {
    submitOrder()
} catch (e: IOException) {
    Groundcover.captureException(e, mapOf("feature" to "checkout"))
}
```

`captureException` sends an `exception` event with `error_handled: true`:

- `error_type`: the exception's fully qualified class name, as a crash reports it, so one exception
  groups as one type whether it was handled or fatal.
- `error_message`, and `error_stacktrace`: up to 200 frames, each with the class as `filename`, the
  method as `function` and the line as `lineno`.
- `error_metadata`: your metadata, plus `causes`, the cause chain (up to 5, nearest first, each with
  `type` and `message`).
- `error_fingerprint`: `type:message`, from the first 400 characters of the masked message.

Messages, metadata and cause messages are masked by `maskErrors`; frames are sent as they are.
Leaving `EXCEPTIONS` out of `enabledEvents` turns `captureException` off.

**Uncaught exceptions are crashes.** The SDK doesn't report them in the running session: its
uncaught-exception handler writes each one to disk, then hands it to the handler installed before it
(another crash reporter's, or Android's own), so the app crashes as it would without the SDK. The
crash is sent on the next launch as an `exception` with `error_handled: false`: the class, the
message (up to 2,000 characters), up to 200 frames, and `error_metadata` with `fatal: true`,
`crash_source: "jvm_handler"`, `thread_name`, `causes` (up to 5) and `crash_report_id`.

---

## Native features

### Crashes and ANRs

| Death | How it is seen | Android version |
|---|---|---|
| JVM crash (an uncaught exception) | The SDK's chained uncaught-exception handler records it as it happens | All |
| ANR (the system killed the app for not responding) | The system's exit record, read on the next launch | API 30+ |
| Native (NDK) crash | The system's exit record, read on the next launch | API 30+ |

Each is sent on the next launch that starts the SDK, as an `exception` event under the session and
screen it happened in, even when that launch's own session isn't sampled. A record stays on the
device, outside Android Auto Backup, until it is delivered: at least once, with an
`error_metadata.crash_report_id` that stays the same across attempts. At most 10 undelivered records
are kept, the oldest dropped first.

ANRs arrive with `error_type: "ANR"` and native crashes with `NativeCrash`, both with
`error_metadata.crash_source: "exit_info"` and `recovered: false`, the system's description as the
message, and, for an ANR, the main thread's stack when the system recorded one. Only the previous
run's death is reported, and only the main process's. The crash handler is installed during
`start` and chains onto the one already in place; it refuses only to chain onto another groundcover
handler, and then logs `native crash capture is unavailable`, whatever `debug` says.

### Hangs

A watchdog thread checks that the main thread keeps responding. A stall of at least
`hangThresholdMs` (5 seconds by default) that the app recovers from is sent as soon as it ends, as
an `exception` with `error_type: "ANR"`, the message `Main thread blocked for <n>ms`, the main
thread's stack captured while it was stuck, and `error_metadata` with `recovered: true`,
`hang_duration_ms` and `hang_started_at`. Its fingerprint groups by duration (`ANR:<1s`, `ANR:5s`,
`ANR:30s+`), so one recurring freeze is one issue. The watchdog pauses while the app is in the
background. A stall the app doesn't survive is the ANR the system records (API 30+): `recovered`
tells the two apart.

### App start and time to interactive

The SDK times launches from a content provider that Android creates before `Application.onCreate`,
so there is nothing to set up. Each start is a `performance` event, with its duration in
milliseconds as `performance_metric_value`:

| Metric | What it measures |
|---|---|
| `app_start_cold` | A new process whose first Activity is created, without saved state, within 10 s of the process starting: from the process start to the first frame after that Activity resumes. |
| `app_start_warm` | A launch that isn't cold (its Activity restored from saved state, or created later), from the Activity's creation; and a return to the foreground after the system destroyed your Activities, from the return. Each to the next frame. |
| `app_start_hot` | A return to the foreground with the Activity still alive, from the return to the next frame. |
| `app_start_tti` | Time to interactive, after a cold start: from the process start to the interactive moment. |

A rotation or other configuration change isn't a start, and a start longer than 60 seconds isn't
reported. On API 23 a cold start is measured from when the content provider runs rather than from
the process start. Launch metrics wait up to 5 seconds for the first screen, so they carry it.

Time to interactive is measured to the first screen landing, from any screen source, under
`TtiMode.AUTO` (the default): a floor rather than a promise, since it comes before that screen's own
data loads. Under `TtiMode.MANUAL` it is measured to your call to `Groundcover.markAppInteractive()`,
once the first screen is usable; only the first call counts, and a call before `start` counts too.

```kotlin
GroundcoverOptions(native = NativeOptions(tti = TtiMode.MANUAL))

// Once the first screen shows its data:
Groundcover.markAppInteractive()
```

TTI is never shorter than the cold start (an app holding a splash screen can mark itself interactive
before anything is drawn), and is only reported after a cold start.

### Frame vitals

On API 24 and up, the SDK reads each frame's duration from `FrameMetrics` and sends one
`performance` event, `frames_delay_total`, per screen visit. A frame is slow past one refresh
interval plus a vsync's tolerance, `1000 / (rate − 1)` ms (about 16.9 ms at 60 Hz), and frozen past
700 ms. The event carries:

- `performance_metric_value`: the milliseconds lost, each slow frame's time past the frame budget
  (`performance_frame_budget_ms`, `1000 / rate`), summed;
- `performance_frames_slow` and `performance_frames_frozen`, and `performance_refresh_rate_hz`, the
  display's rate when the SDK started;
- `performance_segment_reason`: `navigation` (the screen changed), `background`, or `safety` (the
  segment ran for `vitalsMaxSegmentMs`, 60 s by default; consecutive ones add up to one visit);
- `start_timestamp` and `end_timestamp`, in nanoseconds, and the screen it was drawn on.

A segment in which no frame was drawn isn't sent, and neither is one drawn after 30 minutes without
the user.

---

## Session lifecycle

- **Persisted.** The session id and its start are stored on the device, so a relaunch continues
  the session.
- **Sampling.** `sessionSampleRate` is drawn when `start` runs and stored with the session, so
  relaunching inside one session keeps the verdict. A session that starts while the app runs
  (after 30 idle minutes, or past `sessionMaxDurationMs`) is recorded for the rest of that
  process, and its verdict is drawn at the next launch; an unsampled launch stays unrecorded until
  the app is relaunched. A session that isn't sampled records nothing: `Groundcover.sessionId` is
  `""`, every call does nothing, and OkHttp requests pass through untouched. The crash handler stays
  installed, so crash reports from earlier sessions are still delivered.
- **Presence gate.** A new session sends nothing until a user is seen: a finger down in any window
  the SDK wraps, or a return to the foreground. The launch itself doesn't count, so an app started
  in the background and never touched sends nothing. Until then events are held, up to 500 (later
  ones are dropped), and a session that ends before anyone is seen discards them.
- **Inactivity.** After 30 minutes without the user, the next touch or return to the foreground
  starts a new session, and so does a launch after such a gap.
- **Maximum duration.** A session older than `sessionMaxDurationMs` (4 hours by default) ends at
  its next event other than a performance event, and a launch past it starts a new session. An idle
  session keeps its id until then.
- **Rotation and backgrounding.** When a session ends, what it buffered is sent under its own id
  first. Going to the background sends the buffer.
- **Delivery.** Batches are sent from memory: one that fails to send isn't retried, and events
  still buffered when the process dies are lost. Only crash reports stay on disk until delivered.

### Session id

```kotlin
val id = Groundcover.sessionId            // "" before start, or when the session isn't sampled
Groundcover.setSessionId("checkout-42")   // send the buffer, then start this session
Groundcover.setSessionId { refreshUi() }  // the same with a generated id; this runs on the main thread
```

`setSessionId(id, onComplete)` sends what the current session buffered under it, then starts a
session with `id`, or a generated one. `onComplete` runs on the main thread once that's done, or at
once when the call is dropped (before `start`, or from inside a hook). Like any new session, it sends
nothing until the next touch or return to the foreground. To start the very first session with your
own id, pass `sessionId` to `GroundcoverConfig`.

---

## Coverage & limitations

- **No session replay.**
- **Screens.** Activities, Fragments and Navigation Compose destinations (with
  `GroundcoverNavigationEffect`) are tracked; use `startNavigation` / `endNavigation` for anything
  else, other Compose navigation libraries included. Without the effect, a Compose screen is
  reported as its Activity. Activities and Fragments are named by their class's simple name,
  destinations by their route.
- **Fragments that are never screens:** a `DialogFragment` (a `BottomSheetDialogFragment` included)
  and every Fragment inside one; Fragments from `androidx.*` and `com.google.*` packages, such as
  `NavHostFragment` and `SupportMapFragment`; a Fragment without a view; and a Fragment that holds
  another of your shown Fragments, which is the screen instead. A hidden Fragment (a show/hide tab)
  becomes the screen once it is shown. Only `androidx.fragment` Fragments in a `FragmentActivity`
  are seen, not the platform's `android.app.Fragment`.
- **Dialogs and bottom sheets** aren't screens: the screen under them stays current. Taps in them
  are captured.
- **Taps** are captured in windows that have a `Window`: Activities, Dialogs and bottom sheets.
  Windows other than Activities' are found through a hidden Android API; if a future Android
  version refuses it, only Activity windows are covered, and the debug log says so. Taps in a
  `PopupWindow` aren't captured.
- **HTTP**: OkHttp only. **Logs**: `Groundcover.logger` and Timber only; logcat isn't captured.
- **One groundcover SDK per app.** An app can't run groundcover's React Native or Flutter SDK
  alongside this one: each would start its own crash reporter and session.
- **Main process only.** The SDK runs in the app's default process; an app whose Activities run in
  a named process isn't supported.
- **R8-minified stack traces** arrive as R8 renamed them: `error_type` and the frames name the
  obfuscated classes and methods. The SDK uploads no mapping file, so keep each release's
  `mapping.txt` to read them. Screen names survive minification: Activities keep their names
  because the manifest declares them, and the SDK's consumer rules keep Fragment class names.
- **No offline queue** for live events, and no ANRs or native crashes below API 30 or frame vitals
  below API 24.

---

## Java

Every configuration class has a `Builder`, whose number and flag setters take primitives:

```java
GroundcoverOptions options = new GroundcoverOptions.Builder()
    .sessionSampleRate(0.5)
    .excludedUrls(Arrays.asList(
        UrlPattern.of("*/health*"),
        UrlPattern.of(Pattern.compile("^https://analytics\\."))))
    .beforeSend(event -> !String.valueOf(event.getAttributes().get("url.full")).contains("/health"))
    .privacy(new PrivacyOptions.Builder()
        .sensitiveKeys(Collections.singletonList("iban"))
        .redact(field -> "email".equals(field.getKey()) ? "[email]" : null)
        .build())
    .nativeOptions(new NativeOptions.Builder().hangThresholdMs(3000).tti(TtiMode.MANUAL).build())
    .hooks(new NativeHooks.Builder().textFields(false).build())
    .build();

Groundcover.updateConfig(new GroundcoverConfigUpdate.Builder()
    .user(UserUpdate.set(new RumUser.Builder().id("u_123").organization("acme").build()))
    .build());
```

Names that differ from Kotlin:

| Kotlin | Java |
|---|---|
| `Groundcover.logger` | `Groundcover.getLogger()` |
| `Groundcover.sessionId` | `Groundcover.getSessionId()` |
| `GroundcoverOptions(native = …)` | `new GroundcoverOptions.Builder().nativeOptions(…)`: `native` is a Java keyword |
| `view.groundcoverPrivate = true` | `GroundcoverViews.setGroundcoverPrivate(view, true)` |
| `UserUpdate.Set(user)` / `UserUpdate.Clear` | `UserUpdate.set(user)` / `UserUpdate.clear()` |
| `UrlPattern.Text("…")` / `UrlPattern.Expression(regex)` | `UrlPattern.of("…")` / `UrlPattern.of(pattern)`, with a `java.util.regex.Pattern` |
| Default arguments | Overloads: `captureException(e)` and `(e, metadata)`; `setSessionId()`, `(id)` and `(id, onComplete)`; `startNavigation(screen)`, `(screen, key)` and `(screen, key, metadata)`; `endNavigation()`; `sendCustomEvent(name)`; each logger method with or without attributes; `new GroundcoverTree()` and `new GroundcoverTree(minPriority)` |

`BeforeSend`, `EnrichEvent` and `Redactor` have one method each, so Java lambdas work.
`GroundcoverConfig` has no shorter constructor than its ten arguments: use its builder. No
`Groundcover` call but `start` throws, even when Java passes null.

---

## R8 / ProGuard and permissions

**R8.** The SDK ships consumer rules, applied when your app minifies; you add nothing. They keep
the startup provider its manifest declares, which Android creates by name; keep the names of the
SDK's own crash-recording classes; keep the names of your `Fragment` subclasses (`-keepnames`, so
R8 still removes unused ones), since Fragment screens are named by class; and add
`-dontwarn androidx.compose.ui.**` and `-dontwarn androidx.fragment.app.**`, so an app without
Compose or Fragments still passes R8's missing-class check. Those two apply to your whole app's
minification.

**Manifest.** The SDK's manifest adds `android.permission.INTERNET`, to send batches, and a
`<provider>`, `com.groundcover.rum.engine.appstart.GcRumStartupProvider`, with the authority
`${applicationId}.groundcoverrum.android.startup`, `android:exported="false"` and
`android:initOrder="100"`. The provider times app start and serves no data. The SDK requests no
other permission.

**On the device.** The session is kept in the `groundcover_rum` SharedPreferences file, and which
exit records were already read in `groundcover-rum`. Crash records, and the session snapshot they
are filed under (the session attributes, user identity included), are kept in a `groundcover-rum`
directory under `noBackupFilesDir`, which Android Auto Backup skips.

---

## Testing your app

`GroundcoverRumTesting`, in `rum-android`, has hooks for your app's tests and automated UI runs.
Don't call it from production code.

| Hook | What it does |
|---|---|
| `reset()` | Stops the SDK: capture stops, buffered events are dropped, and the next `Groundcover.start` starts afresh. The persisted session is kept. |
| `forgetSession(context)` | Forgets the persisted session: its id, start, last activity and sampling verdict. The next launch starts a session no one has touched yet. |
| `backdateLastActivity(context, byMs)` | Moves the last user activity `byMs` into the past. Past 30 minutes, the next launch starts a new session. |
| `backdateSessionStart(context, byMs)` | Moves the session start `byMs` into the past. Past `sessionMaxDurationMs`, the next launch starts a new session. |
| `triggerTestCrash(context)` | Posts an uncaught `IllegalStateException("groundcover test crash")` to the main thread, which reaches the crash handler as a real crash would. |
| `blockMainThread(context, ms)` | Posts a block of the main thread for `ms` milliseconds, 30 seconds at most, so the hang watchdog fires. |

`triggerTestCrash` and `blockMainThread` do nothing unless the app is debuggable (its manifest's
`android:debuggable` flag, which debug builds set); the other hooks work in any build. The session
hooks are on disk when they return, and take effect on the next launch. All are static, so
`GroundcoverRumTesting.reset()` reads the same in Kotlin and Java.

---

## API reference

The full public API, with signatures, is in [`rum-android/api/rum-android.api`](rum-android/api/rum-android.api),
[`rum-android-compose/api/rum-android-compose.api`](rum-android-compose/api/rum-android-compose.api),
[`rum-android-okhttp/api/rum-android-okhttp.api`](rum-android-okhttp/api/rum-android-okhttp.api) and
[`rum-android-timber/api/rum-android-timber.api`](rum-android-timber/api/rum-android-timber.api).
Changes are listed in [`CHANGELOG.md`](CHANGELOG.md).

| `Groundcover` (static from Java) | Description |
|---|---|
| `start(context, config)` | Starts the SDK. Throws `GroundcoverInitException` for an invalid start. See [Quick start](#quick-start). |
| `updateConfig(update)` | Changes the configuration after start. See [Updating config at runtime](#updating-config-at-runtime). |
| `identifyUser(user)` | Merges `user` into the identity sent with every batch from now on. |
| `captureException(throwable, metadata?)` | Reports a handled exception. See [Errors](#errors). |
| `logger` | `log`, `info`, `warn`, `error`, `debug` and `trace`, each taking `(message, attributes?)`. See [Logs](#logs). |
| `sendCustomEvent(name, attributes?)` | Sends a `custom` event. Its attributes are sent as given, never masked: scrub them in `enrichEvent` if they can hold personal data. |
| `startNavigation(screen, key?, metadata?)` / `endNavigation(metadata?)` | A screen you track yourself. See [Screens](#screens). |
| `stopNavigationTracking()` | Stops automatic screen tracking for the rest of the process. |
| `markAppInteractive()` | Marks time to interactive under `TtiMode.MANUAL`. |
| `sessionId` | The current session id; `""` before start, or when the session isn't sampled. |
| `setSessionId(id?, onComplete?)` | Sends the buffer and starts a new session. See [Session id](#session-id). |

Other entry points: `View.groundcoverPrivate` (Java: `GroundcoverViews`) and
[`GroundcoverRumTesting`](#testing-your-app) in `rum-android`; `GroundcoverNavigationEffect` and
`Modifier.groundcoverPrivate()` in `rum-android-compose`; [`GroundcoverOkHttpInterceptor` and
`GroundcoverEventListener.Factory`](#network-capture) in `rum-android-okhttp`; and
[`GroundcoverTree`](#timber) in `rum-android-timber`.
