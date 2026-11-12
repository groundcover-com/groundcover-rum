import SwiftUI
import Testing
import UIKit

@testable import GroundcoverRum

// The touch capture: sequences and what they classify as, the observer fed stand-in events, the
// swizzle rules, the target a touch names, and the lifecycle mapping. The sendEvent swizzle itself
// runs on a device, in the e2e suite.

// Held, so the two identifiers can't share an address.
private let fingers = (NSObject(), NSObject())
private let finger = ObjectIdentifier(fingers.0)
private let secondFinger = ObjectIdentifier(fingers.1)

private func sample(
    _ phase: TouchPhase, _ x: Double, _ y: Double, at timeMs: Double,
    id: ObjectIdentifier = finger
) -> TouchSample {
    TouchSample(id: id, phase: phase, x: x, y: y, timeMs: timeMs)
}

private func sequence(_ samples: [TouchSample]) -> TouchSequence? {
    let tracker = TouchTracker()
    for edge in tracker.process(samples) {
        if case .ended(let sequence) = edge { return sequence }
    }
    return nil
}

@Suite struct TouchTrackerTests {
    @Test func theFirstFingerDownStartsASequenceAndTheLastOneUpEndsIt() {
        let tracker = TouchTracker()
        let down = tracker.process([sample(.began, 10, 10, at: 0)])
        #expect(down.count == 1)
        guard case .began = down[0] else {
            Issue.record("expected began")
            return
        }
        #expect(tracker.process([sample(.began, 50, 50, at: 10, id: secondFinger)]).isEmpty)
        #expect(tracker.process([sample(.ended, 10, 10, at: 20)]).isEmpty)
        let up = tracker.process([sample(.ended, 50, 50, at: 30, id: secondFinger)])
        guard case .ended(let finished) = up.first else {
            Issue.record("expected ended")
            return
        }
        #expect(finished.pointerCount == 2)
        #expect(finished.durationMs == 20)
    }

