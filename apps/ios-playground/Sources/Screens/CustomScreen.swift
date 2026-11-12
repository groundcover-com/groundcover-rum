import GroundcoverRum
import SwiftUI

struct CustomScreen: View {
    @State private var sessionId = "—"

    var body: some View {
        PageBody {
            PageTitle("Custom & identity")
            PageHint(
                "Custom events and user identification. Then background the app: the SDK flushes "
                    + "buffered events and persists the activity clock.")
            Card {
                PlaygroundButton(label: "sendCustomEvent", testId: "custom-send") {
                    Groundcover.sendCustomEvent(
                        "checkout_completed", ["total": 42, "currency": "USD"])
                }
                PlaygroundButton(label: "identifyUser", testId: "custom-identify") {
                    Groundcover.identifyUser(
                        RumUser(id: "user-123", email: "demo@example.com", name: "Demo User"))
                }
                PlaygroundButton(label: "show session id", testId: "custom-session") {
                    let id = Groundcover.sessionId
                    sessionId = id.isEmpty ? "(not ready)" : id
                }
                Text("Session: \(sessionId)")
            }
        }
        .groundcoverScreen("Custom")
    }
}
