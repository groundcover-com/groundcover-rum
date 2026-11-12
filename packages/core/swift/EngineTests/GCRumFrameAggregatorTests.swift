import Foundation
import Testing
@testable import GroundcoverRumEngine

/// What "slow" means, and what a segment is. Wrong answers here are silent: the
/// app still runs, the dashboard is just quietly wrong.
///
/// The aggregator holds ONE open segment and hands it back when something closes
/// it — there is no timer and no windowing, because a fixed window straddling a
/// navigation would attribute its jank to the wrong screen.
@Suite("Frame aggregation")
struct GCRumFrameAggregatorTests {
    private typealias Reason = GCRumFrameAggregator.SegmentReason

    private func makeAggregator(
        maxSegmentMs: Double = 60_000,
        refreshRateHz: Double = 60
    ) -> GCRumFrameAggregator {
        GCRumFrameAggregator(maxSegmentMs: maxSegmentMs, refreshRateHz: refreshRateHz)
    }

    // MARK: - What counts as slow

    @Test("counts a frame slow once it has missed its vsync, not before")
    func slowThresholdAt60Hz() {
        let aggregator = makeAggregator()

        // 60Hz: the bar is 1000/59 = 16.95ms — one frame interval, not two.
        // 16.7ms still made its deadline; 17ms did not.
        aggregator.record(frameDurationMs: 16.7, nowMs: 0)
        aggregator.record(frameDurationMs: 17.0, nowMs: 10)
        aggregator.record(frameDurationMs: 34.0, nowMs: 20)
        let segment = aggregator.flush(endMs: 30, reason: .navigation)

        #expect(segment?.total == 3)
        #expect(segment?.slow == 2)
    }

    /// The whole reason the refresh rate is a parameter: a fixed 16.7ms bar
    /// would call a badly stuttering 120Hz app perfectly healthy.
    @Test("raises the bar on a 120Hz display")
    func slowThresholdAt120Hz() {
        let aggregator = makeAggregator(refreshRateHz: 120)

        // 120Hz: the bar is 1000/119 = 8.4ms. A 10ms frame is comfortable at
        // 60Hz and late here — which is the whole reason the rate is a parameter.
        aggregator.record(frameDurationMs: 10.0, nowMs: 0)
        let segment = aggregator.flush(endMs: 10, reason: .navigation)

        #expect(segment?.slow == 1)
        #expect(segment?.refreshRate == 120)
    }

    @Test("a frozen frame is also counted as slow — it is the worse case of one")
    func frozenIsAlsoSlow() {
        let aggregator = makeAggregator()

        aggregator.record(frameDurationMs: 800, nowMs: 0)
        let segment = aggregator.flush(endMs: 10, reason: .navigation)

        #expect(segment?.slow == 1)
        #expect(segment?.frozen == 1)
    }

    @Test("700ms is the freeze boundary, exclusive")
    func frozenBoundary() {
        let aggregator = makeAggregator()

        aggregator.record(frameDurationMs: 700.0, nowMs: 0)
        aggregator.record(frameDurationMs: 700.1, nowMs: 10)
        let segment = aggregator.flush(endMs: 20, reason: .navigation)

        #expect(segment?.frozen == 1)
    }

    @Test("falls back to 60Hz rather than dividing by a nonsense refresh rate")
    func guardsAgainstZeroRefreshRate() {
        let aggregator = makeAggregator(refreshRateHz: 0)

        // At 60Hz the bar is 16.95ms; without the guard the divisor would be
        // -1 and the comparison would be nonsense.
        aggregator.record(frameDurationMs: 40, nowMs: 0)
        let segment = aggregator.flush(endMs: 10, reason: .navigation)

        #expect(segment?.refreshRate == 60)
        #expect(segment?.slow == 1)
    }