    @Test func aQuickStillTouchIsATap() throws {
        let finished = try #require(
            sequence([
                sample(.began, 100, 100, at: 1000), sample(.moved, 104, 103, at: 1050),
                sample(.ended, 103, 102, at: 1100),
            ]))
        #expect(TouchClassifier.classify(finished)?.kind == .tap)
        #expect(finished.endX == 103 && finished.endY == 102)
    }

    @Test func aTouchThatLeftTheSlopIsNoTapEvenIfItCameBack() throws {
        let finished = try #require(
            sequence([
                sample(.began, 100, 100, at: 0), sample(.moved, 115, 100, at: 50),
                sample(.ended, 100, 100, at: 100),
            ]))
        #expect(finished.maxTravel == 15)
        // Out of the slop, and back to under the 32 points a scroll needs: nothing.
        #expect(TouchClassifier.classify(finished) == nil)
    }

    @Test func aStillTouchHeldPast500msIsALongPress() throws {
        let tap = try #require(
            sequence([sample(.began, 0, 0, at: 0), sample(.ended, 0, 0, at: 500)]))
        #expect(TouchClassifier.classify(tap)?.kind == .tap)
        let held = try #require(
            sequence([
                sample(.began, 0, 0, at: 0), sample(.moved, 3, 4, at: 600),
                sample(.ended, 3, 4, at: 1200),
            ]))
        let press = try #require(TouchClassifier.classify(held))
        #expect(press.kind == .longPress)
        #expect(press.gesture?.durationMs == 1200)
        #expect(press.gesture?.distanceDp == 5)
        #expect(press.gesture?.pointerCount == 1)
        #expect(press.gesture?.direction == nil)
    }

    @Test func aSlowDragIsAScrollWithItsReleaseVelocity() throws {
        // 50 points up over a second, at a steady pace: the release velocity is the pace.
        var samples = [sample(.began, 100, 300, at: 0)]
        for step in 1...10 {
            samples.append(sample(.moved, 100, 300 - Double(step) * 5, at: Double(step) * 100))
        }
        samples.append(sample(.ended, 100, 250, at: 1000))
        let finished = try #require(sequence(samples))
        let result = try #require(TouchClassifier.classify(finished))
        #expect(result.kind == .scroll)
        #expect(result.gesture?.direction == .up)
        #expect(result.gesture?.distanceDp == 50)
        #expect(result.gesture?.durationMs == 1000)
        #expect((45...55).contains(result.gesture?.velocityDpS ?? 0))
        #expect(result.gesture?.partial == false)
    }

    @Test func aFastFlickIsASwipe() throws {
        var samples = [sample(.began, 100, 600, at: 0)]
        for step in 1...6 {
            samples.append(sample(.moved, 100, 600 - Double(step) * 75, at: Double(step) * 25))
        }
        samples.append(sample(.ended, 100, 150, at: 150))
        let finished = try #require(sequence(samples))
        let result = try #require(TouchClassifier.classify(finished))
        #expect(result.kind == .swipe)
        #expect(result.gesture?.distanceDp == 450)
        #expect((2700...3300).contains(result.gesture?.velocityDpS ?? 0))
    }

    @Test func aFlickThatComesToRestBeforeReleaseIsAScroll() throws {
        // 200 points in 100 ms, then held still for 300 ms: fast on average, at rest when let go.
        var samples = [sample(.began, 100, 600, at: 0)]
        for step in 1...4 {
            samples.append(sample(.moved, 100, 600 - Double(step) * 50, at: Double(step) * 25))
        }
        for step in 1...6 {
            samples.append(sample(.moved, 100, 400, at: 100 + Double(step) * 50))
        }
        samples.append(sample(.ended, 100, 400, at: 400))
        let finished = try #require(sequence(samples))
        let result = try #require(TouchClassifier.classify(finished))
        #expect(result.kind == .scroll)
        #expect(result.gesture?.velocityDpS == 0)
    }

    @Test func twoFingersAreAPinchMeasuredByTheirSpread() throws {
        let pinch = try #require(
            sequence([
                sample(.began, 100, 100, at: 0), sample(.began, 200, 100, at: 5, id: secondFinger),
                sample(.moved, 50, 100, at: 100),
                sample(.moved, 250, 100, at: 100, id: secondFinger),
                sample(.ended, 50, 100, at: 200),
                sample(.ended, 250, 100, at: 210, id: secondFinger),
            ]))
        let result = try #require(TouchClassifier.classify(pinch))
        #expect(result.kind == .pinch)
        #expect(result.gesture?.pointerCount == 2)
        #expect(result.gesture?.distanceDp == 100)
        #expect(result.gesture?.direction == nil)
    }

    @Test func twoFingersOrACancelledTouchAreNoTap() throws {
        let twoFingers = try #require(
            sequence([
                sample(.began, 0, 0, at: 0), sample(.began, 40, 0, at: 5, id: secondFinger),
                sample(.ended, 0, 0, at: 50), sample(.ended, 40, 0, at: 60, id: secondFinger),
            ]))
        #expect(TouchClassifier.classify(twoFingers)?.kind == .pinch)
        let cancelled = try #require(
            sequence([sample(.began, 0, 0, at: 0), sample(.cancelled, 0, 0, at: 50)]))
        #expect(cancelled.cancelled)
        #expect(TouchClassifier.classify(cancelled) == nil)
    }

    @Test func aResetForgetsASequenceInFlight() {
        let tracker = TouchTracker()
        _ = tracker.process([sample(.began, 0, 0, at: 0)])
        tracker.reset()
        #expect(tracker.process([sample(.ended, 0, 0, at: 10)]).isEmpty)
    }
}

// Stand-ins for what UIKit hands sendEvent, so the observer runs without a device.
private final class StandInTouch: UITouch {
    var stage: UITouch.Phase = .began
    var time: TimeInterval = 1
    private let place: CGPoint
    private let home: UIWindow
    private let touched: UIView?

    /// On `view` in `window`, or on the window itself.
    init(at place: CGPoint, in window: UIWindow, on view: UIView? = nil) {
        self.place = place
        home = window
        touched = view
        super.init()
    }

    override var phase: UITouch.Phase { stage }
    override var timestamp: TimeInterval { time }
    override var window: UIWindow? { home }
    override var view: UIView? { touched ?? home }
    override var gestureRecognizers: [UIGestureRecognizer]? { nil }
    override func location(in view: UIView?) -> CGPoint { place }
}

private final class StandInEvent: UIEvent {
    private let touches: Set<UITouch>

    init(_ touches: UITouch...) {
        self.touches = Set(touches)
        super.init()
    }

    override var type: UIEvent.EventType { .touches }
    override var allTouches: Set<UITouch>? { touches }
}

/// Named as the system keyboard's window is (`UIRemoteKeyboardWindow`).
private final class RemoteKeyboardWindow: UIWindow {}

/// Named as the system keyboard's own views are (`UIKBKeyView`).
@objc(UIKBStandInKeyView) private final class KeyView: UIView {}

