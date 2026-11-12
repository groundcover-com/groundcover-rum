import Foundation
import GroundcoverRum
import Logging
import SwiftUI

/// The playground's own error type: what the wire's `error_type` reads for its errors.
struct PlaygroundError: LocalizedError, CustomStringConvertible {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? { message }
    var description: String { message }
}

struct LogsScreen: View {
    /// The app's own swift-log logger. AppDelegate bootstraps swift-log with
    /// GroundcoverLogHandler, so what it logs is captured without the SDK's API.
    private let platformLogger = Logger(label: "playground")

    var body: some View {
        PageBody {
            PageTitle("Logs")
            PageHint(
                "The app's own swift-log logging and the explicit `Groundcover.logger` API both "
                    + "emit `log` events through the same redaction contract.")
            Card {
                PlaygroundButton(label: "platform log", testId: "logs-platform-log") {
                    platformLogger.info("playground platform log")
                }
                PlaygroundButton(label: "logger.info", testId: "logs-logger-info") {
                    Groundcover.logger.info("explicit logger.info", ["via": "api"])
                }
                PlaygroundButton(label: "logger.warn", testId: "logs-logger-warn") {
                    Groundcover.logger.warn("explicit logger.warn")
                }
            }
            PageTitle("Errors")
            PageHint(
                "A handled error reported with captureError, and an uncaught Objective-C "
                    + "exception, which in a native app is a crash, reported on the next launch.")
            Card {
                PlaygroundButton(label: "captureException", testId: "errors-capture") {
                    Groundcover.captureError(
                        PlaygroundError("handled e2e error"), metadata: ["screen": "Logs"])
                }
                PlaygroundButton(label: "throw uncaught", testId: "errors-uncaught") {
                    // Raised outside the button's action, as RN's setTimeout throw is.
                    DispatchQueue.main.async {
                        NSException(
                            name: NSExceptionName("PlaygroundError"),
                            reason: "uncaught e2e error"
                        ).raise()
                    }
                }
            }
            PageTitle("Privacy fixtures")
            PageHint(
                "Sensitive payloads for the privacy matrix. Deliberately last on the screen: a "
                    + "control inserted above shifts the ones the specs tap without scrolling. "
                    + "Append here; never insert above.")
            Card {
                // Secrets in both halves of a log event, the free-text message and the
                // attributes, which take different redaction paths.
                PlaygroundButton(label: "log sensitive", testId: "logs-sensitive") {
                    Groundcover.logger.info(
                        "user login password=e2e-log-password",
                        [
                            "api_key": "e2e-log-apikey",
                            "order_id": "A-1",
                            "email": "demo@example.com",
                        ])
                }
                PlaygroundButton(label: "capture sensitive error", testId: "errors-sensitive") {
                    Groundcover.captureError(
                        PlaygroundError("auth failed for token=e2e-error-token"),
                        metadata: ["password": "e2e-error-password", "order_id": "A-1"])
                }
            }
        }
        .groundcoverScreen("Logs")
    }
}