    // MARK: - Adaptive refresh (ProMotion)
    //
    // CADisplayLink ticks on every display refresh, and ProMotion drops to 60Hz on static content,
    // so idle frames arrive ~16.7ms apart. Judged against the panel's PEAK 120Hz budget (8.33ms)
    // every one would be charged slow on a device that is not stuttering, each with ~8.33ms of
    // phantom "lost time" (exactly one 120Hz tick).
    //
    // So the aggregator estimates the rate the display is ACTUALLY running at from the recent
    // observed intervals (median), rather than trusting CADisplayLink's `targetTimestamp`, which
    // reports the peak on an idle panel. It applies ONLY to adaptive panels (>60Hz nominal): a
    // fixed 60Hz display always targets 60Hz, so a sustained low rate is real jank there and keeps
    // the fixed budget — which also keeps 60Hz iOS in lockstep with Android. Android needs none of
    // this: FrameMetrics fires only on a real draw, so it has no idle-frame stream to misclassify.

    /// The wire has to carry the bar `slow` was judged against, or nobody downstream can reproduce
    /// our arithmetic.
    ///
    /// On an adaptive panel the segment is judged against the ESTIMATED cadence, while the only rate
    /// on the wire is `performance_refresh_rate_hz` — the panel's NOMINAL peak. On an idle 120Hz
    /// display those differ by 2x (8.33ms nominal against a ~16.7ms effective budget), so a consumer
    /// recomputing `slow` or `frames_delay_total` from the shipped fields gets a different answer
    /// than we did, with nothing to say why. Shipping the effective budget closes that.
    @Test("carries the budget slow was actually judged against, not just the nominal rate")
    func carriesEffectiveBudget() throws {
        let aggregator = makeAggregator(refreshRateHz: 120)
        for index in 0..<16 {
            aggregator.record(frameDurationMs: 16.7, nowMs: Double(index) * 16.7)
        }
        let segment = try #require(aggregator.flush(endMs: 400, reason: .navigation))

        // The panel's nominal peak is still reported, unchanged — it is a property of the hardware.
        #expect(segment.refreshRate == 120)
        // ...and this is what the frames were actually measured against: the settled 60Hz cadence,
        // not the 8.33ms peak. Without it `refreshRate` alone implies the wrong bar.
        #expect(abs(segment.budgetMs - 16.7) < 0.01)
    }

    /// A fixed-rate panel has no estimation, so the effective budget IS the nominal one — but it
    /// still ships, so a consumer never has to know which case it is looking at.
    @Test("reports the nominal budget on a fixed-rate panel")
    func carriesNominalBudgetWhenNotAdaptive() throws {
        let aggregator = makeAggregator(refreshRateHz: 60)
        aggregator.record(frameDurationMs: 16.0, nowMs: 0)
        let segment = try #require(aggregator.flush(endMs: 100, reason: .navigation))

        #expect(abs(segment.budgetMs - 1000.0 / 60.0) < 0.01)
    }

    @Test("does not call idle 60Hz frames slow just because the panel CAN do 120Hz")
    func adaptiveRefreshDoesNotOverReportSlow() throws {
        // Nominal peak 120Hz, but the panel settled to 60Hz, so each frame's real interval is
        // ~16.7ms — on time for 60Hz.
        let aggregator = makeAggregator(refreshRateHz: 120)
        for index in 0..<16 {
            aggregator.record(frameDurationMs: 16.7, nowMs: Double(index) * 16.7)
        }
        let segment = try #require(aggregator.flush(endMs: 1_000, reason: .navigation))

        #expect(segment.total == 16)
        // Only the single warm-up frame, judged before any cadence history exists, is slow — the
        // other 15 read healthy. Judged against the 8.33ms peak, all 16 would be.
        #expect(segment.slow == 1)
        #expect(segment.delayMs < 10) // one warm-up frame's worth, not ~130ms of phantom loss
        // The peak is still reported: a real fact about the panel, just not the frame budget.
        #expect(segment.refreshRate == 120)
    }

