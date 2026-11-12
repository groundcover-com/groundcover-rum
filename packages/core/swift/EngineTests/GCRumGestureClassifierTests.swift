import Foundation
import Testing
@testable import GroundcoverRumEngine

/// Direction, distance and swipe-vs-scroll. Every failure mode here is silent:
/// a flipped axis reports every scroll as its opposite and nothing crashes, no
/// e2e assertion on "some direction" notices, and the dashboard is confidently
/// wrong.
@Suite("Gesture classification")
struct GCRumGestureClassifierTests {
    private func classify(
        from start: (Double, Double),
        to end: (Double, Double),
        velocity: (Double, Double) = (0, 0),
        pointerCount: Int = 1
    ) -> GCRumGestureClassifier.Result? {
        GCRumGestureClassifier.classify(
            startX: start.0,
            startY: start.1,
            endX: end.0,
            endY: end.1,
            velocityX: velocity.0,
            velocityY: velocity.1,
            pointerCount: pointerCount
        )
    }

    // MARK: - Direction

    /// Screen coordinates grow DOWNWARD. Dragging a finger toward the top of
    /// the screen decreases y and is "up" — the inversion people get wrong.
    @Test("a drag toward the top of the screen is up")
    func dragTowardTopIsUp() {
        let result = classify(from: (100, 500), to: (100, 100))
        #expect(result?.direction == "up")
    }

    @Test("a drag toward the bottom of the screen is down")
    func dragTowardBottomIsDown() {
        let result = classify(from: (100, 100), to: (100, 500))
        #expect(result?.direction == "down")
    }

    @Test("a drag toward the left edge is left")
    func dragTowardLeftIsLeft() {
        let result = classify(from: (500, 100), to: (100, 100))
        #expect(result?.direction == "left")
    }

    @Test("a drag toward the right edge is right")
    func dragTowardRightIsRight() {
        let result = classify(from: (100, 100), to: (500, 100))
        #expect(result?.direction == "right")
    }

    @Test("a diagonal drag is reported along whichever axis it mostly went")
    func diagonalPicksDominantAxis() {
        // Mostly down, slightly right.
        #expect(classify(from: (0, 0), to: (40, 300))?.direction == "down")
        // Mostly right, slightly down.
        #expect(classify(from: (0, 0), to: (300, 40))?.direction == "right")
    }

    @Test("a perfectly diagonal drag resolves to the horizontal axis")
    func exactDiagonalPrefersHorizontal() {
        // Not a meaningful UX choice, just a tie-break that must be stable
        // rather than depending on floating-point noise.
        #expect(classify(from: (0, 0), to: (100, 100))?.direction == "right")
        #expect(classify(from: (0, 0), to: (-100, -100))?.direction == "left")
    }

    // MARK: - Minimum distance

    @Test("a movement below the reporting floor is not a gesture")
    func belowFloorIsNil() {
        #expect(classify(from: (0, 0), to: (0, 31)) == nil)
    }

    @Test("the floor is inclusive")
    func floorIsInclusive() {
        #expect(classify(from: (0, 0), to: (0, 32)) != nil)
    }

    @Test("distance is the straight line between the ends, not one axis")
    func distanceIsEuclidean() {
        // 3-4-5 triangle scaled: 30, 40 → 50.
        let result = classify(from: (0, 0), to: (30, 40))
        #expect(result?.distanceDp == 50)
    }

    // MARK: - Swipe vs scroll

    /// The distinction is intent: a flick released with momentum means "keep
    /// going", a drag that came to rest means "stop here".
    @Test("a drag released with momentum is a swipe")
    func fastIsSwipe() {
        let result = classify(from: (0, 0), to: (0, 400), velocity: (0, 1_200))
        #expect(result?.kind == "swipe")
        #expect(result?.velocityDpS == 1_200)
    }

    @Test("a drag that came to rest is a scroll")
    func slowIsScroll() {
        let result = classify(from: (0, 0), to: (0, 400), velocity: (0, 50))
        #expect(result?.kind == "scroll")
    }

    @Test("the swipe threshold is inclusive")
    func swipeThresholdIsInclusive() {
        #expect(classify(from: (0, 0), to: (0, 400), velocity: (0, 300))?.kind == "swipe")
        #expect(classify(from: (0, 0), to: (0, 400), velocity: (0, 299))?.kind == "scroll")
    }

    /// A two-finger drag is a PINCH, and native does not measure pinches — JavaScript's numbers are
    /// all there are for one, which is why `NATIVE_MEASURED_KINDS` deliberately omits it.
    ///
    /// Native therefore has to decline the sequence entirely. Classifying it as a scroll/swipe does
    /// not merely mislabel it: JS reports its `pinch` UNSUPPRESSED (suppression covers only
    /// swipe/scroll), so the same two-finger gesture arrives twice — once as a native `scroll`, once
    /// as a JS `pinch`. Duplicate interactions are exactly what the suppression mechanism exists to
    /// prevent.
    @Test("a multi-pointer sequence is declined, because a pinch is JavaScript's to report")
    func multiPointerIsDeclined() {
        #expect(classify(from: (0, 0), to: (200, 0), velocity: (600, 0), pointerCount: 2) == nil)
        #expect(classify(from: (0, 0), to: (200, 0), velocity: (10, 0), pointerCount: 3) == nil)
        // One finger travelling the same distance is still a gesture — the guard is on the pointer
        // count alone and must not swallow the ordinary case.
        #expect(classify(from: (0, 0), to: (200, 0), velocity: (600, 0), pointerCount: 1) != nil)
    }

    @Test("velocity is a magnitude, so direction of travel cannot make it slower")
    func velocityIsMagnitude() {
        // Negative components — travelling up and left — must still register as
        // fast. Summing them signed would cancel to zero.
        let result = classify(from: (500, 500), to: (100, 100), velocity: (-300, -400))
        #expect(result?.velocityDpS == 500)
        #expect(result?.kind == "swipe")
    }
}
