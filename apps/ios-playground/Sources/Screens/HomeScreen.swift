import GroundcoverRum
import SwiftUI

/// The Taps tab, in SwiftUI. Its Detail screen is UIKit (DetailViewController).
struct HomeScreen: View {
    let openDetail: () -> Void

    @State private var count = 0
    @State private var search = ""

    var body: some View {
        PageBody {
            PageTitle("Taps")
            PageHint(
                "Each tap emits an `interaction` event. Compare the labels: a well-tagged button "
                    + "vs. a bare one shows how much comes from accessibility hygiene.")
            Card {
                PlaygroundButton(
                    label: "Well-tagged button (tapped \(count))",
                    testId: "home-counter-button",
                    accessibilityLabel: "Increment counter",
                    hint: "Adds one to the counter"
                ) { count += 1 }
                PlaygroundButton(label: "Bare button (no testID/label)") { count += 1 }
                PlaygroundButton(
                    label: "Private action (masked)",
                    testId: "home-private-button",
                    accessibilityLabel: "Private action"
                ) { count += 1 }
                .groundcoverPrivate()
                PlaygroundButton(
                    label: "Go to Detail screen", testId: "home-to-detail", action: openDetail)
                // Selected and a value, the SwiftUI counterparts of RN's accessibilityState and
                // accessibilityValue (SwiftUI has no expanded state). No label that replaces the
                // text: it has to stay findable by its text.
                PlaygroundButton(label: "A11y annotated button", testId: "home-a11y-button") {
                    count += 1
                }
                .accessibilityAddTraits(.isSelected)
                .accessibilityValue(Text("forty two percent"))
            }
            PageTitle("Typing")
            PageHint(
                "Editing a field emits ONE `input` interaction when you finish (return or tapping "
                    + "away), labelled from its label, never the text you typed.")
            Card {
                TextField("Type here, then tap away…", text: $search)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(Text("Search field"))
                    .accessibilityIdentifier("home-text-input")
            }
        }
        .groundcoverScreen("Home")
    }
}