    @Test("still catches a real stall on an adaptive display, measured against the actual cadence")
    func adaptiveRefreshStillCatchesStall() throws {
        // A 60Hz idle cadence, then one 100ms frame — a genuine stall. Its delay is measured against
        // the ~16.7ms cadence the panel was running, not the 8.33ms peak.
        let aggregator = makeAggregator(refreshRateHz: 120)
        for index in 0..<8 { aggregator.record(frameDurationMs: 16.7, nowMs: Double(index) * 16.7) }
        aggregator.record(frameDurationMs: 100, nowMs: 200)
        let segment = try #require(aggregator.flush(endMs: 500, reason: .navigation))

        #expect(segment.slow >= 1)
        // The stall lost ~100 − 16.7 ≈ 83ms (plus the single warm-up frame's ~8ms); crucially NOT
        // 100 − 8.33 ≈ 92ms, which is what judging against the peak would have charged.
        #expect(segment.delayMs > 80 && segment.delayMs < 100)
    }

    // MARK: - Hangs the frame sampler cannot see (iOS)

    /// On iOS the CADisplayLink sampler runs on the main thread, so a main-thread hang is a GAP,
    /// not a long frame, and `frames_frozen` under-reports hangs. The hang watchdog feeds each hang
    /// here so the two detectors agree — matching Android, where an in-frame stall already lands in
    /// `TOTAL_DURATION`.
    @Test("records a hang the sampler missed as a synthetic frozen frame")
    func recordHangSynthesizesFrozenFrame() throws {
        let aggregator = makeAggregator(refreshRateHz: 60)
        // Three healthy frames — nothing the sampler would flag.
        for index in 0..<3 { aggregator.record(frameDurationMs: 16.0, nowMs: Double(index) * 16) }

        aggregator.recordHang(durationMs: 3_000, nowMs: 100)
        let segment = try #require(aggregator.flush(endMs: 200, reason: .navigation))

        #expect(segment.total == 4)
        #expect(segment.frozen == 1) // the sampler alone would see no frozen frame here
        #expect(segment.slow == 1)   // a frozen frame is the worst case of a slow one
        #expect(abs(segment.delayMs - (3_000 - 1000.0 / 60.0)) < 0.01)
        // The hang lands in every counter that means "the user waited": total, slow, frozen and
        // delayMs.
    }

    @Test("ignores a non-positive hang duration rather than opening a bogus frame")
    func recordHangIgnoresNonPositive() {
        let aggregator = makeAggregator()
        #expect(aggregator.recordHang(durationMs: 0, nowMs: 0) == nil)
        #expect(aggregator.flush(endMs: 10, reason: .navigation) == nil) // no frames → no segment
    }

    // MARK: - Suspension gaps

    /// A background/sleep gap resumes CADisplayLink with one enormous delta; charging it as jank
    /// would add the whole suspension to the segment as "lost time". It is not a frame the user
    /// waited on.
    @Test("excludes a process-suspension gap from the jank counters")
    func suspendGapExcluded() throws {
        let aggregator = makeAggregator()
        aggregator.record(frameDurationMs: 16.7, nowMs: 0)      // a real frame
        aggregator.record(frameDurationMs: 17_900, nowMs: 100)  // suspend/sleep gap — dropped
        let segment = try #require(aggregator.flush(endMs: 200, reason: .background))

        #expect(segment.total == 1)   // only the real frame
        #expect(segment.slow == 0)
        #expect(segment.frozen == 0)
        #expect(segment.delayMs == 0) // none of the gap is charged as lost time
    }

    /// The boundary the exclusion must NOT cross: a multi-second freeze the app survived is real
    /// jank, well under the suspend ceiling, and still counts.
    @Test("keeps a multi-second freeze under the suspend ceiling")
    func realFreezeStillCounted() throws {
        let aggregator = makeAggregator()
        aggregator.record(frameDurationMs: 3_000, nowMs: 0)
        let segment = try #require(aggregator.flush(endMs: 100, reason: .navigation))

        #expect(segment.total == 1)
        #expect(segment.frozen == 1)
    }