@Suite @MainActor struct TouchObserverTests {
    private final class Seen {
        var presence = 0
        var kinds: [InteractionKind] = []
    }

    private func observed(_ body: (TouchObserver) -> Void) -> Seen {
        let observer = TouchObserver()
        let seen = Seen()
        observer.onPresence = { seen.presence += 1 }
        observer.onInteraction = { seen.kinds.append($0.kind) }
        body(observer)
        return seen
    }

    /// One finger down and up 100 ms later, where it went down, on `view` or the window.
    private func tap(
        _ observer: TouchObserver, in window: UIWindow, on view: UIView? = nil,
        at time: TimeInterval = 1
    ) {
        let touch = StandInTouch(at: CGPoint(x: 40, y: 700), in: window, on: view)
        touch.time = time
        observer.handle(StandInEvent(touch))
        touch.stage = .ended
        touch.time = time + 0.1
        observer.handle(StandInEvent(touch))
    }

    @Test func aTapInTheAppsWindowIsPresenceAndATap() {
        let window = aWindow()
        let seen = observed { tap($0, in: window) }
        #expect(seen.presence == 1)
        #expect(seen.kinds == [.tap])
    }

    @Test func aKeystrokeOnTheSystemKeyboardIsPresenceButNeverATap() {
        let keyboard = RemoteKeyboardWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let key = KeyView(frame: CGRect(x: 0, y: 680, width: 80, height: 40))
        let glyph = UIView(frame: key.bounds)
        key.addSubview(glyph)
        keyboard.addSubview(key)
        let seen = observed { tap($0, in: keyboard, on: glyph) }
        #expect(seen.presence == 1)
        #expect(seen.kinds.isEmpty)
    }

    @Test func aTapOnTheAppsAccessoryViewInTheKeyboardsWindowIsATap() {
        // A chat composer's Send, or a keyboard toolbar's Done: the app's own view, which UIKit
        // puts in the keyboard's window, above the keys. A test process shows no keyboard, and
        // so no accessory view: this one stands in.
        let keyboard = RemoteKeyboardWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let composer = UIView(frame: CGRect(x: 0, y: 680, width: 400, height: 50))
        let send = UIButton(type: .system)
        send.setTitle("Send", for: .normal)
        send.frame = CGRect(x: 0, y: 0, width: 80, height: 50)
        composer.addSubview(send)
        keyboard.addSubview(composer)
        let field = UITextField()
        field.inputAccessoryView = composer
        let seen = observed {
            $0.findFirstResponder = { field }
            tap($0, in: keyboard, on: send)
        }
        #expect(seen.presence == 1)
        #expect(seen.kinds == [.tap])
    }

    @Test func aTouchOnAnyOtherViewInTheKeyboardsWindowIsAKeystroke() {
        // The prediction bar, on releases that draw it in the app's process, sits beside the keys
        // rather than under them, and a prediction names the word being typed.
        let keyboard = RemoteKeyboardWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let prediction = UILabel(frame: CGRect(x: 0, y: 640, width: 130, height: 40))
        prediction.text = "password"
        keyboard.addSubview(prediction)
        let field = UITextField()
        field.inputAccessoryView = UIView()
        let seen = observed {
            $0.findFirstResponder = { field }
            tap($0, in: keyboard, on: prediction)
        }
        #expect(seen.presence == 1)
        #expect(seen.kinds.isEmpty)
    }

