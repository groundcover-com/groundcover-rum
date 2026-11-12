import Foundation
import Testing
@testable import GroundcoverRumEngine

/// The isolation these tests exist for is invisible in production: a gesture that another window's
/// sequence corrupted is not logged, does not crash, and simply never arrives.
@Suite("Pan sequence isolation")
struct GCRumPanSequencesTests {
    private func store() -> GCRumPanSequences<Int> { GCRumPanSequences<Int>() }

    /// THE case. Two windows, overlapping gestures: window 2 goes two-finger while window 1's
    /// ordinary drag is still in flight. Shared scalars would give window 1's drag
    /// `maxPointers == 2`, and because the classifier declines a multi-pointer sequence the drag
    /// would be DROPPED entirely.
    @Test("one window's two-finger gesture cannot raise another window's pointer count")
    func windowsDoNotShareAPointerCount() {
        let s = store()

        s.begin(1, nowMs: 1_000, x: 0, y: 0, pointers: 1)
        s.begin(2, nowMs: 1_010, x: 500, y: 500, pointers: 1)

        s.observe(2, pointers: 2) // window 2 becomes a pinch…
        s.observe(1, pointers: 1) // …window 1 stays a one-finger drag

        #expect(s.end(1)?.maxPointers == 1)
        #expect(s.end(2)?.maxPointers == 2)
    }

    @Test("start geometry belongs to the sequence, not to whoever began last")
    func startGeometryIsPerSequence() {
        let s = store()
        s.begin(1, nowMs: 1_000, x: 10, y: 20, pointers: 1)
        s.begin(2, nowMs: 1_001, x: 900, y: 800, pointers: 1)

        let first = s.end(1)
        #expect(first?.startX == 10)
        #expect(first?.startY == 20)
        #expect(first?.startedAtMs == 1_000)
    }

    @Test("a touch-down is claimed only by its own key")
    func touchDownIsPerKey() {
        let s = store()
        s.recordTouchDown(1, atMs: 900, x: 5, y: 6)
        // Key 2 has no touch-down, so it must fall back to its own began values rather than
        // borrowing key 1's — which would place the gesture in the wrong window entirely.
        s.begin(2, nowMs: 1_000, x: 700, y: 700, pointers: 1)

        let second = s.end(2)
        #expect(second?.startX == 700)
        #expect(second?.startedAtMs == 1_000)
    }

    @Test("a fresh touch-down supplies the start, because correlation matches on it")
    func freshTouchDownWins() {
        let s = store()
        s.recordTouchDown(1, atMs: 950, x: 5, y: 6)
        s.begin(1, nowMs: 1_000, x: 40, y: 41, pointers: 1) // .began is already slop away

        let seq = s.end(1)
        #expect(seq?.startedAtMs == 950)
        #expect(seq?.startX == 5)
        #expect(seq?.startY == 6)
    }

    @Test("a stale touch-down is ignored — its pan never began")
    func staleTouchDownIsIgnored() {
        let s = GCRumPanSequences<Int>(maxTouchDownAgeMs: 100)
        s.recordTouchDown(1, atMs: 500, x: 5, y: 6)
        s.begin(1, nowMs: 1_000, x: 40, y: 41, pointers: 1) // 500ms later, well past the cap

        let seq = s.end(1)
        #expect(seq?.startedAtMs == 1_000)
        #expect(seq?.startX == 40)
    }

    /// A clock that runs backwards (system time adjusted mid-gesture) must not read as fresh.
    @Test("a touch-down in the future is not fresh")
    func negativeAgeIsNotFresh() {
        let s = store()
        s.recordTouchDown(1, atMs: 2_000, x: 5, y: 6)
        s.begin(1, nowMs: 1_000, x: 40, y: 41, pointers: 1)

        #expect(s.end(1)?.startedAtMs == 1_000)
    }

    @Test("ending consumes the sequence, so a second end reports nothing")
    func endConsumes() {
        let s = store()
        s.begin(1, nowMs: 1_000, x: 0, y: 0, pointers: 1)
        #expect(s.end(1) != nil)
        #expect(s.end(1) == nil)
        #expect(s.inFlightCount == 0)
    }

    @Test("observing a key with nothing in flight cannot resurrect a sequence")
    func observeWithoutBeginIsNoop() {
        let s = store()
        s.observe(1, pointers: 3)
        #expect(s.inFlightCount == 0)
        #expect(s.end(1) == nil)
    }

    @Test("removeAll drops the previous run's half-finished sequences")
    func removeAllClears() {
        let s = store()
        s.recordTouchDown(1, atMs: 900, x: 1, y: 2)
        s.begin(1, nowMs: 1_000, x: 0, y: 0, pointers: 1)
        s.begin(2, nowMs: 1_000, x: 0, y: 0, pointers: 1)

        s.removeAll()
        #expect(s.inFlightCount == 0)
        #expect(s.end(1) == nil)

        // The touch-down went too: after a restart a fresh pan must not adopt the previous run's
        // landing point, which is what `startedAtMs` would otherwise date the gesture to.
        s.begin(1, nowMs: 1_100, x: 70, y: 70, pointers: 1)
        let seq = s.end(1)
        #expect(seq?.startX == 70)
        #expect(seq?.startedAtMs == 1_100)
    }
}
