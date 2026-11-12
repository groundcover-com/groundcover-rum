package com.groundcover.rum.engine

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import com.groundcover.rum.engine.crash.AndroidExitInfoReader
import com.groundcover.rum.engine.crash.GcRumCrashHandler
import com.groundcover.rum.engine.crash.GcRumExitInfoHarvester
import com.groundcover.rum.engine.crash.GcRumSnapshotStore
import com.groundcover.rum.engine.crash.SharedPrefsExitBookkeeping
import com.groundcover.rum.engine.appstart.GcRumAppStartTracker
import com.groundcover.rum.engine.gestures.GcRumGestureTracker
import com.groundcover.rum.engine.hang.GcRumAnrWatchdog
import com.groundcover.rum.engine.lifecycle.GcRumForegroundMonitor
import com.groundcover.rum.engine.vitals.GcRumFrameAggregator
import com.groundcover.rum.engine.vitals.GcRumFrameTracker
import org.json.JSONArray
import org.json.JSONObject

/**
 * Emission seam. The engine never imports com.facebook.* — it hands signals to
 * whoever started it: the React Native module, the Flutter plugin or the native SDK.
 */
internal fun interface GcRumEngineListener {
    /**
     * @param kind discriminator on the single event channel ("hang",
     *   "frame_segment"…).
     * @param payload JSON-encodable map, decoded by the host SDK.
     */
    fun onSignal(kind: String, payload: Map<String, Any?>)
}

/**
 * Facade over the feature units. Owns their lifecycle and a single background
 * thread; the capture logic lives in the units so each stays independently
 * testable without an emulator.
 *
 * `internal`: each SDK (the native library, the RN module, the Flutter plugin) compiles the engine
 * into its own Gradle module and calls it from there, so it is never part of an SDK's public API.
 */
