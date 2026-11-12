import XCTest

// The shared Mobilewright suite (tests/e2e/mobile) finds controls by these strings, as the
// accessibility tree reports them, so a rename here breaks e2e on a device. This pins the contract
// without the harness. Each list is what the specs locate on that screen; add to it whenever a
// spec starts locating something new.
//
// Matched the way Mobilewright matches on iOS: getByText and getByLabel compare a string with an
// element's whole label (getByText also its value), getByTestId with its identifier.

/// Strings the specs locate on each tab's screen, by text or label.
private let byTab: [(tab: String, strings: [String])] = [
    (
        "Taps",
        [
            "Taps", "Increment counter", "Bare button (no testID/label)", "Private action",
            "Go to Detail screen", "A11y annotated button", "Search field",
        ]
    ),
    (
        "Network",
        [
            "Network", "fetch GET", "fetch POST", "abort in-flight", "large response",
            "failing request", "sensitive request", "URLSession completion GET",
            "URLSession delegate GET", "URLSession async GET",
        ]
    ),
    (
        "Logs",
        [
            "Logs", "platform log", "logger.info", "logger.warn", "captureException",
            "throw uncaught", "log sensitive", "capture sensitive error",
        ]
    ),
    ("Custom", ["sendCustomEvent", "identifyUser", "show session id"]),
    ("Native", ["Crash natively", "Block main thread", "Open modal", "Row 3"]),
    (
        "Config",
        [
            "preset: default", "Session: —", "Last action: —",
            "tap DROPME (beforeSend drops this)", "tap survivor (beforeSend keeps this)",
            "show session id", "setSessionId fixed", "clear identity", "manual navigation",
            "manual navigation unnamed", "markAppInteractive", "stopNavigationTracking",
            "backdate activity 31m", "backdate session start 5h", "forget session",
        ]
    ),
]

/// Test ids the specs locate.
private let testIds = ["home-text-input"]

final class LocatorContractTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launch()
    }

    private func element(_ string: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@ OR value == %@", string, string))
            .firstMatch
    }

    private func expectOnScreen(_ string: String, on screen: String) {
        XCTAssertTrue(
            element(string).waitForExistence(timeout: 5), "'\(string)' is not on \(screen)")
    }

    private func openTab(_ tab: String) {
        let button = element("\(tab) tab")
        XCTAssertTrue(button.waitForExistence(timeout: 10), "no '\(tab) tab'")
        button.tap()
    }

    func testEveryLocatedStringIsOnItsScreen() {
        for (tab, strings) in byTab {
            openTab(tab)
            for string in strings {
                expectOnScreen(string, on: tab)
            }
        }
    }

    func testTheTestIdsResolve() {
        openTab("Taps")
        for id in testIds {
            XCTAssertTrue(app.descendants(matching: .any)[id].waitForExistence(timeout: 5), id)
        }
    }

    func testDetailIsPushedAndPopped() {
        openTab("Taps")
        element("Go to Detail screen").tap()
        expectOnScreen("Detail", on: "Detail")
        element("Back").tap()
        expectOnScreen("Go to Detail screen", on: "Taps")
    }

    func testTheModalOpensAndCloses() {
        openTab("Native")
        element("Open modal").tap()
        expectOnScreen("Modal list", on: "the modal")
        expectOnScreen("Modal row 1", on: "the modal")
        element("Close modal").tap()
        expectOnScreen("Open modal", on: "Native")
    }
}
