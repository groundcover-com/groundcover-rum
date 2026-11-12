import GroundcoverRum
import SwiftUI

/// Every request the network specs make. In e2e the DSN is the mock ingest on :9393, and the echo
/// sits on its sibling port :9394, because the SDK skips requests to its own ingest.
///
/// The "fetch" buttons keep RN's labels, since the shared specs tap them by text; here they go
/// through the SDK's explicit API, `groundcoverDataTask`, which reports the response body the
/// shared specs read. Every other button calls URLSession as an app does, with no SDK call, and is
/// recorded by the SDK's URLSession hook: the abort, the failure, and the three URLSession buttons,
/// which each hit their own path so the native-clients spec can tell which way of calling
/// URLSession produced an event.
struct NetworkScreen: View {
    @StateObject private var model = NetworkModel()

    var body: some View {
        PageBody {
            PageTitle("Network")
            PageHint(
                "Requests to the echo, which replays what it received: inspect it for the "
                    + "injected `traceparent`.")
            Card {
                PlaygroundButton(label: "fetch GET", testId: "net-fetch-get") {
                    model.fetchGet()
                }
                PlaygroundButton(label: "fetch POST", testId: "net-fetch-post") {
                    model.fetchPost()
                }
                PlaygroundButton(label: "abort in-flight", testId: "net-abort") {
                    model.abortInFlight()
                }
                PlaygroundButton(label: "large response", testId: "net-large-response") {
                    model.largeResponse()
                }
                PlaygroundButton(label: "failing request", testId: "net-fail") {
                    model.failingRequest()
                }
                PlaygroundButton(label: "sensitive request", testId: "net-sensitive") {
                    model.sensitiveRequest()
                }
                PlaygroundButton(label: "URLSession completion GET", testId: "net-completion") {
                    model.completionGet()
                }
                PlaygroundButton(label: "URLSession delegate GET", testId: "net-delegate") {
                    model.delegateGet()
                }
                PlaygroundButton(label: "URLSession async GET", testId: "net-async") {
                    model.asyncGet()
                }
                Text("Last: \(model.last)")
            }
        }
        .groundcoverScreen("Network")
    }
}

@MainActor
final class NetworkModel: ObservableObject {
    @Published var last = "—"

    private let echo = Env.echoUrl
    private lazy var delegateSession = URLSession(
        configuration: .default, delegate: EchoDelegate(model: self), delegateQueue: nil)

    func fetchGet() {
        send("fetch", URLRequest(url: URL(string: echo)!))
    }

    func fetchPost() {
        var request = URLRequest(url: URL(string: echo)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = Data(#"{"hello":"mobile"}"#.utf8)
        send("fetch-post", request)
    }

    /// Starts a request against the slow echo and cancels it before it can answer. A cancelled
    /// request must not be reported; the spec pairs it with one that lands, so silence can't pass
    /// on its own.
    func abortInFlight() {
        let task = sendPlain("abort", URLRequest(url: URL(string: "\(echo)/slow?ms=5000")!))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { task.cancel() }
    }

    /// Over 5 KB of JSON, past the SDK's response-body cap.
    func largeResponse() {
        send("large", URLRequest(url: URL(string: "\(echo)/large")!))
    }

    /// Loopback port 1 refuses at once: a fast, deterministic failure, captured as status 0.
    func failingRequest() {
        sendPlain("fail", URLRequest(url: URL(string: "http://127.0.0.1:1/unreachable")!))
    }

    /// A secret in each place the SDK redacts on its own (query, header, body) plus two values
    /// that must survive. Local mock only: a real DSN's fallback echo is public and echoes back.
    func sensitiveRequest() {
        guard Env.echoIsLocalMock else {
            last = "sensitive: skipped — local-mock only; the echo is public here"
            return
        }
        var request = URLRequest(
            url: URL(string: "\(echo)/sensitive?token=e2e-query-token&user=demo")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer e2e-bearer-secret", forHTTPHeaderField: "authorization")
        request.httpBody = Data(
            #"{"password":"e2e-body-password","email":"demo@example.com","order_id":"A-1"}"#
                .utf8)
        send("sensitive", request)
    }

    func completionGet() {
        sendPlain("completion", URLRequest(url: URL(string: "\(echo)/completion")!))
    }

    /// A session with a delegate of its own, which receives the response in pieces rather than in
    /// a completion handler.
    func delegateGet() {
        last = "delegate: …"
        delegateSession.dataTask(with: URL(string: "\(echo)/delegate")!).resume()
    }

    func asyncGet() {
        last = "async: …"
        Task {
            do {
                _ = try await URLSession.shared.data(from: URL(string: "\(echo)/async")!)
                last = "async: ok"
            } catch {
                last = "async: \(error.localizedDescription)"
            }
        }
    }

    /// Through the explicit API, which reports the response body.
    private func send(_ label: String, _ request: URLRequest) {
        last = "\(label): …"
        URLSession.shared.groundcoverDataTask(with: request) { _, _, error in
            Task { @MainActor in self.finished(label, error) }
        }.resume()
    }

    /// As an app calls URLSession, with no SDK call: the hook records it.
    @discardableResult
    private func sendPlain(_ label: String, _ request: URLRequest) -> URLSessionDataTask {
        last = "\(label): …"
        let task = URLSession.shared.dataTask(with: request) { _, _, error in
            Task { @MainActor in self.finished(label, error) }
        }
        task.resume()
        return task
    }

    fileprivate func finished(_ label: String, _ error: Error?) {
        last = error.map { "\(label): \($0.localizedDescription)" } ?? "\(label): ok"
    }
}

/// The session's own delegate, an app's, with nothing of the SDK's in it.
private final class EchoDelegate: NSObject, URLSessionDataDelegate {
    private weak var model: NetworkModel?

    init(model: NetworkModel) {
        self.model = model
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
    ) {
        Task { @MainActor [weak model] in model?.finished("delegate", error) }
    }
}