internal class GcRumEngine(
    private val appContext: Context,
    /**
     * The activity currently on screen, if the host can name one. Trackers that
     * attach per-activity need it: by the time the engine starts, the launch
     * activity's lifecycle callbacks have already fired and will not fire again
     * until the app is backgrounded. Plain Android, so the engine stays
     * framework-free — the RN bridge just happens to know the answer.
     */
    private val currentActivity: () -> Activity? = { null },
) {
    var listener: GcRumEngineListener? = null

    // Started on first use, not at construction: a host that never arms a native
    // feature should not pay for a thread, and the engine is constructed as soon
    // as the bridge module is, which is before JS has said what it wants.
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    // noBackupFilesDir, not filesDir: what this store holds is the session
    // envelope, which carries whatever `identifyUser` was given — a user id,
    // usually an email — and filesDir is swept into Android Auto Backup and
    // device-to-device transfer. A library cannot opt out through the manifest
    // (`fullBackupContent` / `dataExtractionRules` are `<application>`
    // attributes and would collide with the host app's own), so the different
    // directory IS the mechanism. `legacyBaseDir` deletes what older SDK
    // versions left in the backed-up location.
    private val snapshots = GcRumSnapshotStore(
        appContext.noBackupFilesDir,
        legacyBaseDir = appContext.filesDir,
    )
    private val crashHandler = GcRumCrashHandler(snapshots)

    // Assigned in start() on the native-modules thread, but read from the foreground
    // callbacks (onForeground/onBackground) on the MAIN thread — the callbacks are
    // wired at construction, before that write. Without the barrier the main thread
    // may never see the watchdog, so it never pauses on background (false ANRs against
    // an idle app) or never resumes. A plain reference read/write, so @Volatile — the
    // same discipline GcRumAnrWatchdog and GcRumGestureTracker already use.
    @Volatile
    private var anrWatchdog: GcRumAnrWatchdog? = null

    /**
     * Both @Volatile for the same reason the watchdog above is, and the reason is the frame
     * SEGMENT PULL: [flushFrameSegmentJson] reads [frameAggregator] without taking
     * [lifecycleLock], while `start`/`stop` write both fields while holding it. The pull arrives
     * on the native-modules thread and `release()` is reachable from React's `invalidate()` on
     * another, so a plain reference read here has no barrier behind it.
     *
     * The iOS twin makes the same guarantee with `trackersLock`, whose own doc comment names this
     * exact reader ("the frame drain runs on `queue`"); this is the Android half of
     * that guarantee.
     */
    @Volatile
    private var frameTracker: GcRumFrameTracker? = null

    /**
     * Held here as well as by the tracker, because the frame-segment PULL comes
     * from the bridge and has to reach the aggregator without going through the
     * tracker's Android plumbing.
     */
    @Volatile
    private var frameAggregator: GcRumFrameAggregator? = null
    private var gestureTracker: GcRumGestureTracker? = null
    private var foregroundCallbacks: Application.ActivityLifecycleCallbacks? = null

    /**
     * Android reports per-activity transitions, never "the app left". The monitor
     * turns those into app-level edges; both things that react to them are here.
     */
    private val foreground = GcRumForegroundMonitor(
        onForeground = { anrWatchdog?.setPaused(false) },
        onBackground = {
            // A backgrounded app is idle, not hung: pause the watchdog rather than
            // keep probing a main thread nobody is waiting on.
            anrWatchdog?.setPaused(true)
            // And the store's own contract: force the debounced write out before
            // the process is likely to be killed.
            //
            // ASYNC, because this callback arrives on the main thread inside
            // onActivityStopped — the frame where the activity is being torn down.
            // The store fsyncs, so draining it here synchronously would stall the
            // main thread on every trip to the background, unseen by the watchdog
            // the line above just paused.
            snapshots.flushPendingWriteAsync()
        },
    )

    init {
        // Before JS has said anything. The count of started activities cannot be
        // reconstructed later, so it has to be accumulated from as early as this
        // object exists — see [countForeground].
        countForeground()
    }

    private var started = false
    private var status = GcRumEngineStatus()

    /**
     * Serializes the whole start/stop lifecycle, so the `started` check-then-act below is
     * one step. The JVM uncaught-exception handler and the ANR watchdog sit behind that
     * guard, and two threads passing it both would chain the handler twice — which is
     * precisely what `install()` then refuses, reporting crash capture as unavailable for a
     * session that could have had it. `stop()` shares the lock because it clears the same two
     * fields.
     *
     * Reachability is low (`nativeInit` is a `@ReactMethod` and RN serializes those on the
     * native-modules queue) but not nil: `release()` is also reachable from React's
     * `invalidate()`, on a different thread, during the reload that re-runs `init()`.
     */
    private val lifecycleLock = Any()

    /**
     * Idempotent by contract: a second call (React Native fast-refresh
     * re-initializes the SDK in place) must not re-harvest crash reports or
     * duplicate any persisted record.
     */
    fun start(config: GcRumEngineConfig): GcRumEngineStatus = synchronized(lifecycleLock) {
        if (started) {
            // Re-stamped rather than returned verbatim: `gesturesAttached` is the one field whose
            // truth has moved on since the status was built. The attach happened after the first
            // `start` returned and announced itself through a signal the NEW JavaScript context
            // was not there to hear — and this early return is why it will never be announced
            // again. Left stale, the reloaded context suppresses nothing and every swipe is
            // reported twice.
            // Both fields describe THE TRACKER, so both are false when there is not one: a status
            // claiming full surface coverage while nothing is attached is a trap for the next
            // reader, even though the JavaScript side only consults coverage once
            // `gesturesAttached` is true.
            val tracker = gestureTracker
            status.gesturesAttached = tracker?.isAttached() == true
            status.gesturesCoverAllSurfaces =
                tracker != null && GcRumGestureTracker.COVERS_ALL_SURFACES
            // A COPY, because [GcRumEngineStatus] is a data class and this one is the engine's own
            // long-lived record: returning it hands the caller a reference that keeps changing
            // under them on the next re-init, rather than the point-in-time answer they asked for.
            // The Swift twin is a struct, which the language copies anyway.
            return status.copy()
        }
        started = true

        val next = GcRumEngineStatus()

        // ORDER MATTERS. Anything that pairs a captured crash with the previous
        // run's snapshot has to happen before the snapshot below overwrites it —
        // otherwise last run's fatal is attributed to this run's session.
        // (The JVM handler writes self-contained records at crash time, so it has
        // nothing to harvest here; ApplicationExitInfo does, and lands next.)

        if (config.features.crashes) {
            val previousRunSnapshot = snapshots.snapshotJson()
            val previousRunStartedAtMs = snapshots.previousRunWrittenAtMs()

            runCatching {
                // The return value matters: install() refuses to chain onto
                // another GcRumCrashHandler (it would recurse on a crash), which
                // happens when a released engine's handler is still the process
                // default. Reporting `crashes = true` regardless would claim capture
                // that goes to a dead engine's store.
                if (crashHandler.install()) {
                    next.crashes = true
                } else {
                    next.crashesUnavailable =
                        "another groundcover crash handler already owns the uncaught-exception chain"
                }
            }.onFailure { error ->
                next.crashes = false
                next.crashesUnavailable = error.toString()
            }

            // ANRs and native crashes kill the app from outside, so the handler
            // above never runs for them — the system's exit record is the only
            // trace. API 30+; below that these deaths are simply invisible.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                runCatching {
                    GcRumExitInfoHarvester(
                        reader = AndroidExitInfoReader(appContext),
                        store = snapshots,
                        bookkeeping = SharedPrefsExitBookkeeping(appContext),
                        // The history holds every process's exits; this engine's are the ones
                        // its sessions end with. That is the app's default process for the
                        // native SDK, and wherever an RN or Flutter app hosts its UI, which can be
                        // a named one (`android:process=":ui"`). API 28+, inside the R gate.
                        processName = Application.getProcessName(),
                    ).harvest(previousRunSnapshot, previousRunStartedAtMs)
                }
            }
        }

        if (config.features.hangs) {
            runCatching {
                val watchdog = GcRumAnrWatchdog(
                    thresholdMs = config.thresholds.hangThresholdMs,
                ) { startedAtMs, durationMs, stack ->
                    emitHang(startedAtMs, durationMs, stack)
                }
                watchdog.start()
                anrWatchdog = watchdog
                next.hangs = true
            }
        }

        if (config.features.appStart) {
            runCatching {
                // Launch already happened; the provider buffered it and hands
                // over whatever it measured before anyone was listening.
                GcRumAppStartTracker.drain { start ->
                    emit(
                        "app_start",
                        mapOf(
                            "type" to start.type,
                            "startMs" to start.startMs,
                            "firstFrameMs" to start.firstFrameMs,
                        ),
                    )
                }
                next.appStart = true
            }
        }

        // FrameMetrics needs API 24; below that a wrong number would be worse
        // than none, so vitals simply do not arm.
        if (config.features.vitals && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching {
                val application = appContext as? android.app.Application
                if (application != null) {
                    val aggregator = GcRumFrameAggregator(
                        maxSegmentMs = config.thresholds.vitalsMaxSegmentMs,
                        refreshRateHz = displayRefreshRateHz(),
                    )
                    val tracker = GcRumFrameTracker(
                        application,
                        ensureHandler(),
                        aggregator,
                        ::emitFrameSegment,
                    )
                    tracker.start { currentActivity() }
                    frameTracker = tracker
                    frameAggregator = aggregator
                    next.vitals = true
                }
            }
        }

        if (config.features.gestures) {
            runCatching {
                val application = appContext as? android.app.Application
                if (application != null) {
                    val tracker = GcRumGestureTracker(
                        application,
                        onAttached = {
                            emit(
                                "gestures_attached",
                                mapOf(
                                    "coversAllSurfaces" to
                                        GcRumGestureTracker.COVERS_ALL_SURFACES
                                ),
                            )
                        },
                    ) { gesture ->
                        emit(
                            "gesture",
                            mapOf(
                                "kind" to gesture.kind,
                                "startedAtMs" to gesture.startedAtMs,
                                "endedAtMs" to gesture.endedAtMs,
                                "startX" to gesture.startXDp,
                                "startY" to gesture.startYDp,
                                "endX" to gesture.endXDp,
                                "endY" to gesture.endYDp,
                                "direction" to gesture.direction,
                                "distanceDp" to gesture.distanceDp,
                                "velocityDpS" to gesture.velocityDpS,
                                "pointerCount" to gesture.pointerCount,
                            ),
                        )
                    }
                    tracker.start(currentActivity())
                    gestureTracker = tracker
                    // "armed", not "attached" — the attach is posted to the main
                    // looper and has not run yet. JavaScript learns about the
                    // attach from the `gestures_attached` signal above; this flag
                    // only tells it native gesture capture was requested.
                    next.gestures = true
                    next.gesturesCoverAllSurfaces = GcRumGestureTracker.COVERS_ALL_SURFACES
                }
            }
        }

        // Only now: the snapshot handed in at init belongs to the run STARTING.
        //
        // The clear is the unsampled path's other half, and it happens HERE rather than in a second
        // bridge call so that no window exists in which the previous run's envelope is still on
        // disk while this run is already capturing. Between the harvest above and this line the
        // envelope is exactly what the harvest needed it to be; after it, a crash in this run has
        // nothing to be misattributed to.
        //
        // An envelope to install WINS over the clear, matching iOS: it is a positive instruction,
        // and sending both is a caller bug rather than a state worth inventing semantics for.
        val snapshotJson = config.snapshotJson
        if (snapshotJson != null) snapshots.update(snapshotJson)
        else if (config.clearSnapshotAfterHarvest) snapshots.update(null)

        // Both consumers are conditional, so only observe when one of them exists.
        if (next.hangs || next.crashes) observeForeground()

        status = next
        emit("ping", emptyMap())
        return@synchronized status.copy()
    }

    fun updateSessionSnapshot(snapshotJson: String?) {
        ensureHandler().post {
            runCatching { snapshots.update(snapshotJson) }
        }
    }

    fun pendingCrashReportsJson(): String {
        // Records are already JSON objects; splicing them avoids a decode/encode
        // round-trip whose only job would be to produce the same bytes.
        val records = snapshots.readPendingRecords()
        return records.joinToString(prefix = "[", separator = ",", postfix = "]")
    }

    fun clearPendingCrashReports(ids: List<String>) {
        snapshots.deletePendingRecords(ids)
    }

    /**
     * Begins COUNTING started activities at construction rather than at arming, because
     * the count has to predate arming: lifecycle callbacks report only future
     * transitions, and `currentActivity() != null` at arm time is one bit that reads the
     * same for one started activity or three.
     *
     * A deliberate departure from the "pay for nothing until armed" rule that keeps the
     * HandlerThread lazy — a lifecycle callback costs no thread and no per-event
     * allocation, and the alternative is a count that cannot be made correct.
     */
    private fun countForeground() {
        if (foregroundCallbacks != null) return
        val application = appContext as? Application ?: return

        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) = foreground.activityStarted()

            override fun onActivityStopped(activity: Activity) =
                foreground.activityStopped(activity.isChangingConfigurations)

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        }

        runCatching {
            application.registerActivityLifecycleCallbacks(callbacks)
            foregroundCallbacks = callbacks
            foreground.beginCounting(hasVisibleActivity = currentActivity() != null)
        }
    }

    /**
     * Starts REPORTING app-level foreground edges, to the watchdog's pause and the
     * snapshot's background flush. Counting is already underway — see
     * [countForeground].
     */
    private fun observeForeground() {
        countForeground()
        // The bit is a floor under the count, not a replacement — see the monitor.
        // It matters because construction can land after the launch activity's
        // onStart on some hosts, leaving nothing counted for an app plainly on
        // screen.
        foreground.startObserving(hasVisibleActivity = currentActivity() != null)
    }

    /**
     * Waits for everything already queued on the engine's thread to run.
     *
     * A barrier, not a flush: posting to the tail of the queue and waiting for THAT means
     * every message ahead of it has run. Bounded, because teardown arrives on the
     * native-modules thread during a React reload and a wedged queue must not stall it —
     * a timeout leaves the store's own post-close guard as the backstop.
     *
     * No-op when no thread was ever started, which is the Expo Go path and any host that
     * armed nothing.
     */
    private fun drainQueuedWork() {
        val live = handler ?: return
        runCatching {
            val done = java.util.concurrent.CountDownLatch(1)
            if (!live.post { done.countDown() }) return
            done.await(DRAIN_WAIT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        }
    }

    @Synchronized
    private fun ensureHandler(): Handler {
        handler?.let { return it }
        val started = HandlerThread("gc-rum-engine").apply { start() }
        thread = started
        return Handler(started.looper).also { handler = it }
    }

    /**
     * [stop], plus the resources construction and arming acquired.
     *
     * Called when the React instance is destroyed — a full JS reload, or a host
     * that resets its ReactHost. Without it every recreation strands the
     * HandlerThread and, through the Application's lifecycle callbacks, the whole
     * engine → listener → module → dead-ReactApplicationContext chain.
     *
     * The store refuses to write after [GcRumSnapshotStore.close]; the [drainQueuedWork]
     * barrier below is what keeps legitimate queued updates landing rather than being
     * dropped by that refusal.
     */
    fun release() {
        stop()
        // Counting outlives stop() but not this: the engine itself is going away,
        // and a callback left on the Application would keep it — and the whole
        // engine → listener → module → dead-ReactApplicationContext chain — alive.
        foregroundCallbacks?.let { callbacks ->
            runCatching { (appContext as? Application)?.unregisterActivityLifecycleCallbacks(callbacks) }
        }
        foregroundCallbacks = null
        // Hand the host's own handler back, so the NEXT instance's install()
        // is not refused by its own guard against chaining onto a GcRum handler.
        crashHandler.uninstall()
        // BEFORE closing the store: `updateSessionSnapshot` posts here, and `quitSafely()`
        // below still runs messages that were ALREADY queued. A queued `snapshots.update(X)`
        // would therefore execute after the final flush — and once the debounce window has
        // elapsed `update` writes on the calling thread, bypassing the store's scheduler
        // entirely — so a crash in the teardown window would be attributed to the session
        // JavaScript had already finished with. Draining here lands those updates in the
        // RIGHT order; the store also refuses writes once closed, as the backstop.
        drainQueuedWork()
        // Whatever the drained work parked still has to reach disk.
        snapshots.flushPendingWrite()
        // The store owns a scheduler thread of its own; stop() only drains its
        // pending write. Left open, every React-instance recreation strands one.
        snapshots.close()
        thread?.quitSafely()
        thread = null
        handler = null
    }

    /**
     * Stops watchdogs and frame listeners. The crash handler deliberately stays
     * armed — a crash during teardown is still worth reporting.
     */
    fun stop() = synchronized(lifecycleLock) {
        // Synchronous here, unlike the background transition: this arrives on the
        // native-modules thread (a @ReactMethod, or module invalidation), never on
        // main, and teardown wants the bytes on disk before it returns.
        snapshots.flushPendingWrite()
        // Reporting stops; COUNTING does not. The lifecycle callbacks stay
        // registered until release(), because the activities they are counting are
        // still on screen and JS can arm this same engine again — a count rebuilt
        // from scratch at that point would miss the activities already on screen.
        foreground.stopObserving()
        anrWatchdog?.stop()
        anrWatchdog = null
        frameTracker?.stop()
        frameTracker = null
        frameAggregator = null
        gestureTracker?.stop()
        gestureTracker = null
        GcRumAppStartTracker.reset()
        started = false
        status = GcRumEngineStatus()
    }

    /** The display's real refresh rate — the bar for a "slow" frame depends on
     *  it, and a hardcoded 60Hz would call a stuttering 120Hz app healthy. */
    private fun displayRefreshRateHz(): Double {
        val fallback = 60.0
        return runCatching {
            @Suppress("DEPRECATION")
            val display = (appContext.getSystemService(Context.WINDOW_SERVICE)
                as? android.view.WindowManager)?.defaultDisplay
            display?.refreshRate?.toDouble()?.takeIf { it > 0 } ?: fallback
        }.getOrDefault(fallback)
    }

    /**
     * Hands a signal to whoever started the engine.
     *
     * CONTAINED, because [GcRumEngineListener] is a public seam with more than one
     * implementation. The React Native bridge's own `emitSignal` happens to wrap itself in
     * `runCatching`, but relying on that
     * makes this thread's survival a property of the CALLER: `emitHang` is invoked from the ANR
     * watchdog's monitor thread, directly inside its `loop()`, so a listener that throws would
     * terminate the watchdog and end hang detection for the rest of the process — silently, since
     * nothing observes a dead daemon thread. One `runCatching` here covers every emitter, present
     * and future, rather than each arm site remembering to.
     */
    internal fun emit(kind: String, payload: Map<String, Any?>) {
        runCatching { listener?.onSignal(kind, payload) }
    }

    /**
     * The stack arrives as a JSONArray from the watchdog; the bridge marshals plain collections, so
     * unwrap it here rather than teaching the bridge about org.json.
     *
     * The whole body is contained, not just the `emit` it ends with. This runs on the ANR
     * watchdog's monitor thread, inside its `loop()`, and the `runCatching` in [emit] only starts
     * where the marshalling ends — so an exception from the conversion above it (an unexpected
     * org.json state, an allocation failure on a huge stack) would still escape into the loop and
     * terminate the one thread that can detect the next stall.
     */
    private fun emitHang(startedAtMs: Long, durationMs: Long, stack: JSONArray) {
        runCatching {
            val frames = (0 until stack.length()).mapNotNull { index ->
                stack.optJSONObject(index)?.let { frame ->
                    mapOf(
                        "filename" to frame.optString("filename", ""),
                        "function" to frame.optString("function", ""),
                        "lineno" to frame.optInt("lineno", 0),
                        "colno" to 0,
                    )
                }
            }

            emit(
                "hang",
                mapOf(
                    "kind" to "anr",
                    "startedAtMs" to startedAtMs,
                    "durationMs" to durationMs,
                    "mainThreadStack" to frames,
                ),
            )
        }
    }

    /** The one place a frame segment is turned into wire keys, so the push path
     *  (here) and the JavaScript pull path cannot drift apart. */
    private fun emitFrameSegment(segment: GcRumFrameAggregator.Segment) {
        emit("frame_segment", frameSegmentPayload(segment))
    }

    /**
     * Closes the open frame segment and hands it back as JSON, or `"null"`. Answers
     * through a callback because the flush is routed onto the engine's own thread, which
     * is where frame callbacks already arrive — so recording and flushing share one
     * thread.
     *
     * `onResult` runs exactly once on every path: the caller is a JS promise, and one
     * that never settles leaks for the life of the app.
     */
    internal fun flushFrameSegmentJson(onResult: (String) -> Unit) {
        val aggregator = frameAggregator
        if (aggregator == null) {
            onResult("null")
            return
        }

        val posted = ensureHandler().post {
            val json = runCatching {
                aggregator
                    .flush(System.currentTimeMillis(), GcRumFrameAggregator.SegmentReason.NAVIGATION)
                    ?.let { JSONObject(frameSegmentPayload(it)).toString() }
            }.getOrNull()
            onResult(json ?: "null")
        }
        // A dead looper accepts nothing, and the block above would then never run.
        if (!posted) onResult("null")
    }

    internal fun post(block: () -> Unit) {
        ensureHandler().post {
            runCatching(block)
        }
    }

    internal fun context(): Context = appContext

    internal companion object {
        internal fun frameSegmentPayload(
            segment: GcRumFrameAggregator.Segment,
        ): Map<String, Any?> = mapOf(
            "segmentStartMs" to segment.startMs,
            "segmentEndMs" to segment.endMs,
            "total" to segment.total,
            "slow" to segment.slow,
            "frozen" to segment.frozen,
            "refreshRate" to segment.refreshRate,
            "delayMs" to segment.delayMs,
            "budgetMs" to segment.budgetMs,
            "reason" to segment.reason.wireValue,
        )

        /** How long [release] waits for already-queued work. Matches the store's own
         *  CLOSE_WAIT_MS: one fsync's worth, not a queue's — short enough that a wedged
         *  looper cannot stall a React reload. */
        const val DRAIN_WAIT_MS = 1_000L
    }
}