    @Test func aTouchOnTheFirstRespondersInputViewIsAKeystroke() throws {
        // A custom keypad, which UIKit puts in the keyboard's window with none of the keyboard's
        // own views around it: its keys would spell what was typed.
        let window = aWindow()
        // Made key, or UIKit doesn't put the field's input view on screen.
        window.makeKey()
        let field = UITextField(frame: CGRect(x: 10, y: 100, width: 300, height: 40))
        let keypad = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 200))
        let digit = UIButton(type: .system)
        digit.setTitle("7", for: .normal)
        digit.frame = CGRect(x: 0, y: 0, width: 80, height: 50)
        keypad.addSubview(digit)
        field.inputView = keypad
        window.rootViewController?.view.addSubview(field)
        try #require(field.becomeFirstResponder())
        defer { field.resignFirstResponder() }
        let keyboard = try #require(digit.window)
        #expect(NSStringFromClass(type(of: keyboard)).contains("Keyboard"))
        // An action sent to no target finds no first responder in a test process, which has no
        // scene: the test names it.
        let touch = StandInTouch(at: CGPoint(x: 40, y: 700), in: keyboard, on: digit)
        #expect(TouchObserver.isKeystroke(touch, responder: field))
    }

    @Test func aFingerDownAloneStartsASequenceThoughAnEarlierEndWasLost() {
        let window = aWindow()
        // A finger whose end never reached sendEvent. Held, so the next touch can't take its
        // address, and with it its identifier.
        let lost = StandInTouch(at: CGPoint(x: 40, y: 100), in: window)
        let seen = observed { observer in
            observer.handle(StandInEvent(lost))
            tap(observer, in: window, at: 5)
        }
        #expect(seen.presence == 2)
        #expect(seen.kinds == [.tap])
    }

    @Test func aSecondFingerDownJoinsTheSequenceInFlight() {
        let window = aWindow()
        let first = StandInTouch(at: CGPoint(x: 100, y: 400), in: window)
        let second = StandInTouch(at: CGPoint(x: 300, y: 400), in: window)
        let seen = observed { observer in
            observer.handle(StandInEvent(first))
            first.stage = .stationary
            second.time = 1.05
            observer.handle(StandInEvent(first, second))
            first.stage = .ended
            second.stage = .ended
            first.time = 1.2
            second.time = 1.2
            observer.handle(StandInEvent(first, second))
        }
        #expect(seen.presence == 1)
        #expect(seen.kinds == [.pinch])
    }
}

@Suite struct LifecycleMapperTests {
    @Test func theLaunchIsNoReturnAndALaterReturnIs() {
        var mapper = LifecycleMapper(initialState: .inactive)
        #expect(mapper.didBecomeActive() == nil)
        #expect(mapper.willResignActive() == .inactive)
        #expect(mapper.didEnterBackground() == .background)
        #expect(mapper.didBecomeActive() == .foreground)
    }

    @Test func anOverlayThatOnlyMadeTheAppInactiveIsAReturnToo() {
        var mapper = LifecycleMapper(initialState: .active)
        #expect(mapper.willResignActive() == .inactive)
        #expect(mapper.didBecomeActive() == .foreground)
    }

    @Test func aLaunchReadAsBackgroundIsNoReturnButALaterDepartureIs() {
        // What a scene-based app reads in didFinishLaunching, where the SDK starts (iOS 18.2 and
        // 26.5 simulators).
        var mapper = LifecycleMapper(initialState: .background)
        #expect(mapper.didBecomeActive() == nil)
        #expect(mapper.didEnterBackground() == .background)
        #expect(mapper.didBecomeActive() == .foreground)
    }

    @Test func theBackgroundIsReportedOncePerDeparture() {
        var mapper = LifecycleMapper(initialState: .active)
        #expect(mapper.didEnterBackground() == .background)
        #expect(mapper.didEnterBackground() == nil)
    }
}

// A class to swizzle in tests, so the rules are checked without touching UIKit's classes.
private class SwizzleTarget: NSObject {
    var log: [String] = []
    @objc dynamic func greet(_ name: NSString) { log.append("original \(name)") }
    @objc dynamic func count() -> Int { 1 }
}

private class SwizzleSubclass: SwizzleTarget {}

private typealias Greet = @convention(c) (AnyObject, Selector, NSString) -> Void

private func hook(_ cls: AnyClass, tag: String) -> Bool {
    let selector = #selector(SwizzleTarget.greet(_:))
    return Swizzle.replace(cls, selector, signature: "v@:@") { previous in
        let original = unsafeBitCast(previous, to: Greet.self)
        let block: @convention(block) (AnyObject, NSString) -> Void = { object, name in
            original(object, selector, name)
            (object as? SwizzleTarget)?.log.append(tag)
        }
        return block
    }
}

@Suite(.serialized) struct SwizzleTests {
    @Test func aSwizzleBeforeAndAfterOursAllRunAndTheOriginalOnce() {
        #expect(hook(SwizzleTarget.self, tag: "before"))
        #expect(hook(SwizzleTarget.self, tag: "ours"))
        #expect(hook(SwizzleTarget.self, tag: "after"))
        let target = SwizzleTarget()
        target.greet("x")
        #expect(target.log == ["original x", "before", "ours", "after"])
    }

    @Test func anInheritedMethodIsNotReplaced() {
        #expect(!hook(SwizzleSubclass.self, tag: "sub"))
    }

