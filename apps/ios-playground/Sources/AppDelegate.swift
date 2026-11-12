// groundcover RUM — the native iOS playground the shared Mobilewright suite (tests/e2e/mobile)
// drives: a screen-for-screen mirror of apps/rn-playground and apps/flutter-playground.
import GroundcoverRum
import GroundcoverRumSwiftLog
import Logging
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // The preset has to be known before start, since it is start-time config.
        let preset = resolvePreset(readPresetFile())
        do {
            try Groundcover.start(config(for: preset))
        } catch {
            fatalError("groundcover: \(error)")
        }
        // swift-log's messages go to the SDK: the Logs tab's platform log goes through it.
        LoggingSystem.bootstrap { GroundcoverLogHandler(label: $0) }

        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = RootViewController(preset: preset)
        window.makeKeyAndVisible()
        self.window = window
        // A marker for whoever watches the console, as the other playgrounds print one.
        print("native-playground: ready (preset: \(preset))")
        return true
    }
}
