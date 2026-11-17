import Foundation

/// One batch POST, as the platform sends it.
struct BatchRequest {
    var headers: [String: String]
    var body: Data
}

/// How a batch POST ended.
enum SendOutcome: Equatable {
    /// The ingest answered 2xx.
    case delivered
    /// The ingest answered outside 2xx: it refused the batch.
    case rejected(status: Int)
    /// No answer: no network, a timeout, or an endpoint that is not a URL.
    case failed

    var isDelivered: Bool { self == .delivered }
}

/// The one network primitive the core needs; the platform owns how a batch reaches the wire.
protocol BatchSender: AnyObject {
    /// Sends `request`; `completion` says how it ended. Called from any thread.
    func send(endpoint: String, request: BatchRequest, completion: @escaping (SendOutcome) -> Void)
}

/// Statuses that mean the endpoint refuses this SDK's credentials. Every batch after one of these
/// is refused the same way, so the app records nothing until the apiKey or dsn is fixed: that
/// warrants a warning outside debug.
private let credentialRejections: Set<Int> = [401, 403]

/// A batch on its way out: the envelope plus the events, as the wire carries them.
struct Batch {
    var sessionAttributes: [String: Any]
    var events: [[String: Any]]
}

/// Builds each batch's request (JSON, gzip, headers) on the core queue and hands it to the sender.
/// Memory only and no retry: a batch that doesn't land is gone, as in the RN and Flutter SDKs.
final class Transporter {
    private let config: ConfigManager
    private let sender: BatchSender
    private let executor: CoreExecutor
    private let diagnostics: RumDiagnostics
    // Credential rejections already warned about: one warning per status is enough to act on, and
    // a batch goes out every few seconds. Completions arrive on the sender's queue, so it's locked.
    private let warnedLock = NSLock()
    private var warnedStatuses = Set<Int>()

    init(
        config: ConfigManager, sender: BatchSender, executor: CoreExecutor,
        diagnostics: RumDiagnostics = .shared
    ) {
        self.config = config
        self.sender = sender
        self.executor = executor
        self.diagnostics = diagnostics
    }

    /// Fire-and-forget, as a live batch must be.
    func send(_ batch: Batch) {
        guard let outgoing = request(for: batch) else {
            diagnostics.log("No API key found")
            return
        }
        sender.send(endpoint: outgoing.endpoint, request: outgoing.request) { outcome in
            if outcome == .failed { self.diagnostics.log("Network error while sending batch") }
            self.reportRejection(outcome, endpoint: outgoing.endpoint)
        }
    }

    /// Sends `batch` and reports, on the core queue, whether it was delivered: the crash drain
    /// deletes a record only once its batch landed. False without an API key, when nothing is sent.
    func deliver(_ batch: Batch, completion: @escaping (Bool) -> Void) {
        guard let outgoing = request(for: batch) else {
            completion(false)
            return
        }
        sender.send(endpoint: outgoing.endpoint, request: outgoing.request) { outcome in
            self.reportRejection(outcome, endpoint: outgoing.endpoint)
            self.executor.execute { completion(outcome.isDelivered) }
        }
    }

    /// A refused batch and its events are gone: logged in debug, and warned about even without
    /// debug when the endpoint refuses the credentials, since that silently drops every batch. As
    /// the browser SDK does.
    private func reportRejection(_ outcome: SendOutcome, endpoint: String) {
        guard case .rejected(let status) = outcome else { return }
        diagnostics.log("Batch rejected by \(endpoint) with HTTP \(status)")
        guard credentialRejections.contains(status) else { return }
        warnedLock.lock()
        let first = warnedStatuses.insert(status).inserted
        warnedLock.unlock()
        guard first else { return }
        diagnostics.warn(
            "[groundcover] \(endpoint) rejected a batch with HTTP \(status). Check the apiKey and "
                + "dsn passed to Groundcover.start(): no RUM data is recorded until they are "
                + "accepted.")
    }

    private func request(for batch: Batch) -> (endpoint: String, request: BatchRequest)? {
        let config = config.config
        guard !config.apiKey.isEmpty else { return nil }
        let json = encodeJson([
            "sessionAttributes": batch.sessionAttributes, "events": batch.events,
        ])
        if config.options.debug { diagnostics.log("Sending batch:", detail: json) }
        let bytes = Data(json.utf8)
        // A batch that can't be compressed still goes, uncompressed.
        let compressed =
            config.options.transport.compression ?? defaultCompression ? gzip(bytes) : nil
        return (
            "\(config.endpoint)/json/rum",
            BatchRequest(
                headers: [
                    "Content-Type": "application/json",
                    "apikey": config.apiKey,
                    "Content-Encoding": compressed == nil ? "" : "gzip",
                ],
                body: compressed ?? bytes)
        )
    }
}