    @Test func aMethodOfAnotherShapeIsNotReplaced() {
        let replaced = Swizzle.replace(
            SwizzleTarget.self, #selector(SwizzleTarget.count), signature: "v@:@"
        ) { _ in
            let block: @convention(block) (AnyObject) -> Int = { _ in 2 }
            return block
        }
        #expect(!replaced)
        #expect(SwizzleTarget().count() == 1)
    }

    @Test func encodingsAreComparedWithoutOffsets() {
        #expect(Swizzle.strippedEncoding("v24@0:8@16") == "v@:@")
        #expect(Swizzle.strippedEncoding("v20@0:8B16") == "v@:B")
    }

    @Test @MainActor func sendEventIsTheMethodTheObserverExpects() {
        #expect(
            Swizzle.method(
                UIApplication.self, #selector(UIApplication.sendEvent(_:)), signature: "v@:@")
                != nil)
    }
}

/// A shown 400 × 800 window holding `root`.
@MainActor
func aWindow(_ root: UIViewController = UIViewController()) -> UIWindow {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
    window.rootViewController = root
    window.isHidden = false
    return window
}

@MainActor
private func center(of view: UIView, in window: UIWindow) -> CGPoint {
    view.convert(CGPoint(x: view.bounds.midX, y: view.bounds.midY), to: window)
}

@MainActor
private func hosted<V: View>(_ view: V, in window: UIWindow) -> UIView {
    let host = UIHostingController(rootView: view)
    window.rootViewController = host
    host.view.frame = window.bounds
    host.view.setNeedsLayout()
    host.view.layoutIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    return host.view
}

@Suite @MainActor struct TargetResolverTests {
    @Test func aUIKitButtonIsNamedByItsTitleWithItsRoleClassAndPath() {
        let window = aWindow()
        let button = UIButton(type: .system)
        button.setTitle("Pay now", for: .normal)
        button.frame = CGRect(x: 20, y: 100, width: 200, height: 44)
        window.rootViewController?.view.addSubview(button)
        let target = TargetResolver.resolve(
            touchedView: button, window: window, point: center(of: button, in: window))
        #expect(target.label == "Pay now")
        #expect(target.role == "button")
        #expect(target.component == "UIButton")
        #expect(target.componentPath.hasSuffix("UIView > UIButton"))
        #expect(!target.masked)
    }

    @Test func theAccessibilityLabelWinsOverTheTitleAsTheBrowserDoes() {
        let window = aWindow()
        let button = UIButton(type: .system)
        button.setTitle("Well-tagged button (tapped 3)", for: .normal)
        button.accessibilityLabel = "Increment counter"
        button.accessibilityHint = "Adds one to the counter"
        button.frame = CGRect(x: 20, y: 100, width: 300, height: 44)
        window.rootViewController?.view.addSubview(button)
        let target = TargetResolver.resolve(
            touchedView: button, window: window, point: center(of: button, in: window))
        #expect(target.label == "Increment counter")
        #expect(target.hint == "Adds one to the counter")
    }

