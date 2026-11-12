import SwiftUI
import UIKit

/// The six tabs, by label, and the screen each one opens.
enum Tab: String, CaseIterable {
    case taps = "Taps"
    case network = "Network"
    case logs = "Logs"
    case custom = "Custom"
    case native = "Native"
    case config = "Config"

    var icon: String {
        switch self {
        case .taps: return "hand.tap"
        case .network: return "globe"
        case .logs: return "text.alignleft"
        case .custom: return "star"
        case .native: return "cpu"
        case .config: return "gearshape"
        }
    }
}

/// The playground's shell: the selected tab's screen above a tab bar of the app's own.
///
/// UIKit, so the screens the specs need from UIKit have a place: the Taps tab is a navigation
/// controller whose Detail is a pushed `UIViewController`, and the modal is a presented one. The
/// tabs' own screens are SwiftUI, each named with `groundcoverScreen`. A tab switch replaces the
/// screen, so it is a navigation, as React Navigation's tab switches are in RN.
final class RootViewController: UIViewController {
    private let preset: String
    private let content = UIView()
    private var tabBarHost: UIHostingController<TabBar>!
    private var selected: Tab?
    private var current: UIViewController?

    init(preset: String) {
        self.preset = preset
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        tabBarHost = UIHostingController(rootView: tabBar(selected: .taps))
        addChild(tabBarHost)
        view.addSubview(content)
        view.addSubview(tabBarHost.view)
        tabBarHost.didMove(toParent: self)

        content.translatesAutoresizingMaskIntoConstraints = false
        tabBarHost.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: view.topAnchor),
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: tabBarHost.view.topAnchor),
            tabBarHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBarHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBarHost.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        select(.taps)
    }

    private func tabBar(selected: Tab) -> TabBar {
        TabBar(selected: selected) { [weak self] in self?.select($0) }
    }

    private func select(_ tab: Tab) {
        if tab == selected {
            // Taps from Detail goes back to Home, as RN's and Flutter's tab bars do.
            (current as? UINavigationController)?.popToRootViewController(animated: false)
            return
        }
        if let current {
            current.willMove(toParent: nil)
            current.view.removeFromSuperview()
            current.removeFromParent()
        }
        let next = screen(for: tab)
        addChild(next)
        next.view.frame = content.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        content.addSubview(next.view)
        next.didMove(toParent: self)
        current = next
        selected = tab
        tabBarHost.rootView = tabBar(selected: tab)
    }

    private func screen(for tab: Tab) -> UIViewController {
        switch tab {
        case .taps:
            // Detail is pushed on Home, like RN's stack inside the Taps tab.
            let navigation = UINavigationController()
            navigation.setNavigationBarHidden(true, animated: false)
            let home = HomeScreen { [weak navigation] in
                navigation?.pushViewController(DetailViewController(), animated: true)
            }
            navigation.viewControllers = [UIHostingController(rootView: home)]
            return navigation
        case .network:
            return UIHostingController(rootView: NetworkScreen())
        case .logs:
            return UIHostingController(rootView: LogsScreen())
        case .custom:
            return UIHostingController(rootView: CustomScreen())
        case .native:
            let native = NativeScreen { [weak self] in
                let modal = ModalViewController()
                modal.modalPresentationStyle = .fullScreen
                self?.present(modal, animated: true)
            }
            return UIHostingController(rootView: native)
        case .config:
            return UIHostingController(rootView: ConfigScreen(preset: preset))
        }
    }
}

/// The tab bar. Each tab is one accessibility element labelled `<Name> tab`, with the visible
/// text folded into it: specs, and `tapScrolling`'s tab-bar measurement, locate tabs by that
/// exact label. A tap gesture rather than a Button, which would add an element of its own inside
/// the combined one. The harness still sees the tab's text as a child element, after the screen's
/// own content, so a spec's `getByText("Logs")` finds the Logs title first.
struct TabBar: View {
    let selected: Tab
    let onSelect: (Tab) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { tab in
                VStack(spacing: 4) {
                    Image(systemName: tab.icon)
                    Text(tab.rawValue).font(.system(size: 12))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .foregroundColor(tab == selected ? .accentColor : .secondary)
                .contentShape(Rectangle())
                .onTapGesture { onSelect(tab) }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(tab.rawValue) tab")
                .accessibilityAddTraits(tab == selected ? [.isButton, .isSelected] : .isButton)
            }
        }
        .background(Color(.secondarySystemBackground).ignoresSafeArea(edges: .bottom))
    }
}
