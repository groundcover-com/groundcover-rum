import Foundation
import React

/// Thin adapter: JSON in, JSON out, engine in the middle. No capture logic lives
/// here — everything the bridge does is marshalling, so the engine stays usable
/// without React Native.
///
/// A classic RCTEventEmitter rather than a TurboModule: the new-architecture
/// interop layer (guaranteed by our react-native >= 0.74 peer, bridgeless included)
/// makes codegen pure overhead here.
@objc(GroundcoverRumModule)
final class GroundcoverRumModule: RCTEventEmitter, GCRumEngineDelegate {
    private let engine = GCRumEngine()

    /// Written by React (`startObserving` / `stopObserving`, on its module queue) and read on
    /// whichever thread emits, such as the engine's queue carrying a hang report. It can't be a
    /// plain `Bool`: an unsynchronized cross-thread read of one is undefined behaviour, not
    /// merely a stale answer.
    private let listenerLock = NSLock()
    private var _hasListeners = false

    private var hasListeners: Bool {
        get { listenerLock.lock(); defer { listenerLock.unlock() }; return _hasListeners }
        set { listenerLock.lock(); defer { listenerLock.unlock() }; _hasListeners = newValue }
    }

    override init() {
        super.init()
        engine.delegate = self
    }

    override static func requiresMainQueueSetup() -> Bool {
        return false
    }

    override func supportedEvents() -> [String] {
        return ["groundcover.rum"]
    }

    /// The hardware model, as a CONSTANT rather than a method.
    ///
    /// It has to be readable synchronously: `device.model` is stamped on every event by an
    /// attribute provider, including events built before `nativeInit` resolves, so anything
    /// promise-shaped would leave the first events of a session reporting `"unknown"` — which is
    /// the very value this exists to remove. Constants are populated when the module registers,
    /// which is before JavaScript asks.
    ///
    /// Safe to compute here despite `requiresMainQueueSetup() == false`: this is one `uname()` and
    /// one environment read, touching no UIKit.
    ///
    /// An `override`: although `constantsToExport` is an @optional requirement on the
    /// `RCTBridgeModule` PROTOCOL — and so absent from RCTEventEmitter.h — Swift imports
    /// `RCTEventEmitter`'s conformance as an `open func` on the class itself, so declaring it fresh
    /// does not compile.
    override func constantsToExport() -> [AnyHashable: Any]! {
        return ["deviceModel": GCRumDeviceInfo.hardwareModel()]
    }

    override func startObserving() {
        hasListeners = true
    }

    override func stopObserving() {
        hasListeners = false
    }

    /// Releases the engine when React tears this instance down. This module is
    /// constructed per React instance, RN rebuilds that instance on every reload and
    /// ReactHost reset, and nothing else calls `stop()` on that path — so without this
    /// each recreation strands objects that OUTLIVE the bridge and keep it alive: a
    /// `CADisplayLink` the run loop retains and that keeps ticking at 60-120Hz, gesture
    /// recognizers a `UIWindow` retains (and `attach`'s dedupe is per-instance, so it
    /// cannot see them), and the hang watchdog's `while true` loop.
    ///
    /// `stop()` is the whole teardown, unlike Android's `release()`: it nils every
    /// tracker and each invalidates its own link, recognizers and observers. KSCrash
    /// deliberately stays installed — a crash during teardown is still worth reporting.
    override func invalidate() {
        engine.stop()
        super.invalidate()
    }

    // MARK: - GCRumEngineDelegate

    func rumEngine(_ engine: GCRumEngine, didEmit kind: String, payload: [String: Any]) {
        guard hasListeners else { return }
        sendEvent(withName: "groundcover.rum", body: ["kind": kind, "payload": payload])
    }

    // MARK: - Bridge surface

    @objc(nativeInit:resolver:rejecter:)
    func nativeInit(
        _ configJson: String,
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        // Never rejects: a native failure must degrade to "no features armed",
        // not to an unhandled rejection inside the host app's startup path.
        do {
            let config = try GCRumEngineConfig.decode(from: configJson)
            resolve(engine.start(config: config).encodedJson())
        } catch {
            resolve(GCRumEngineStatus().encodedJson())
        }
    }

    @objc(updateSessionSnapshot:)
    func updateSessionSnapshot(_ snapshotJson: String?) {
        engine.updateSessionSnapshot(snapshotJson)
    }

    @objc(writePendingCrashReport:json:)
    func writePendingCrashReport(_ id: String, json: String) -> NSNumber {
        NSNumber(value: engine.writePendingCrashReport(id, json: json))
    }

    @objc(getPendingCrashReports:rejecter:)
    func getPendingCrashReports(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        resolve(engine.pendingCrashReportsJson())
    }

    @objc(clearPendingCrashReports:resolver:rejecter:)
    func clearPendingCrashReports(
        _ ids: [String],
        resolver resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        engine.clearPendingCrashReports(ids: ids)
        resolve(nil)
    }

    /// Closes the open frame segment and hands it to JavaScript, which stamps it
    /// with the screen being LEFT. Resolves `"null"` when there is nothing to
    /// report — the common case for a screen the app never drew a frame on.
    @objc(flushFrameSegment:rejecter:)
    func flushFrameSegment(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter _: @escaping RCTPromiseRejectBlock
    ) {
        // Never rejects (see nativeInit): a screen change must not fail because
        // vitals could not be read.
        engine.flushFrameSegmentJson { resolve($0) }
    }

    @objc(stop)
    func stop() {
        engine.stop()
    }

    /**
     Whether the HOST APP is a development build.

     Deliberately not `#if DEBUG`: that is a compilation condition of THIS POD,
     which CocoaPods does not necessarily define from the app's configuration —
     and a library's own build flavour says nothing about the app it ends up in
     anyway. Gated on it, both triggers below can compile to no-ops even in a
     debug app, and the e2e suite would ask for a crash and get nothing.

     A simulator is always a development environment; on a device, an App Store
     build is the one WITHOUT an embedded provisioning profile. Same reasoning
     as Android's `FLAG_DEBUGGABLE` check: ask the app at runtime, once.
     */
    private static let isDevelopmentBuild: Bool = {
        #if targetEnvironment(simulator)
        return true
        #else
        return Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil
        #endif
    }()

    /**
     Deliberately crashes the app, for driving the e2e suite.

     Gated rather than merely undocumented: a reachable "crash the app" method
     in a shipped build is a liability no amount of naming prevents.
     */
    @objc(triggerTestCrash:)
    func triggerTestCrash(_ kind: String) {
        guard Self.isDevelopmentBuild else { return }
        DispatchQueue.main.async {
            // A real signal, so KSCrash records it the way it would a genuine
            // crash — a Swift fatalError would take a different path.
            let pointer = UnsafeMutablePointer<Int>(bitPattern: 0x10)
            pointer?.pointee = 1
        }
    }

    /// Blocks the main thread so the hang watchdog fires. Development builds only.
    @objc(blockMainThread:)
    func blockMainThread(_ ms: Double) {
        guard Self.isDevelopmentBuild else { return }
        DispatchQueue.main.async {
            Thread.sleep(forTimeInterval: ms / 1000)
        }
    }
}