    // MARK: - Accumulating a segment

    /// No window closes on a timer: a screen's whole dwell is one segment, however
    /// long it lasts and however many frames it contains.
    @Test("accumulates indefinitely without emitting anything")
    func accumulatesSilently() {
        let aggregator = makeAggregator(maxSegmentMs: 60_000)

        // 30 seconds of frames.
        for i in 0..<1_800 {
            let emitted = aggregator.record(frameDurationMs: 16, nowMs: Double(i) * 16.67)
            #expect(emitted == nil)
        }

        let segment = aggregator.flush(endMs: 30_000, reason: .navigation)
        #expect(segment?.total == 1_800)
    }

    @Test("carries the segment's own bounds, not the caller's clock")
    func carriesBounds() {
        let aggregator = makeAggregator()

        // The segment opens on its FIRST frame, so its start is that frame's
        // time and not the aggregator's construction.
        aggregator.record(frameDurationMs: 16, nowMs: 5_000)
        aggregator.record(frameDurationMs: 16, nowMs: 5_500)
        let segment = aggregator.flush(endMs: 9_000, reason: .navigation)

        #expect(segment?.startMs == 5_000)
        #expect(segment?.endMs == 9_000)
    }

    /// A 0 sentinel for "no segment open yet" collides with a legitimate
    /// timestamp: the first frame would re-open the segment on the SECOND call,
    /// and the segment would silently start late. Real clocks never hand out 0,
    /// which is exactly why this would only ever be found by a test.
    @Test("opens the first segment even when the clock reads zero")
    func opensAtZeroClock() {
        let aggregator = makeAggregator(maxSegmentMs: 1_000)

        aggregator.record(frameDurationMs: 40, nowMs: 0)
        let segment = aggregator.record(frameDurationMs: 40, nowMs: 1_000)

        #expect(segment?.startMs == 0)
        #expect(segment?.endMs == 1_000)
    }

    // MARK: - Lost time
    //
    // An absolute duration rather than a rate, and the reason belongs next to the arithmetic: a
    // rate needs a frame-count denominator, and the two platforms do not count the same frames —
    // CADisplayLink ticks on every display refresh whether or not this app drew, while Android's
    // FrameMetrics fires only on a real draw, so the same app can count many times more frames per
    // second on iOS. Nothing below divides by a count.
    //
    // Kept in lockstep with Android's GcRumFrameAggregatorTest: a divergence here makes the same
    // stutter cost a different number of milliseconds per platform, for no reason.

    @Test("sums the time each slow frame lost beyond the frame BUDGET")
    func accumulatesDelay() throws {
        let aggregator = makeAggregator()

        // 60Hz: the budget is 1000/60 = 16.667ms; the slow BAR is 1000/59 = 16.949ms. Two 30ms
        // frames are slow and each lost 30 - 16.667 = 13.333ms; comfortable frames lose nothing.
        aggregator.record(frameDurationMs: 30, nowMs: 0)
        aggregator.record(frameDurationMs: 30, nowMs: 16)
        for index in 0..<8 { aggregator.record(frameDurationMs: 10, nowMs: Double(32 + index * 16)) }
        let segment = try #require(aggregator.flush(endMs: 500, reason: .navigation))

        #expect(segment.total == 10)
        #expect(segment.slow == 2)
        #expect(abs(segment.delayMs - 26.667) < 0.01)
    }

    /// THE distinction between the two thresholds, and the only test that pins it. 16.8ms is past
    /// the 16.667ms budget but short of the 16.949ms bar, so it is deliberately not called slow —
    /// and a delay accumulated over every frame rather than every SLOW frame would report time lost
    /// on an app that is keeping up.
    @Test("charges nothing for a frame past the budget but inside the vsync tolerance")
    func toleranceCostsNothing() throws {
        let aggregator = makeAggregator()

        for index in 0..<5 { aggregator.record(frameDurationMs: 16.8, nowMs: Double(index * 17)) }
        let segment = try #require(aggregator.flush(endMs: 200, reason: .navigation))

        #expect(segment.slow == 0)
        #expect(segment.delayMs == 0)
    }

