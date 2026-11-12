import SwiftUI

// The playground's building blocks, the counterpart of apps/flutter-playground/lib/ui.dart.
//
// Locator rules for the tree the harness reads (keep them when adding controls):
//   - A label that replaces the visible text is `accessibilityLabel`, the counterpart of RN's
//     accessibilityLabel: the element then reads as the label alone.
//   - Test ids are `accessibilityIdentifier`, which getByTestId reads.
//   - getByText matches an element's whole label (or value) exactly, so a control's text is its
//     label unless it says otherwise.

/// A full-width button. `accessibilityLabel` replaces `label` for queries, like RN's
/// accessibilityLabel; `hint` is RN's accessibilityHint.
struct PlaygroundButton: View {
    let label: String
    var testId: String?
    var accessibilityLabel: String?
    var hint: String?
    let action: () -> Void

    var body: some View {
        SwiftUI.Button(action: action) {
            Text(label).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityLabel(Text(accessibilityLabel ?? label))
        .accessibilityHint(Text(hint ?? ""))
        .accessibilityIdentifier(testId ?? "")
    }
}

/// A scrolling page. Pass `scroll: false` when the screen has its own scrollable, so a drag has
/// exactly one scroller to claim it.
struct PageBody<Content: View>: View {
    var scroll = true
    @ViewBuilder let content: () -> Content

    var body: some View {
        let column = VStack(alignment: .leading, spacing: 12, content: content)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        if scroll {
            ScrollView { column }
        } else {
            column.frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

struct PageTitle: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).font(.system(size: 22, weight: .medium))
    }
}

struct PageHint: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).font(.system(size: 14)).foregroundColor(.secondary)
    }
}

struct Card<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10, content: content)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground))
            .cornerRadius(12)
    }
}