    @Test func aViewWithNoLabelIsNamedByTheTextInsideIt() {
        let window = aWindow()
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 400, height: 60))
        row.isAccessibilityElement = true
        let text = UILabel(frame: CGRect(x: 10, y: 10, width: 200, height: 30))
        text.text = "Row 3"
        row.addSubview(text)
        window.rootViewController?.view.addSubview(row)
        let target = TargetResolver.resolve(
            touchedView: row, window: window, point: center(of: row, in: window))
        #expect(target.label == "Row 3")
    }

    @Test func viewsTheTouchIsOutsideCostNoneOfTheSearch() {
        // A dense half of the screen first, past the search's budget, and the touched row in the
        // other half: the search goes straight past the dense half, as UIKit's hit test does.
        let window = aWindow()
        let dense = UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
        for _ in 0...TargetResolver.nodeBudget {
            dense.addSubview(UIView(frame: CGRect(x: 0, y: 0, width: 400, height: 400)))
        }
        let row = UIView(frame: CGRect(x: 0, y: 500, width: 400, height: 60))
        row.isAccessibilityElement = true
        row.accessibilityLabel = "Pay"
        row.accessibilityTraits = .button
        let root = window.rootViewController!.view!
        root.addSubview(dense)
        root.addSubview(row)
        let target = TargetResolver.resolve(
            touchedView: root, window: window, point: center(of: row, in: window))
        #expect(target.label == "Pay")
        #expect(target.role == "button")
    }

    @Test func anElementOutsideItsContainerIsntNamedSinceUIKitDeliversNoTouchThere() {
        // UIKit's hit test never looks inside a view the touch is outside of, so an element drawn
        // past its container's edge doesn't get the touch, and the view behind it is named.
        let window = aWindow()
        let container = UIView(frame: CGRect(x: 0, y: 100, width: 400, height: 100))
        container.clipsToBounds = false
        let outside = UIView(frame: CGRect(x: 0, y: 150, width: 400, height: 60))
        outside.isAccessibilityElement = true
        outside.accessibilityLabel = "Drawn outside"
        container.addSubview(outside)
        let root = window.rootViewController!.view!
        root.addSubview(container)
        let target = TargetResolver.resolve(
            touchedView: root, window: window, point: center(of: outside, in: window))
        #expect(target.label == "")
    }

    @Test func aPrivateAncestorMasksAndSelectedAndDisabledAreState() {
        let window = aWindow()
        let card = UIView(frame: CGRect(x: 0, y: 100, width: 400, height: 200))
        card.groundcoverPrivate = true
        let button = UIButton(type: .system)
        button.setTitle("Secret", for: .normal)
        button.isSelected = true
        button.isEnabled = false
        button.frame = CGRect(x: 10, y: 10, width: 200, height: 44)
        card.addSubview(button)
        window.rootViewController?.view.addSubview(card)
        let target = TargetResolver.resolve(
            touchedView: button, window: window, point: center(of: button, in: window))
        #expect(target.masked)
        #expect(target.state?["selected"] as? Bool == true)
        #expect(target.state?["disabled"] as? Bool == true)
    }

    @Test func aPrivateLabelMasksATouchItsContainerReceived() {
        let window = aWindow()
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 400, height: 60))
        let email = UILabel(frame: CGRect(x: 10, y: 10, width: 300, height: 30))
        email.text = "jane@example.com"
        // An element, as UIKit's accessibility makes every label on a device. A label takes no
        // touches, so UIKit delivers the touch to the row.
        email.isAccessibilityElement = true
        email.groundcoverPrivate = true
        row.addSubview(email)
        window.rootViewController?.view.addSubview(row)
        let target = TargetResolver.resolve(
            touchedView: row, window: window, point: center(of: email, in: window))
        #expect(target.label == "jane@example.com")
        #expect(target.masked)
    }

    @Test func aPrivateViewInsideTheElementMasksTheLabelItsTextIsIn() {
        let window = aWindow()
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 400, height: 60))
        row.isAccessibilityElement = true
        let brand = UILabel(frame: CGRect(x: 10, y: 10, width: 100, height: 30))
        brand.text = "Visa"
        let number = UILabel(frame: CGRect(x: 200, y: 10, width: 190, height: 30))
        number.text = "4242 4242 4242 4242"
        number.groundcoverPrivate = true
        row.addSubview(brand)
        row.addSubview(number)
        window.rootViewController?.view.addSubview(row)
        let target = TargetResolver.resolve(
            touchedView: row, window: window, point: center(of: brand, in: window))
        #expect(target.label == "Visa 4242 4242 4242 4242")
        #expect(target.masked)
    }

    @Test func aPrivateSwiftUIViewOverlappingAnElementMasksATouchAnywhereOnIt() {
        // SwiftUI's elements aren't views: one stands in for a row, its private text's marker at
        // the row's far end, away from the touch.
        let window = aWindow()
        let host = UIView(frame: window.bounds)
        window.rootViewController?.view.addSubview(host)
        let row = UIAccessibilityElement(accessibilityContainer: host)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "Visa 4242 4242 4242 4242"
        row.accessibilityFrame = CGRect(x: 0, y: 200, width: 400, height: 60)
        host.accessibilityElements = [row]
        host.addSubview(PrivateMarkerView(frame: CGRect(x: 200, y: 210, width: 190, height: 40)))
        let target = TargetResolver.resolve(
            touchedView: host, window: window, point: CGPoint(x: 50, y: 230))
        #expect(target.label == "Visa 4242 4242 4242 4242")
        #expect(target.masked)
    }

    @Test func aLabelUnderAPrivateSwiftUIViewMasksTheTextItNames() {
        // A UIKit label in a private SwiftUI view: the marker sits behind it, away from the touch.
        let window = aWindow()
        let row = UIView(frame: CGRect(x: 0, y: 200, width: 400, height: 60))
        row.isAccessibilityElement = true
        let brand = UILabel(frame: CGRect(x: 10, y: 10, width: 100, height: 30))
        brand.text = "Visa"
        let number = UILabel(frame: CGRect(x: 200, y: 10, width: 190, height: 30))
        number.text = "4242 4242 4242 4242"
        row.addSubview(PrivateMarkerView(frame: number.frame))
        row.addSubview(brand)
        row.addSubview(number)
        window.rootViewController?.view.addSubview(row)
        let target = TargetResolver.resolve(
            touchedView: row, window: window, point: center(of: brand, in: window))
        #expect(target.label == "Visa 4242 4242 4242 4242")
        #expect(target.masked)
    }

    @Test func swiftUIsOwnViewIsntNamedByTheUIKitTextInsideIt() {
        // With accessibility off, a tap on a SwiftUI control finds no element and lands on one of
        // SwiftUI's views, whose UIKit text, a segmented picker's here, is another control's.
        let window = aWindow()
        let root = hosted(
            VStack {
                Picker("Plan", selection: .constant(0)) {
                    Text("Monthly").tag(0)
                    Text("Yearly").tag(1)
                }
                .pickerStyle(.segmented)
                Spacer()
            }, in: window)
        let target = TargetResolver.resolve(
            touchedView: root, window: window, point: CGPoint(x: 200, y: 600))
        #expect(target.label == "")
        // Left unnamed, the gesture names it.
        let named = SwiftUIGestures.named(
            target, recognizerNames: ["Button<ResolvedButtonStyleBody<BorderlessButtonStyleBase>>"],
            description: { "" })
        #expect(named.component == "Button")
    }

    @Test func aTextFieldsValueIsNeverRead() {
        let window = aWindow()
        let field = UITextField(frame: CGRect(x: 10, y: 100, width: 300, height: 40))
        field.accessibilityLabel = "Search field"
        field.text = "hunter2@example.com"
        // What UIKit's accessibility reports for a field on a device: the text typed in it.
        field.accessibilityValue = "hunter2@example.com"
        window.rootViewController?.view.addSubview(field)
        let target = TargetResolver.resolve(
            touchedView: field, window: window, point: center(of: field, in: window))
        #expect(target.label == "Search field")
        #expect(target.role == "textfield")
        #expect(target.valueText == nil)
    }

    @Test func aSwiftUIButtonIsFoundInTheAccessibilityTree() throws {
        let window = aWindow()
        let root = hosted(
            VStack(spacing: 40) {
                Button("Well-tagged button (tapped 0)") {}
                    .accessibilityLabel("Increment counter")
                    .accessibilityHint("Adds one to the counter")
                Button("A11y annotated button") {}
                    .accessibilityAddTraits(.isSelected)
                    .accessibilityValue(Text("forty two percent"))
            }, in: window)
        guard let element = swiftUIElement("Increment counter", in: root) else { return }
        let target = TargetResolver.resolve(
            touchedView: root, window: window,
            point: window.convert(element.center, from: window.screen.coordinateSpace))
        #expect(target.label == "Increment counter")
        #expect(target.hint == "Adds one to the counter")
        #expect(target.role == "button")
        #expect(target.component == "")

        let annotated = try #require(
            elementFrames(in: root).first { $0.label == "A11y annotated button" })
        let annotatedTarget = TargetResolver.resolve(
            touchedView: root, window: window,
            point: window.convert(annotated.center, from: window.screen.coordinateSpace))
        #expect(annotatedTarget.state?["selected"] as? Bool == true)
        #expect(annotatedTarget.valueText == "forty two percent")
    }

    @Test func aSwiftUIPrivateViewMasksATouchInsideIt() throws {
        let window = aWindow()
        let root = hosted(
            VStack(spacing: 40) {
                Button("Private action") {}.groundcoverPrivate()
                Button("Public action") {}
            }, in: window)
        guard let privateOne = swiftUIElement("Private action", in: root) else { return }
        let publicOne = try #require(elementFrames(in: root).first { $0.label == "Public action" })
        func resolve(_ element: (label: String, center: CGPoint)) -> InteractionTarget {
            TargetResolver.resolve(
                touchedView: root, window: window,
                point: window.convert(element.center, from: window.screen.coordinateSpace))
        }
        #expect(resolve(privateOne).masked)
        #expect(!resolve(publicOne).masked)
    }

    @Test func thePathKeepsTheInnermostTenNamesAndDropsPrivateClasses() {
        var view = UIView()
        let window = aWindow()
        window.rootViewController?.view.addSubview(view)
        for _ in 0..<15 {
            let child = UIView()
            view.addSubview(child)
            view = child
        }
        let path = TargetResolver.componentPath(of: view)
        #expect(path.components(separatedBy: " > ").count == 10)
        #expect(!path.contains("_"))
        #expect(path.count <= 200)
    }
}