    @Test("scales the lost time to the display, so a 120Hz frame is late sooner")
    func delayScalesWithRefreshRate() throws {
        let aggregator = makeAggregator(refreshRateHz: 120)

        // 120Hz: the budget is 8.333ms. A 20ms frame lost 11.667ms here, against 3.333ms at 60Hz.
        aggregator.record(frameDurationMs: 20, nowMs: 0)
        let segment = try #require(aggregator.flush(endMs: 100, reason: .navigation))

        #expect(abs(segment.delayMs - 11.667) < 0.01)
    }

    /// A segment with nothing slow in it is still reported, and reporting it is how "this screen
    /// was fine" gets said rather than omitted.
    @Test("reports a segment with no slow frames rather than dropping it")
    func segmentWithoutSlowFramesIsReported() throws {
        let aggregator = makeAggregator()

        aggregator.record(frameDurationMs: 10, nowMs: 0)
        aggregator.record(frameDurationMs: 16, nowMs: 16)
        aggregator.record(frameDurationMs: 12, nowMs: 32)
        let segment = try #require(aggregator.flush(endMs: 100, reason: .navigation))

        #expect(segment.slow == 0)
    }

    /// The per-screen reset. Without it the next screen would inherit this one's lost time.
    @Test("clears the lost time when a segment closes")
    func closeClearsDelay() throws {
        let aggregator = makeAggregator()

        for index in 0..<3 { aggregator.record(frameDurationMs: 500, nowMs: Double(index * 500)) }
        let first = try #require(aggregator.flush(endMs: 1_500, reason: .navigation))
        #expect(first.delayMs > 1_000)

        aggregator.record(frameDurationMs: 10, nowMs: 2_000)
        let second = try #require(aggregator.flush(endMs: 2_100, reason: .navigation))

        #expect(second.delayMs == 0)
    }

    /// Returning from the background. The frames are discarded, so the time they lost has to go with
    /// them or it lands on the next screen.
    @Test("reset drops the accumulated lost time along with the segment")
    func resetClearsDelay() throws {
        let aggregator = makeAggregator()

        for index in 0..<3 { aggregator.record(frameDurationMs: 500, nowMs: Double(index * 500)) }
        aggregator.reset(nowMs: 61_000)

        aggregator.record(frameDurationMs: 10, nowMs: 61_100)
        let segment = try #require(aggregator.flush(endMs: 61_500, reason: .navigation))

        #expect(segment.delayMs == 0)
    }

    // MARK: - The safety cap

    @Test("force-closes a segment that has run past the cap")
    func safetyCloseAtCap() {
        let aggregator = makeAggregator(maxSegmentMs: 1_000)

        #expect(aggregator.record(frameDurationMs: 100, nowMs: 5_000) == nil)
        #expect(aggregator.record(frameDurationMs: 100, nowMs: 5_500) == nil)

        let segment = aggregator.record(frameDurationMs: 100, nowMs: 6_000)

        #expect(segment?.reason == .safety)
        #expect(segment?.startMs == 5_000)
        #expect(segment?.endMs == 6_000)
        // The frame that closed it belongs to the segment it closed, not to the
        // next one — otherwise every cap-closed segment loses a frame and the
        // one after it gains a stranger.
        #expect(segment?.total == 3)
    }

    @Test("reopens at the close, leaving no gap in coverage")
    func reopensContiguously() {
        let aggregator = makeAggregator(maxSegmentMs: 1_000)

        aggregator.record(frameDurationMs: 100, nowMs: 0)
        let first = aggregator.record(frameDurationMs: 100, nowMs: 1_000)
        aggregator.record(frameDurationMs: 100, nowMs: 1_500)
        let second = aggregator.flush(endMs: 1_800, reason: .navigation)

        // Contiguous: a gap here is frames measured and then dropped, which is
        // worse than not measuring them, because the totals look complete.
        #expect(second?.startMs == first?.endMs)
        // And the counters really did start over.
        #expect(second?.total == 1)
    }

