import AVKit
import SwiftUI
import Testing
import UIKit

@testable import GroundcoverRum

// Which view controllers are screens, their names and keys, the SwiftUI screens' keys, and the
// screen under a dismissed one. The appearance swizzles themselves run on a device, in the e2e
// suite.

private final class CheckoutViewController: UIViewController {}

/// A sheet whose dismissal the test declares: a test window has no scene, so UIKit never finishes
/// a presentation there, and its own flag never turns on.
private final class SheetViewController: UIViewController {
    var dismissing = false

    override var isBeingDismissed: Bool { dismissing }
}

/// A sheet's navigation controller, being dismissed.
private final class DismissedNavigationController: UINavigationController {
    override var isBeingDismissed: Bool { true }
}

private final class PushedViewController: UIViewController {}

private final class GenericViewController<T>: UIViewController {}

/// The shared base a hybrid app hosts its SwiftUI screens in.
private final class BaseHostingController<Content: View>: UIHostingController<Content> {}

/// One of the app's view controllers, holding `child`.
private final class HolderViewController: UIViewController {
    private let child: UIViewController

    init(holding child: UIViewController) {
        self.child = child
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        addChild(child)
        view.addSubview(child.view)
        child.didMove(toParent: self)
    }
}

@Suite(.serialized) @MainActor struct ScreenTrackerTests {
    /// The screens `body` reports, and what the tracker leaves to the next main-loop turn: the test
    /// suspends, so the main queue runs it.
    private func recorded(_ body: (ScreenTracker) -> Void) async -> [(String, String)] {
        let tracker = ScreenTracker()
        var screens: [(String, String)] = []
        tracker.onScreen = { screens.append(($0, $1)) }
        tracker.tracksViewControllers = true
        body(tracker)
        try? await Task.sleep(nanoseconds: 50_000_000)
        return screens
    }

    @Test func anAppsLeafViewControllerIsAScreenNamedByItsClass() async {
        let controller = CheckoutViewController()
        let screens = await recorded { $0.viewControllerAppeared(controller) }
        #expect(screens.map(\.0) == ["CheckoutViewController"])
        #expect(screens.first?.1 == "CheckoutViewController-1")
    }

