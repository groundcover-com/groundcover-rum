import Foundation
import zlib

@testable import GroundcoverRum

/// Runs work inline, and scheduled work when the test moves the clock past it. One piece of work
/// at a time, as the real executor's serial queue: the URLSession tests reach the runtime from
/// URLSession's threads while the test flushes it from its own.
final class ManualExecutor: CoreExecutor {
    private struct Pending {
        let id: Int
        let dueMs: Int64
        let work: () -> Void
    }

    private final class Token: ScheduledWork {
        let cancelAction: () -> Void
        init(_ cancel: @escaping () -> Void) { cancelAction = cancel }
        func cancel() { cancelAction() }
    }

    var nowMs: Int64 = 0
    private var pending: [Pending] = []
    private var nextId = 0
    /// Recursive: work runs with it held, and schedules or runs more.
    private let lock = NSRecursiveLock()

    func execute(_ work: @escaping () -> Void) {
        lock.lock()
        defer { lock.unlock() }
        work()
    }

    func schedule(afterMs delay: Int64, _ work: @escaping () -> Void) -> ScheduledWork {
        lock.lock()
        defer { lock.unlock() }
        nextId += 1
        let id = nextId
        let (due, overflow) = nowMs.addingReportingOverflow(delay)
        pending.append(Pending(id: id, dueMs: overflow ? .max : due, work: work))
        return Token { [weak self] in self?.cancel(id) }
    }

    /// Work scheduled and not yet run or cancelled.
    var pendingCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return pending.count
    }

    private func cancel(_ id: Int) {
        lock.lock()
        defer { lock.unlock() }
        pending.removeAll { $0.id == id }
    }

    /// Moves the clock forward, running what falls due in order. Stops after 10,000 runs, so a
    /// timer that re-arms with no delay fails its test instead of hanging it.
    func advance(byMs delta: Int64) {
        lock.lock()
        defer { lock.unlock() }
        let target = nowMs + delta
        var runs = 0
        while runs < 10_000,
            let next = pending.filter({ $0.dueMs <= target }).min(by: { $0.dueMs < $1.dueMs })
        {
            runs += 1
            pending.removeAll { $0.id == next.id }
            nowMs = next.dueMs
            next.work()
        }
        nowMs = target
    }
}

/// One request the pipeline handed to the platform, its body decoded.
struct SentRequest {
    let url: String
    let headers: [String: String]
    let body: Data

    var batch: [String: Any] {
        let raw = headers["Content-Encoding"] == "gzip" ? gunzip(body) : body
        return (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
    }

    var sessionAttributes: [String: Any] { batch["sessionAttributes"] as? [String: Any] ?? [:] }

    var events: [[String: Any]] { batch["events"] as? [[String: Any]] ?? [] }
}

/// A sender that records every request instead of sending it.
final class RecordingSender: BatchSender {
    var requests: [SentRequest] = []
    var delivers = true

    /// Runs as a request is handed over, before it completes.
    var onSend: (() -> Void)?

    /// Holds every completion until ``releaseCompletions()``, as a slow network does.
    var holdsCompletions = false
    private var held: [() -> Void] = []

    func send(endpoint: String, request: BatchRequest, completion: @escaping (Bool) -> Void) {
        requests.append(SentRequest(url: endpoint, headers: request.headers, body: request.body))
        onSend?()
        let delivered = delivers
        if holdsCompletions {
            held.append { completion(delivered) }
        } else {
            completion(delivered)
        }
    }

    func releaseCompletions() {
        holdsCompletions = false
        while !held.isEmpty { held.removeFirst()() }
    }
}

/// A platform with a settable clock, storage in memory, inline work, and a sender that records.
final class FakePlatform {
    let storage = MapStorage()
    let sender = RecordingSender()
    let executor = ManualExecutor()
    var device: [String: Any] = ["source": "mobile-rum"]

    var nowMs: Int64 {
        get { executor.nowMs }
        set { executor.nowMs = newValue }
    }

    var requests: [SentRequest] { sender.requests }

    init(nowMs: Int64 = 1_800_000_000_000) {
        executor.nowMs = nowMs
    }

    var services: PlatformServices {
        PlatformServices(
            storage: storage, clock: { self.nowMs }, sender: sender,
            deviceAttributes: { self.device }, executor: executor)
    }

    /// Every event type sent, in order.
    var types: [String] { requests.flatMap { $0.events.compactMap { $0["type"] as? String } } }
}

/// The native engine, in memory: records what the pipeline asks of it, and starts at once unless
/// a test holds the start.
final class FakeNativeEngine: NativeEngine {
    var onSignal: ((String, [String: Any]) -> Void)?
    private(set) var calls: [String] = []
    private(set) var configJson: String?
    var status = NativeEngineStatus()

    /// Holds each start's completion until ``finishStart()``, as a slow disk does.
    var holdsStart = false
    private var heldStart: (() -> Void)?

    /// The last start's config, decoded.
    var config: [String: Any] { configJson.flatMap(decodeJsonObject) ?? [:] }
    var features: [String: Any] { config["features"] as? [String: Any] ?? [:] }

    func start(configJson: String, completion: @escaping (NativeEngineStatus) -> Void) {
        calls.append("start")
        self.configJson = configJson
        let status = status
        if holdsStart {
            heldStart = { completion(status) }
        } else {
            completion(status)
        }
    }

    func finishStart() {
        let held = heldStart
        heldStart = nil
        held?()
    }

    func stop() {
        calls.append("stop")
    }

    /// What the next ``flushFrameSegment(completion:)`` hands over.
    var openSegment: [String: Any]?

    func flushFrameSegment(completion: @escaping ([String: Any]?) -> Void) {
        calls.append("flushFrameSegment")
        let segment = openSegment
        openSegment = nil
        completion(segment)
    }

    /// Emits `kind` as the engine would, from inside or after its start.
    func emit(_ kind: String, _ payload: [String: Any]) {
        onSignal?(kind, payload)
    }
}

/// `data` inflated as gzip by zlib itself, to prove the SDK's own gzip is the real format.
func gunzip(_ data: Data) -> Data {
    var stream = z_stream()
    guard inflateInit2_(&stream, 31, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK
    else {
        return Data()
    }
    defer { inflateEnd(&stream) }
    var input = [UInt8](data)
    var out = Data()
    var buffer = [UInt8](repeating: 0, count: 16_384)
    return input.withUnsafeMutableBufferPointer { inputPointer -> Data in
        stream.next_in = inputPointer.baseAddress
        stream.avail_in = uInt(inputPointer.count)
        var status: Int32 = Z_OK
        repeat {
            buffer.withUnsafeMutableBufferPointer { bufferPointer in
                stream.next_out = bufferPointer.baseAddress
                stream.avail_out = uInt(bufferPointer.count)
                status = inflate(&stream, Z_NO_FLUSH)
                out.append(
                    bufferPointer.baseAddress!, count: bufferPointer.count - Int(stream.avail_out))
            }
        } while status == Z_OK
        return status == Z_STREAM_END ? out : Data()
    }
}