    // MARK: - Flush and reset

    @Test("flush hands back a partial segment")
    func flushEmitsPartial() {
        let aggregator = makeAggregator(maxSegmentMs: 60_000)

        aggregator.record(frameDurationMs: 50, nowMs: 0)
        let segment = aggregator.flush(endMs: 200, reason: .background)

        #expect(segment?.endMs == 200)
        #expect(segment?.total == 1)
    }

    /// An empty segment is not news, and shipping one makes "0 frames measured"
    /// indistinguishable from "0% slow" on a dashboard. A navigation between two
    /// screens the app never drew is the common case.
    @Test("flush with no frames hands back nothing")
    func flushWithoutFramesIsNil() {
        let aggregator = makeAggregator()

        #expect(aggregator.flush(endMs: 1_000, reason: .navigation) == nil)
    }

    @Test("flush closes the segment, so a second flush is empty")
    func flushIsNotIdempotent() {
        let aggregator = makeAggregator()

        aggregator.record(frameDurationMs: 50, nowMs: 0)
        #expect(aggregator.flush(endMs: 100, reason: .navigation) != nil)
        // The counters were reset, so the same frames cannot be reported twice.
        #expect(aggregator.flush(endMs: 200, reason: .navigation) == nil)
    }

    /// Every reason has to survive the round trip, because the wire strings are
    /// mirrored by a TypeScript union and nothing off-device compares the two.
    /// `1000 / (rate - 1)` divides by zero at exactly 1Hz. No real display
    /// reports that, which is precisely why it would only ever be found here.
    @Test("survives a refresh rate of 1Hz without dividing by zero")
    func guardsAgainstOneHzRefreshRate() {
        let aggregator = makeAggregator(refreshRateHz: 1)

        aggregator.record(frameDurationMs: 40, nowMs: 0)
        let segment = aggregator.flush(endMs: 10, reason: .navigation)

        #expect(segment?.total == 1)
        // Whatever it decides, it must not be NaN-driven nonsense.
        #expect(segment?.slow == 0 || segment?.slow == 1)
    }

    @Test("carries the reason it was given")
    func carriesReason() {
        for reason in [Reason.navigation, .background, .safety] {
            let aggregator = makeAggregator()
            aggregator.record(frameDurationMs: 50, nowMs: 0)
            #expect(aggregator.flush(endMs: 100, reason: reason)?.reason == reason)
        }
    }

    @Test("the reason's raw value is the wire string")
    func reasonWireValues() {
        #expect(Reason.navigation.rawValue == "navigation")
        #expect(Reason.background.rawValue == "background")
        #expect(Reason.safety.rawValue == "safety")
    }

    /// Returning from the background: the gap is not a frame time, and the
    /// counts from before are not part of what happens next.
    @Test("reset drops the in-flight segment without reporting it")
    func resetDiscards() {
        let aggregator = makeAggregator(maxSegmentMs: 60_000)

        aggregator.record(frameDurationMs: 50, nowMs: 0)
        aggregator.reset(nowMs: 60_000)

        #expect(aggregator.flush(endMs: 60_100, reason: .navigation) == nil)
    }

    /// reset also re-anchors the segment, so the time spent backgrounded is not
    /// counted toward the safety cap — otherwise the first frame back would
    /// immediately close a segment containing one frame.
    @Test("reset re-anchors the segment start")
    func resetReanchors() {
        let aggregator = makeAggregator(maxSegmentMs: 1_000)

        aggregator.record(frameDurationMs: 50, nowMs: 0)
        aggregator.reset(nowMs: 60_000)

        #expect(aggregator.record(frameDurationMs: 50, nowMs: 60_100) == nil)
        #expect(aggregator.flush(endMs: 60_200, reason: .navigation)?.startMs == 60_000)
    }
}
