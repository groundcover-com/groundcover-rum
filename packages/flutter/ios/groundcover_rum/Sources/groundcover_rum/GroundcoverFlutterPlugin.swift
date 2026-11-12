import Flutter
import UIKit

/// Registers the host API and the signal stream (RumApi.g.swift, generated from
/// pigeons/rum_api.dart) on every engine that loads the plugin.
public class GroundcoverFlutterPlugin: NSObject, FlutterPlugin {
  public static func register(with registrar: FlutterPluginRegistrar) {
    RumHostApiSetup.setUp(binaryMessenger: registrar.messenger(), api: RumHostApiImpl())
    SignalsStreamHandler.register(with: registrar.messenger(), streamHandler: RumSignals())
  }
}

/// The engine's signals (hang, app_start, ping) for Dart, through the host that owns them.
final class RumSignals: SignalsStreamHandler {
  override func onListen(withArguments arguments: Any?, sink: PigeonEventSink<NativeSignal>) {
    RumEngineHost.shared.listen(sink)
  }

  override func onCancel(withArguments arguments: Any?) {
    RumEngineHost.shared.cancel()
  }
}

/// The process's one native engine, shared by every Flutter engine that
/// loads the plugin, and the signals it emits on their way to Dart. One per process because the
/// engine's crash reporter and watchdog are: a second engine would install KSCrash twice.
///
/// The engine is built by the first start, on Pigeon's background queue: building it reads the
/// snapshot store from disk, which the main thread must not wait for, and Dart's listen reaches
/// this host on the main thread before the start does. Signals cross to Dart on the main thread
/// only, as Flutter requires of an event sink; the sink and the queue are touched there alone.
final class RumEngineHost: GCRumEngineDelegate {
  static let shared = RumEngineHost()

  private let lock = NSLock()
  private var built: GCRumEngine?
  private var sink: PigeonEventSink<NativeSignal>?
  private var pending: [NativeSignal] = []

  /// Signals emitted before Dart listens, kept up to this many. `app_start` and `ping` fire
  /// inside `start`, and Dart's listen reaches here asynchronously, on another channel, so call
  /// order alone can't promise a listener exists. RN's iOS module drops them instead.
  private static let pendingLimit = 64

  private init() {}

  /// The engine, built on first use: for the start, the one call that runs it.
  func engine() -> GCRumEngine {
    lock.lock()
    defer { lock.unlock() }
    if let built { return built }
    let engine = GCRumEngine()
    engine.delegate = self
    built = engine
    return engine
  }

  /// The engine once a start built it. What comes before one has nothing to act on.
  var startedEngine: GCRumEngine? {
    lock.lock()
    defer { lock.unlock() }
    return built
  }

  func rumEngine(_ engine: GCRumEngine, didEmit kind: String, payload: [String: Any]) {
    // A payload JSON can't carry (a non-finite number) is dropped, as Dart would drop it.
    guard JSONSerialization.isValidJSONObject(payload),
      let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    else { return }
    let signal = NativeSignal(kind: kind, payloadJson: json)
    DispatchQueue.main.async { self.deliver(signal) }
  }

  private func deliver(_ signal: NativeSignal) {
    if let sink {
      sink.success(signal)
      return
    }
    pending.append(signal)
    if pending.count > Self.pendingLimit { pending.removeFirst() }
  }

  /// Called on the main thread, as a stream handler is.
  func listen(_ sink: PigeonEventSink<NativeSignal>) {
    self.sink = sink
    let queued = pending
    pending.removeAll()
    queued.forEach { sink.success($0) }
  }

  func cancel() {
    sink = nil
  }
}

/// Storage, device info, and the native engine. Stateless apart from UserDefaults, which is
/// process-wide, so one instance per engine is safe with several engines in one app.
final class RumHostApiImpl: RumHostApi {
  /// A suite of its own, so the SDK's keys never mix with the app's defaults.
  private let defaults = UserDefaults(suiteName: "com.groundcover.rum") ?? .standard

  /// Every SDK key starts with this; a suite's dictionary also carries global-domain keys.
  private static let keyPrefix = "gc"

  func loadStorage() throws -> [String: String] {
    var out: [String: String] = [:]
    for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix(Self.keyPrefix) {
      if let string = value as? String { out[key] = string }
    }
    return out
  }

  func writeStorage(changes: [String: String?]) throws {
    for (key, value) in changes {
      if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
  }

  func deviceInfo() throws -> NativeDeviceInfo {
    let bundle = Bundle.main
    return NativeDeviceInfo(
      osVersion: UIDevice.current.systemVersion,
      model: Self.machineIdentifier(),
      brand: "Apple",
      codename: nil,
      appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      appBuild: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    )
  }

  // The native engine.

  /// Never throws: a native failure degrades to nothing armed, not to an error in the app's
  /// startup. Idempotent: a second start, as after a hot restart, returns the first's status.
  func startEngine(configJson: String) throws -> String {
    do {
      let config = try GCRumEngineConfig.decode(from: configJson)
      return RumEngineHost.shared.engine().start(config: config).encodedJson()
    } catch {
      return GCRumEngineStatus().encodedJson()
    }
  }

  func updateSessionSnapshot(json: String?) throws {
    RumEngineHost.shared.startedEngine?.updateSessionSnapshot(json)
  }

  func pendingCrashReports() throws -> String {
    RumEngineHost.shared.startedEngine?.pendingCrashReportsJson() ?? "[]"
  }

  func clearPendingCrashReports(ids: [String]) throws {
    RumEngineHost.shared.startedEngine?.clearPendingCrashReports(ids: ids)
  }

  func stopEngine() throws {
    RumEngineHost.shared.startedEngine?.stop()
  }

  /// Crashes the app, for testing crash capture. A real signal, so the crash reporter records it
  /// as it would a genuine crash; a Swift fatalError would take a different path.
  func triggerTestCrash(kind: String) throws {
    guard Self.isDevelopmentBuild else { return }
    DispatchQueue.main.async {
      let pointer = UnsafeMutablePointer<Int>(bitPattern: 0x10)
      pointer?.pointee = 1
    }
  }

  /// Blocks the main thread (where Dart runs too) so the hang watchdog fires.
  func blockMainThread(ms: Int64) throws {
    guard Self.isDevelopmentBuild else { return }
    // Bounded here too, whatever the caller sent: the Dart API caps it at 30 s.
    let bounded = min(max(ms, 0), 30_000)
    DispatchQueue.main.async {
      Thread.sleep(forTimeInterval: Double(bounded) / 1000)
    }
  }

  /// Whether the HOST APP is a development build, asked at runtime as RN's module does: a
  /// plugin's own `#if DEBUG` says nothing about the app it ends up in. A simulator is always
  /// one; on a device, an App Store build is the one without an embedded provisioning profile.
  /// Gated rather than merely undocumented: a reachable "crash the app" call in a shipped build
  /// is a liability no amount of naming prevents.
  private static let isDevelopmentBuild: Bool = {
    #if targetEnvironment(simulator)
      return true
    #else
      return Bundle.main.path(forResource: "embedded", ofType: "mobileprovision") != nil
    #endif
  }()

  /// `iPhone17,1`, never the marketing name. On a simulator `uname` reports the host's
  /// architecture (`arm64`), so the simulated device's identifier comes from its environment.
  private static func machineIdentifier() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
      !simulated.isEmpty
    {
      return simulated
    }
    var info = utsname()
    uname(&info)
    let machine = withUnsafePointer(to: &info.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
    }
    return machine.isEmpty ? "unknown" : machine
  }
}