// What the touch observer reads while a finger is down on a SwiftUI control with the system's
// accessibility off, as recorded on iOS 26.5 and 18.2 simulators: the recognizer names, and the
// touch's description where they don't say.
@Suite struct SwiftUIGesturesTests {
    /// The resolver's answer for a SwiftUI control with no accessibility tree: the hosting view.
    private let unnamed = InteractionTarget(
        component: "HostingView", componentPath: "UIWindow > UITransitionView > HostingView")

    @Test func aRecognizerNamedAfterAButtonNamesTheTargetAButtonWithNoLabel() {
        var described = false
        let target = SwiftUIGestures.named(
            unnamed,
            recognizerNames: [nil, "Button<ResolvedButtonStyleBody<BorderedButtonStyle_Phone>>"],
            description: {
                described = true
                return ""
            })
        #expect(target.component == "Button")
        #expect(target.role == "button")
        #expect(target.label == "")
        #expect(target.componentPath == unnamed.componentPath)
        // The name settles it: the description isn't built.
        #expect(!described)
    }

    @Test func theDescriptionsButtonGestureNamesItWhereNoRecognizerIsNamed() {
        let target = SwiftUIGestures.named(
            unnamed, recognizerNames: [nil, nil],
            description: {
                "<UITouch: 0x1> type: Direct; phase: Began; responder: UIKitGestureContainer<"
                    + "ModifierGesture<GestureLabelModifier<()>, ModifierGesture<CallbacksGesture<"
                    + "FailedCallbacks<()>>, _ButtonGesture>>> 0x2; "
            })
        #expect(target.component == "Button")
        #expect(target.role == "button")
    }

