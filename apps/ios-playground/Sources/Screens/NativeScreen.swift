import GroundcoverRum
import SwiftUI
import UIKit

/// How long "Block main thread" blocks for, in seconds. The hang specs assert against it.
let hangStall: TimeInterval = 3

/// Drives the native signals from the UI, and holds the list the gesture specs drag. Crash and
/// hang come from the SDK's development-only hooks (GroundcoverRumTesting).
struct NativeScreen: View {
    let openModal: () -> Void

    @State private var note = ""

    var body: some View {
        // This screen owns a list, so the page itself does not scroll.
        PageBody(scroll: false) {
            PageTitle("Native signals")
            PageHint(
                "Crashes, hangs, app start and frame vitals come from the native engine. A crash "
                    + "is reported on the NEXT launch, under the session it happened in.")
            Card {
                PlaygroundButton(
                    label: "Crash natively", testId: "native-crash",
                    accessibilityLabel: "Crash natively"
                ) {
                    note = "crash: triggered"
                    GroundcoverRumTesting.triggerTestCrash()
                }
                PlaygroundButton(
                    label: "Block main thread", testId: "native-hang",
                    accessibilityLabel: "Block main thread"
                ) {
                    note = "hang: triggered"
                    // After the frame that shows the note, so the stall doesn't hide it.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        GroundcoverRumTesting.blockMainThread(for: hangStall)
                    }
                }
                Text(note)
            }
            PageHint(
                "Scroll this list to exercise gesture capture, or open the modal, a UIKit "
                    + "screen presented over this one.")
            PlaygroundButton(
                label: "Open modal", accessibilityLabel: "Open modal", action: openModal)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(1...60, id: \.self) { row in
                        Text("Row \(row)")
                            .font(.system(size: 16))
                            .padding(.vertical, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .frame(height: 220)
            .accessibilityLabel(Text("Scrollable list"))
            .accessibilityIdentifier("native-scroll-list")
        }
        .groundcoverScreen("Native")
    }
}

/// The modal: a separate UIKit screen presented over the tabs, with a list of its own. The
/// counterpart of RN's Modal, which on iOS is a presented view controller too.
final class ModalViewController: UIViewController, UITableViewDataSource {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let heading = UILabel()
        heading.text = "Modal list"
        heading.font = .systemFont(ofSize: 22, weight: .medium)

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Close modal"
        let close = UIButton(
            configuration: configuration,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        close.accessibilityLabel = "Close modal"

        let list = UITableView()
        list.dataSource = self
        list.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        list.accessibilityLabel = "Modal scrollable list"
        list.accessibilityIdentifier = "modal-scroll-list"

        let page = UIStackView(arrangedSubviews: [heading, close, list])
        page.axis = .vertical
        page.spacing = 12
        page.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(page)
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            list.heightAnchor.constraint(equalToConstant: 220),
        ])
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 60 }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = "Modal row \(indexPath.row + 1)"
        cell.contentConfiguration = content
        cell.selectionStyle = .none
        return cell
    }
}
