import UIKit

/// The screen pushed from Taps, in UIKit: a plain `UIViewController` on a navigation stack, the
/// case the SDK's view-controller hook names screens from.
final class DetailViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Detail"
        view.backgroundColor = .systemBackground

        let heading = UILabel()
        heading.text = "Detail"
        heading.font = .systemFont(ofSize: 22, weight: .medium)

        let hint = UILabel()
        hint.text =
            "Navigating here should emit a `navigation` event and stamp the `screen` block "
            + "(name \"Detail\" plus a per-instance key) on it and on every later event."
        hint.font = .systemFont(ofSize: 14)
        hint.textColor = .secondaryLabel
        hint.numberOfLines = 0

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Back"
        let back = UIButton(
            configuration: configuration,
            primaryAction: UIAction { [weak self] _ in
                self?.navigationController?.popViewController(animated: true)
            })
        back.accessibilityIdentifier = "detail-back"

        let card = UIStackView(arrangedSubviews: [back])
        card.axis = .vertical
        card.isLayoutMarginsRelativeArrangement = true
        card.directionalLayoutMargins = .init(top: 14, leading: 14, bottom: 14, trailing: 14)
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 12

        let page = UIStackView(arrangedSubviews: [heading, hint, card])
        page.axis = .vertical
        page.spacing = 12
        page.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(page)
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            page.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            page.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
        ])
    }
}