    @Test func aTapGestureStaysUnnamed() {
        let target = SwiftUIGestures.named(
            unnamed, recognizerNames: [nil],
            description: {
                "<UITouch: 0x1> type: Direct; phase: Began; "
                    + "responder: UIKitGestureContainer<_EndedGesture<TapGesture>> 0x2; "
            })
        #expect(target.component == "HostingView")
        #expect(target.role == "")
    }

    @Test func aTargetSomethingElseNamedIsKept() {
        let buttonName: [String?] = ["Button<ResolvedButtonStyleBody<BorderlessButtonStyleBase>>"]
        // From SwiftUI's accessibility tree, with accessibility on.
        let element = InteractionTarget(label: "Increment counter", role: "button")
        let fromTree = SwiftUIGestures.named(
            element, recognizerNames: buttonName, description: { "" })
        #expect(fromTree.component == "")
        #expect(fromTree.label == "Increment counter")
        // A UIKit control with a role and no name, a SwiftUI Toggle's switch among them.
        let control = InteractionTarget(component: "UISwitch", role: "switch")
        let uikit = SwiftUIGestures.named(control, recognizerNames: buttonName, description: { "" })
        #expect(uikit.component == "UISwitch")
        #expect(uikit.role == "switch")
    }
}

/// The accessibility elements under `root`, with their centres in screen coordinates.
@MainActor
private func elementFrames(in root: NSObject) -> [(label: String, center: CGPoint)] {
    var found: [(label: String, center: CGPoint)] = []
    func walk(_ node: NSObject, _ depth: Int) {
        guard depth < 30 else { return }
        if node.isAccessibilityElement {
            let frame = node.accessibilityFrame
            found.append((node.accessibilityLabel ?? "", CGPoint(x: frame.midX, y: frame.midY)))
            return
        }
        if let elements = node.accessibilityElements as? [NSObject], !elements.isEmpty {
            for element in elements { walk(element, depth + 1) }
        } else if let view = node as? UIView {
            for subview in view.subviews { walk(subview, depth + 1) }
        }
    }
    walk(root, 0)
    return found
}

/// The SwiftUI element labelled `label` under `root`, or nil, recorded as a known issue, when this
/// process has no SwiftUI accessibility tree. SwiftUI builds one only while the system's
/// accessibility is on (VoiceOver, a simulator's `ApplicationAccessibilityEnabled`, or an automation
/// client such as the e2e driver), and a fresh simulator, CI's among them, has it off.
@MainActor
private func swiftUIElement(_ label: String, in root: UIView) -> (label: String, center: CGPoint)? {
    if let element = elementFrames(in: root).first(where: { $0.label == label }) { return element }
    withKnownIssue("No SwiftUI accessibility element in this test process") {
        Issue.record("No element labelled \(label)")
    }
    return nil
}
