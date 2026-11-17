import Foundation
import Testing

@testable import GroundcoverRum

// The runtime behind the public API: start, the calls it drops, the core queue every call hops to,
// and the session id an app reads from any thread.

private func aRuntimeConfig(
    appId: String = "a",
    options: GroundcoverOptions = GroundcoverOptions(
        transport: TransportOptions(batchSize: 0, compression: false))
) -> GroundcoverConfig {
    GroundcoverConfig(
        apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e", appId: appId,
        options: options)
}

private final class Lines: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String] = []
    func append(_ line: String) {
        lock.lock()
        stored.append(line)
        lock.unlock()
    }
    var all: [String] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// A value one thread sends and another waits for.
private final class Signal<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private var stored: Value?

    func send(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
        ready.signal()
    }

    /// The value once it is sent, or nil if it isn't within five seconds.
    func wait() -> Value? {
        guard ready.wait(timeout: .now() + 5) == .success else { return nil }
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// A sender on a real queue, telling whether a request was handed over on the main thread.
private final class ThreadRecordingSender: BatchSender, @unchecked Sendable {
    let sentOnMain = Signal<Bool>()

    func send(endpoint: String, request: BatchRequest, completion: @escaping (SendOutcome) -> Void)
    {
        sentOnMain.send(Thread.isMainThread)
        completion(.delivered)
    }
}

/// A storage whose first read takes a moment, as a cold UserDefaults suite can. Read only on the
/// core queue.
private final class SlowFirstReadStorage: PlatformStorage {
    private let inner = MapStorage()
    private var slept = false

    func getItem(_ key: String) throws -> String? {
        if !slept {
            slept = true
            Thread.sleep(forTimeInterval: 0.1)
        }
        return try inner.getItem(key)
    }

    func setItem(_ key: String, _ value: String) throws { try inner.setItem(key, value) }

    func removeItem(_ key: String) throws { try inner.removeItem(key) }
}

@Suite struct RumRuntimeTests {
    @Test func callsBeforeStartAreDroppedAndSaySoInDebug() {
        let lines = Lines()
        let diagnostics = RumDiagnostics(sink: { lines.append($0) })
        diagnostics.configure(debug: true)
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in platform.services }, diagnostics: diagnostics)
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(runtime.sessionId == "")
        #expect(
            lines.all.contains { $0.contains("sendCustomEvent") && $0.contains("hasn't started") })
    }

    @Test func startRejectsABlankAppIdAndStaysStopped() {
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in platform.services })
        #expect(throws: GroundcoverInitError.self) { try runtime.start(aRuntimeConfig(appId: " ")) }
        #expect(runtime.sessionId == "")
    }

    @Test func aSecondStartIsIgnored() throws {
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in platform.services })
        try runtime.start(aRuntimeConfig())
        let first = runtime.sessionId
        try runtime.start(aRuntimeConfig(appId: "other"))
        #expect(runtime.sessionId == first)
        #expect(first.count == 32)
    }

    @Test func aCallFromInsideAHookIsDropped() throws {
        // Sent, it would run through the same hook again, without end.
        let platform = FakePlatform()
        final class Box: @unchecked Sendable { var runtime: RumRuntime? }
        let box = Box()
        let runtime = RumRuntime(makePlatform: { _ in platform.services })
        box.runtime = runtime
        try runtime.start(
            aRuntimeConfig(
                options: GroundcoverOptions(
                    enrichEvent: { event in
                        box.runtime?.dispatch("logger.info") {
                            $0.submit(.log(LogCapture(message: "from a hook", level: .info)))
                        }
                        return event
                    },
                    transport: TransportOptions(batchSize: 0, compression: false))))
        runtime.dispatch("presence") { $0.presence() }
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(platform.types == ["custom"])
    }

    @Test func workRunsOnTheCoreQueueNeverTheMainThread() throws {
        let sender = ThreadRecordingSender()
        let runtime = RumRuntime(makePlatform: { _ in
            PlatformServices(
                storage: MapStorage(), clock: systemClock, sender: sender,
                deviceAttributes: { [:] }, executor: QueueExecutor(label: "test.core"))
        })
        try runtime.start(aRuntimeConfig())
        runtime.dispatch("presence") { $0.presence() }
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(sender.sentOnMain.wait() == false)
        runtime.reset()
    }

    @Test func theSessionIdIsReadableFromInsideAHookWithoutWaitingOnTheQueue() throws {
        final class Box: @unchecked Sendable { var runtime: RumRuntime? }
        let seen = Signal<String>()
        let box = Box()
        let runtime = RumRuntime(makePlatform: { _ in
            PlatformServices(
                storage: MapStorage(), clock: systemClock, sender: ThreadRecordingSender(),
                deviceAttributes: { [:] }, executor: QueueExecutor(label: "test.core"))
        })
        box.runtime = runtime
        try runtime.start(
            aRuntimeConfig(
                options: GroundcoverOptions(
                    beforeSend: { _ in
                        seen.send(box.runtime?.sessionId ?? "")
                        return true
                    })))
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(seen.wait() == runtime.sessionId)
        runtime.reset()
    }

    @Test func setSessionIdCompletesOnceTheOldSessionIsHandedOver() throws {
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in platform.services })
        try runtime.start(
            aRuntimeConfig(
                options: GroundcoverOptions(
                    transport: TransportOptions(batchSize: 100, compression: false))))
        runtime.dispatch("presence") { $0.presence() }
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        final class Done: @unchecked Sendable { var value = false }
        let done = Done()
        runtime.setSessionId("fixed") { done.value = true }
        #expect(done.value)
        #expect(platform.requests.count == 1)
        #expect(runtime.sessionId == "fixed")
    }

    @Test func resetStopsTheSdkSoTheNextStartBeginsAfresh() throws {
        let platform = FakePlatform()
        let runtime = RumRuntime(makePlatform: { _ in platform.services })
        try runtime.start(aRuntimeConfig())
        runtime.reset()
        #expect(runtime.sessionId == "")
        runtime.dispatch("presence") { $0.presence() }
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(platform.requests.isEmpty)
        try runtime.start(aRuntimeConfig())
        #expect(runtime.sessionId.count == 32)
    }

    @Test func theSessionIdIsReadableAsSoonAsStartReturns() throws {
        // An app tags its crash reporter with it right after start.
        let runtime = RumRuntime(makePlatform: { _ in
            PlatformServices(
                storage: SlowFirstReadStorage(), clock: systemClock,
                sender: ThreadRecordingSender(), deviceAttributes: { [:] },
                executor: QueueExecutor(label: "test.core"))
        })
        try runtime.start(aRuntimeConfig())
        #expect(runtime.sessionId.count == 32)
        runtime.reset()
    }

    @Test func aResetFromInsideAHookReturns() throws {
        final class Box: @unchecked Sendable { var runtime: RumRuntime? }
        let box = Box()
        let returned = Signal<Bool>()
        let runtime = RumRuntime(makePlatform: { _ in
            PlatformServices(
                storage: MapStorage(), clock: systemClock, sender: ThreadRecordingSender(),
                deviceAttributes: { [:] }, executor: QueueExecutor(label: "test.core"))
        })
        box.runtime = runtime
        try runtime.start(
            aRuntimeConfig(
                options: GroundcoverOptions(
                    beforeSend: { _ in
                        box.runtime?.reset()
                        returned.send(true)
                        return true
                    },
                    transport: TransportOptions(batchSize: 0, compression: false))))
        runtime.dispatch("presence") { $0.presence() }
        runtime.dispatch("sendCustomEvent") {
            $0.submit(.custom(CustomEventCapture(name: "x", attributes: [:])))
        }
        #expect(returned.wait() == true)
        #expect(runtime.sessionId == "")
    }
}
