import Foundation
import Testing
@testable import GroundcoverRumEngine

/// Which anchor a launch is measured from, and whether the answer is
/// believable. Nothing here crashes when it is wrong — it just reports that
/// the app took four hours to start, forever, to a dashboard nobody can
/// reconcile.
@Suite("App start rules")
struct GCRumAppStartRulesTests {
    // A plausible epoch-ms clock; using 0-based times would hide sign errors.
    private let processStart: Double = 1_700_000_000_000
    private var moduleLoad: Double { processStart + 40 }

    // MARK: - Cold

    @Test("a normal launch measures from process start")
    func coldFromProcessStart() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 850
        )

        #expect(start?.type == "cold")
        #expect(start?.startMs == processStart)
        #expect(start?.durationMs == 850)
    }

    /// The system can start a process minutes before the user taps the icon.
    /// Measuring from process start would report that wait as the app being
    /// slow, when the user never saw it.
    @Test("a prewarmed launch measures from module load, not process start")
    func prewarmedFromModuleLoad() {
        let tappedAt = processStart + 300_000 // five minutes later
        let start = GCRumAppStartRules.coldStart(
            prewarmed: true,
            processStartMs: processStart,
            moduleLoadMs: tappedAt,
            firstFrameMs: tappedAt + 700
        )

        #expect(start?.type == "cold_prewarmed")
        #expect(start?.startMs == tappedAt)
        #expect(start?.durationMs == 700)
    }

    /// Underscore, not a dot: the SDK dot-flattens attribute keys, so a dot in
    /// an enum VALUE would be indistinguishable from nesting downstream.
    @Test("the prewarmed type carries no dot")
    func prewarmedTypeHasNoDot() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: true,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: moduleLoad + 100
        )
        #expect(start?.type.contains(".") == false)
    }

    @Test("nothing is reported before the first frame is drawn")
    func noFrameYetReportsNothing() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: 0
        )
        #expect(start == nil)
    }

    /// A missing anchor reads as epoch zero. Reporting from it would say the
    /// app took fifty-odd years to launch.
    @Test("a missing anchor is dropped rather than measured from epoch zero")
    func missingAnchorIsDropped() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: 0,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 500
        )
        #expect(start == nil)
    }

    @Test("a prewarmed launch with no module-load anchor is dropped too")
    func missingPrewarmedAnchorIsDropped() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: true,
            processStartMs: processStart,
            moduleLoadMs: 0,
            firstFrameMs: processStart + 500
        )
        #expect(start == nil)
    }

    // MARK: - Sanity cap

    /// The device slept, the app was suspended mid-start, a debugger attached.
    /// None of these is a launch anyone experienced.
    @Test("a launch beyond the sanity cap is not reported")
    func beyondSanityCapIsDropped() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 60_001
        )
        #expect(start == nil)
    }

    @Test("the sanity cap is inclusive")
    func sanityCapIsInclusive() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 60_000
        )
        #expect(start?.durationMs == 60_000)
    }

    @Test("a first frame before its own anchor is dropped, never reported negative")
    func negativeDurationIsDropped() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart - 1
        )
        #expect(start == nil)
    }

    @Test("an instant launch is reported rather than treated as invalid")
    func zeroDurationIsValid() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart
        )
        #expect(start?.durationMs == 0)
    }

    // MARK: - Background launches

    /// A push or a background refresh launches the app unseen. Process start to its first frame is
    /// no launch anyone waited through, however long or short.
    @Test("a launch that was in the background before its first frame is not a cold start")
    func backgroundedLaunchIsDropped() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 40_000,
            backgroundedBeforeFirstFrame: true
        )
        #expect(start == nil)
    }

    /// Told apart by the app's state, not by how long the frame took: a foreground launch that
    /// stalls before drawing is the slowest launch there is, and the one most worth reporting.
    @Test("a foreground launch slow to draw is still a cold start, up to the sanity cap")
    func slowForegroundLaunchIsCold() {
        let start = GCRumAppStartRules.coldStart(
            prewarmed: false,
            processStartMs: processStart,
            moduleLoadMs: moduleLoad,
            firstFrameMs: processStart + 20_000,
            backgroundedBeforeFirstFrame: false
        )
        #expect(start?.type == "cold")
        #expect(start?.durationMs == 20_000)
    }

    // MARK: - Hot (a foreground return; see hotStart for why not "warm")

    /// The regression that would make these useless: anchoring on the process rather than on the
    /// foreground transition, so an app returned to after two hours reports a two-hour "start".
    @Test("a hot start measures from the foreground transition, hours into a process")
    func hotUsesItsOwnAnchor() {
        let foregroundedAt = processStart + 7_200_000 // two hours in
        let start = GCRumAppStartRules.hotStart(
            foregroundedAtMs: foregroundedAt,
            firstFrameMs: foregroundedAt + 120
        )

        #expect(start?.type == "hot")
        #expect(start?.startMs == foregroundedAt)
        #expect(start?.durationMs == 120)
    }

    @Test("a hot start is held to the same sanity cap")
    func hotObeysSanityCap() {
        let foregroundedAt = processStart + 7_200_000
        let start = GCRumAppStartRules.hotStart(
            foregroundedAtMs: foregroundedAt,
            firstFrameMs: foregroundedAt + 60_001
        )
        #expect(start == nil)
    }

    /// iOS observes `willEnterForegroundNotification`, which fires on EVERY return to the
    /// foreground — including the overwhelmingly common one where the UI was never torn down. That
    /// is a HOT start by the textbook definition, and by Android's.
    ///
    /// Calling it `warm` would make the metric count a different population on each platform:
    /// Android only reports warm when the Activity was actually recreated, so a user who
    /// backgrounds and reopens the app many times a day would produce a warm start per return on
    /// iOS and almost none on Android.
    @Test("a foreground return is a HOT start, not a warm one")
    func foregroundReturnIsHot() throws {
        let start = try #require(
            GCRumAppStartRules.hotStart(foregroundedAtMs: 1_000, firstFrameMs: 1_180)
        )

        #expect(start.type == "hot")
        #expect(start.startMs == 1_000)
        #expect(start.firstFrameMs == 1_180)
    }
}
