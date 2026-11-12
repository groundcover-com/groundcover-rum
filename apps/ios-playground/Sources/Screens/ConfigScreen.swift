import GroundcoverRum
import SwiftUI

/// Everything the e2e suite needs that is neither a captured signal nor a gesture: which preset
/// the app booted with, the public API methods no other screen calls, and the hooks the session
/// specs drive.
struct ConfigScreen: View {
    let preset: String

    @State private var sessionId = "—"
    @State private var done = "—"

    private func mark(_ what: String) {
        done = "\(what): done"
    }

    var body: some View {
        PageBody {
            PageTitle("Config & lifecycle")
            // The preset spec gate: every preset spec waits for this line to read back the preset
            // it asked for. One string, so an exact getByText matches.
            Text("preset: \(preset)")
            // Status lines sit above every card, so a spec that scrolled to a control lower down
            // can still see them.
            Text("Session: \(sessionId)")
            Text("Last action: \(done)")
            PageHint(
                "The preset comes from e2e-preset.json in the app's Documents directory, written "
                    + "by the harness. Relaunch to boot with another.")
            Card {
                // Carries the marker the `callbacks` preset's beforeSend drops on. The unmarked
                // survivor beside it is what makes the drop mean something: "no event arrived" is
                // also what a dead SDK sends.
                PlaygroundButton(
                    label: "tap \(dropMarker) (beforeSend drops this)", testId: "config-dropme"
                ) { mark("dropme") }
                PlaygroundButton(
                    label: "tap survivor (beforeSend keeps this)", testId: "config-survivor"
                ) { mark("survivor") }
            }
            PageTitle("Public API")
            PageHint(
                "Methods no other screen calls: clearing the identity, reading and setting the "
                    + "session id, manual navigation, the manual TTI mark, and turning navigation "
                    + "tracking off.")
            Card {
                PlaygroundButton(label: "show session id", testId: "config-show-session") {
                    let id = Groundcover.sessionId
                    sessionId = id.isEmpty ? "(not ready)" : id
                }
                // A recognisable id, so a spec can tell the SDK adopted this one rather than
                // rotating to any new value.
                PlaygroundButton(label: "setSessionId fixed", testId: "config-set-session") {
                    Task {
                        await Groundcover.setSessionId("e2e-fixed-session-id")
                        mark("setSessionId")
                    }
                }
                PlaygroundButton(label: "clear identity", testId: "config-clear-user") {
                    Groundcover.updateConfig(GroundcoverConfigUpdate(user: .clear))
                    mark("clearIdentity")
                }
                // The screen name is required: a navigation without one is dropped.
                PlaygroundButton(label: "manual navigation", testId: "config-manual-nav") {
                    Groundcover.startNavigation("ManualScreen", key: "manual-1")
                    Groundcover.endNavigation(["e2e_manual": "end"])
                    mark("manualNav")
                }
                PlaygroundButton(
                    label: "manual navigation unnamed", testId: "config-manual-nav-unnamed"
                ) {
                    Groundcover.startNavigation("", metadata: ["e2e_manual": "nameless"])
                    Groundcover.endNavigation(["e2e_manual": "nameless"])
                    mark("manualNavUnnamed")
                }
                PlaygroundButton(label: "markAppInteractive", testId: "config-mark-interactive") {
                    Groundcover.markAppInteractive()
                    mark("markInteractive")
                }
                PlaygroundButton(
                    label: "stopNavigationTracking", testId: "config-stop-nav-tracking"
                ) {
                    Groundcover.stopNavigationTracking()
                    mark("stopNavTracking")
                }
            }
            PageTitle("Session anchors (DEBUG)")
            PageHint(
                "The SDK reads the persisted session at launch, so changing it and relaunching is "
                    + "the on-device stand-in for a mocked clock. Relaunch after tapping.")
            Card {
                PlaygroundButton(label: "backdate activity 31m", testId: "config-backdate-activity")
                {
                    GroundcoverRumTesting.backdateLastActivity(by: 31 * 60)
                    mark("backdateActivity")
                }
                PlaygroundButton(
                    label: "backdate session start 5h", testId: "config-backdate-start"
                ) {
                    GroundcoverRumTesting.backdateSessionStart(by: 5 * 60 * 60)
                    mark("backdateStart")
                }
                // The next launch starts a session no user has touched yet, the only way to reach
                // the ghost-session gate on a device.
                PlaygroundButton(label: "forget session", testId: "config-forget-session") {
                    GroundcoverRumTesting.forgetSession()
                    mark("forgetSession")
                }
            }
        }
        .groundcoverScreen("Config")
    }
}
