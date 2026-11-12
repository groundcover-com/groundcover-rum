import Foundation
import Testing
@testable import GroundcoverRumEngine

/// What the watchdog reports once a stall ends.
///
/// The monitor's wait loop breaks for three different reasons — the main thread
/// came back, the app was backgrounded, the SDK was torn down — and only the
/// first of them is a hang the user experienced. The other two leave the
/// heartbeat exactly where the stall started, so anything derived from it is a
/// duration of zero.
@Suite("Hang rules")
struct GCRumHangRulesTests {
    /// Times are `timeIntervalSince1970` seconds, as the watchdog uses.
    private let stallStart: TimeInterval = 1_000

    /// Compared with a tolerance rather than for equality: these are
    /// `timeIntervalSince1970` seconds scaled to milliseconds, so the arithmetic
    /// carries binary-float error (4.2 seconds lands on 4200.0000000000455). The
    /// listener rounds to whole milliseconds before the value reaches the wire,
    /// which is the precision that actually matters.
    @Test("reports the real duration once the main thread comes back")
    func reportsRecoveredStall() throws {
        let duration = try #require(
            GCRumHangRules.recoveredDurationMs(
                startedAt: stallStart,
                lastBeat: stallStart + 4.2,
                stopped: false
            )
        )

        #expect(abs(duration - 4_200) < 0.001)
    }

    /// `didEnterBackground` pauses the watchdog, which breaks the recovery wait —
    /// but a paused watchdog has not observed a recovery, so the heartbeat is
    /// still the pre-stall one. Reporting on that would emit "Main thread blocked
    /// for 0ms" every time a user sent a stalling app to the background.
    ///
    /// A suspended app is not a hung one — Android's watchdog behaves the same
    /// way, reporting only when its token actually ran.
    @Test("reports nothing when the app was backgrounded mid-stall")
    func ignoresPauseMidStall() {
        let duration = GCRumHangRules.recoveredDurationMs(
            startedAt: stallStart,
            lastBeat: stallStart, // never advanced: no recovery was observed
            stopped: false
        )

        #expect(duration == nil)
    }

    @Test("reports nothing when the watchdog was torn down mid-stall")
    func ignoresTeardownMidStall() {
        let duration = GCRumHangRules.recoveredDurationMs(
            startedAt: stallStart,
            lastBeat: stallStart,
            stopped: true
        )

        #expect(duration == nil)
    }

    /// Teardown wins over a recovery that landed in the same moment: the SDK is
    /// going away and its pool may already be gone.
    @Test("teardown suppresses a stall that did recover")
    func teardownBeatsRecovery() {
        let duration = GCRumHangRules.recoveredDurationMs(
            startedAt: stallStart,
            lastBeat: stallStart + 3,
            stopped: true
        )

        #expect(duration == nil)
    }

    /// A beat that reads EARLIER than the stall start cannot be a recovery.
    /// `Date()` is wall-clock, so an NTP correction or a manual clock change
    /// during a stall can move it backwards — and `(lastBeat - startedAt)` would
    /// then be a negative duration, which `max(0, …)` downstream would render as
    /// another phantom zero.
    @Test("reports nothing when the clock moved backwards during the stall")
    func ignoresBackwardsClock() {
        let duration = GCRumHangRules.recoveredDurationMs(
            startedAt: stallStart,
            lastBeat: stallStart - 5,
            stopped: false
        )

        #expect(duration == nil)
    }
}

@Suite("Hang watchdog cadence")
struct GCRumHangCadenceTests {
    /// The monitor wakes its own thread every interval for the app's whole foreground life. A fifth
    /// of the threshold notices a stall within a fifth of it, instead of ten wakeups a second
    /// whatever the threshold.
    @Test("the monitor looks a fifth of the threshold apart, between 0.1 s and 1 s", arguments: [
        (2_000.0, 0.4), (250.0, 0.1), (500.0, 0.1), (1_000.0, 0.2), (60_000.0, 1.0),
    ])
    func monitorLooksAFifthOfTheThresholdApart(thresholdMs: Double, interval: Double) {
        #expect(abs(GCRumHangRules.monitorInterval(thresholdMs: thresholdMs) - interval) < 1e-9)
    }

    /// The beats measure a stall: it appears to start at the last beat before it, so a coarse
    /// heartbeat would report stalls shorter than the threshold, and start them early. It stays at
    /// 0.1 s whatever the threshold.
    @Test("the heartbeat stays 0.1 s apart, whatever the threshold")
    func heartbeatStaysFine() {
        #expect(GCRumHangRules.heartbeatInterval == 0.1)
    }
}