    @Test func containersAndApplesControllersAreNotScreens() async {
        let container = HolderViewController(holding: CheckoutViewController())
        container.loadViewIfNeeded()
        let outer = HolderViewController(
            holding: UINavigationController(rootViewController: CheckoutViewController()))
        outer.loadViewIfNeeded()
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(container)
            tracker.viewControllerAppeared(outer)
            tracker.viewControllerAppeared(UINavigationController())
            tracker.viewControllerAppeared(UITabBarController())
            tracker.viewControllerAppeared(UIHostingController(rootView: Text("x")))
            tracker.viewControllerAppeared(UIViewController())
        }
        #expect(screens.isEmpty)
    }

    @Test func anAppsControllerHoldingOnlyApplesPlayerIsAScreen() async {
        let screen = HolderViewController(holding: AVPlayerViewController())
        screen.loadViewIfNeeded()
        let screens = await recorded { $0.viewControllerAppeared(screen) }
        #expect(screens.map(\.0) == ["HolderViewController"])
    }

    @Test func aControllerHoldingAHostingControllerLeavesTheScreenToItsSwiftUIView() async {
        // SwiftUI's onAppear comes before the viewDidAppear of the controller around it (iOS 18.2:
        // launch, push, pop, full-screen present), so a shell reported as a screen would take over
        // the name its SwiftUI view gave.
        let shell = HolderViewController(holding: UIHostingController(rootView: Text("Home")))
        shell.loadViewIfNeeded()
        let screens = await recorded { $0.viewControllerAppeared(shell) }
        #expect(screens.isEmpty)
    }

    @Test func anAppsSubclassOfAHostingControllerLeavesTheScreenToItsSwiftUIView() async {
        let screens = await recorded {
            $0.viewControllerAppeared(BaseHostingController(rootView: Text("Home")))
        }
        #expect(screens.isEmpty)
    }

    @Test func aGenericControllersNameLosesItsArguments() {
        #expect(
            ScreenTracker.screenName(of: GenericViewController<Int>()) == "GenericViewController")
    }

    @Test func oneControllerKeepsItsKeyAndAnotherGetsTheNext() async {
        let first = CheckoutViewController()
        let second = CheckoutViewController()
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(first)
            tracker.viewControllerAppeared(second)
            tracker.viewControllerAppeared(first)
        }
        #expect(
            screens.map(\.1) == [
                "CheckoutViewController-1", "CheckoutViewController-2", "CheckoutViewController-1",
            ])
    }

    @Test func aSwiftUIScreenKeepsItsKeyPerInstanceUnlessGivenOne() async {
        let instance = ScreenInstance()
        let other = ScreenInstance()
        let screens = await recorded { tracker in
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: instance)
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: other)
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: instance)
            tracker.swiftUIScreenAppeared(
                name: "Profile", key: "user-7", instance: ScreenInstance())
        }
        #expect(screens.map(\.1) == ["Home-1", "Home-2", "Home-1", "user-7"])
    }

    @Test func nothingIsReportedOnceTrackingStopsOrWithTheHookOff() async {
        let screens = await recorded { tracker in
            tracker.tracking = false
            tracker.viewControllerAppeared(CheckoutViewController())
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: ScreenInstance())
        }
        #expect(screens.isEmpty)
        let hookOff = await recorded { tracker in
            tracker.tracksViewControllers = false
            tracker.viewControllerAppeared(CheckoutViewController())
        }
        #expect(hookOff.isEmpty)
    }

    @Test func aDismissedSheetMakesItsPresenterCurrentAgain() async {
        // A page sheet's presenter stays in its window and never appears again. The sheet is a
        // navigation controller, its dismissal under way: the screen inside it isn't the one
        // being dismissed.
        let presenter = CheckoutViewController()
        let window = aWindow(presenter)
        let sheet = SheetViewController()
        let navigation = DismissedNavigationController(rootViewController: sheet)
        presenter.present(navigation, animated: false)
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(presenter)
            tracker.viewControllerAppeared(sheet)
            tracker.viewControllerDisappeared(sheet)
        }
        #expect(
            screens.map(\.1) == [
                "CheckoutViewController-1", "SheetViewController-1", "CheckoutViewController-1",
            ])
        #expect(sheet.parent === navigation)
        window.isHidden = true
    }

    @Test func aPushInASheetToAControllerThatIsntAScreenKeepsTheSheetsScreenCurrent() async {
        // The sheet pushes SwiftUI content or one of Apple's controllers, which never report.
        let presenter = CheckoutViewController()
        let window = aWindow(presenter)
        let sheet = SheetViewController()
        presenter.present(UINavigationController(rootViewController: sheet), animated: false)
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(presenter)
            tracker.viewControllerAppeared(sheet)
            tracker.viewControllerDisappeared(sheet)
        }
        #expect(screens.map(\.0) == ["CheckoutViewController", "SheetViewController"])
        window.isHidden = true
    }

    @Test func aScreenGivingWayToANonScreenWithNothingDismissedLeavesTheOneBesideItHidden() async {
        // An iPad split view whose detail column pushes a controller that isn't a screen: the
        // primary column's screen is still in the window, and presents nothing.
        let primary = CheckoutViewController()
        let window = aWindow(primary)
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(primary)
            let detail = PushedViewController()
            tracker.viewControllerAppeared(detail)
            tracker.viewControllerDisappeared(detail)
        }
        #expect(screens.map(\.0) == ["CheckoutViewController", "PushedViewController"])
        window.isHidden = true
    }

    @Test func aScreenUnderASheetThatIsntOneStaysHiddenWhenTheSheetsOwnSheetIsDismissed() async {
        // The presenter's sheet, SwiftUI content no screen names, presented a screen of its own:
        // dismissing that leaves the user on the sheet.
        let presenter = CheckoutViewController()
        let window = aWindow(presenter)
        presenter.present(UIHostingController(rootView: Text("Filters")), animated: false)
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(presenter)
            let top = SheetViewController()
            tracker.viewControllerAppeared(top)
            top.dismissing = true
            tracker.viewControllerDisappeared(top)
        }
        #expect(screens.map(\.0) == ["CheckoutViewController", "SheetViewController"])
        window.isHidden = true
    }

    @Test func aScreenReportedInTheTurnItsPredecessorLeftKeepsThePresenterHidden() async {
        let screens = await recorded { tracker in
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: ScreenInstance())
            let sheet = ScreenInstance()
            tracker.swiftUIScreenAppeared(name: "Sheet", key: nil, instance: sheet)
            tracker.swiftUIScreenDisappeared(sheet)
            tracker.swiftUIScreenAppeared(name: "Pushed", key: nil, instance: ScreenInstance())
        }
        #expect(screens.map(\.0) == ["Home", "Sheet", "Pushed"])
    }

    @Test func aScreenNoLongerInAWindowIsNotCurrentAgain() async {
        let gone = CheckoutViewController()
        let screens = await recorded { tracker in
            tracker.viewControllerAppeared(gone)
            let sheet = ScreenInstance()
            tracker.swiftUIScreenAppeared(name: "Sheet", key: nil, instance: sheet)
            tracker.swiftUIScreenDisappeared(sheet)
        }
        #expect(screens.map(\.0) == ["CheckoutViewController", "Sheet"])
    }

    @Test func aPushInASwiftUISheetToAViewThatIsntAScreenKeepsTheSheetsScreenCurrent() async {
        // Home presents a sheet whose NavigationStack pushes an unmarked view: Settings goes away
        // and nothing appears in its place.
        let home = ScreenInstance()
        let host = UIHostingController(
            rootView: Color.clear.background(ScreenMarker(instance: home)))
        let window = aWindow(host)
        host.view.layoutIfNeeded()
        // SwiftUI makes the marker's view on a later turn.
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(home.controller === host)
        host.present(UIHostingController(rootView: Text("Settings")), animated: false)
        let screens = await recorded { tracker in
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: home)
            let settings = ScreenInstance()
            tracker.swiftUIScreenAppeared(name: "Settings", key: nil, instance: settings)
            tracker.swiftUIScreenDisappeared(settings)
        }
        #expect(screens.map(\.1) == ["Home-1", "Settings-1"])
        window.isHidden = true
    }

    @Test func aDismissedSwiftUISheetMakesTheScreenUnderItCurrentAgain() async {
        let home = ScreenInstance()
        let sheet = ScreenInstance()
        let screens = await recorded { tracker in
            tracker.swiftUIScreenAppeared(name: "Home", key: nil, instance: home)
            tracker.swiftUIScreenAppeared(name: "Sheet", key: nil, instance: sheet)
            tracker.swiftUIScreenDisappeared(sheet)
        }
        #expect(screens.map(\.1) == ["Home-1", "Sheet-1", "Home-1"])
    }

    @Test func theAppearanceMethodsAreTheOnesTheTrackerExpects() throws {
        for selector in [
            #selector(UIViewController.viewDidAppear(_:)),
            #selector(UIViewController.viewDidDisappear(_:)),
        ] {
            #expect(Swizzle.method(UIViewController.self, selector, signature: "v@:B") != nil)
        }
    }
}
