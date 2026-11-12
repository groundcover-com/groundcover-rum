import Foundation
import Testing
@testable import GroundcoverRumEngine

/// Teardown that actually tears down. `removeObserver(self)` in a `stop()` removes nothing when the
/// registrations came from the block-based API — the observer is an opaque token, not `self` — so
/// every start/stop cycle would leave handlers on the process-wide center. A private center
/// throughout, since asserting against `.default` would couple these tests to whatever else the
/// process registered.
@Suite("Notification observers")
struct GCRumNotificationObserversTests {

    @Test("handlers fire while registered")
    func firesWhileRegistered() {
        let center = NotificationCenter()
        let observers = GCRumNotificationObservers(center: center)
        let name = Notification.Name("gc.test.one")
        var calls = 0

        observers.observe(name) { calls += 1 }
        center.post(name: name, object: nil)

        #expect(calls == 1)
    }

    /// The case this type exists for. Without it the leak is invisible: `stop()`
    /// reads correct, compiles, and the handlers keep running.
    @Test("removeAll actually unregisters")
    func removeAllUnregisters() {
        let center = NotificationCenter()
        let observers = GCRumNotificationObservers(center: center)
        let name = Notification.Name("gc.test.two")
        var calls = 0

        observers.observe(name) { calls += 1 }
        observers.removeAll()
        center.post(name: name, object: nil)

        #expect(calls == 0)
    }

    /// A tracker can be stopped and started again; registrations must not stack up,
    /// or one notification runs the handler once per cycle ever performed.
    @Test("a stop and restart does not double-register")
    func restartDoesNotAccumulate() {
        let center = NotificationCenter()
        let observers = GCRumNotificationObservers(center: center)
        let name = Notification.Name("gc.test.three")
        var calls = 0

        for _ in 0..<3 {
            observers.observe(name) { calls += 1 }
            observers.removeAll()
        }
        observers.observe(name) { calls += 1 }
        center.post(name: name, object: nil)

        #expect(calls == 1)
    }

    @Test("removeAll is idempotent")
    func removeAllTwice() {
        let center = NotificationCenter()
        let observers = GCRumNotificationObservers(center: center)
        let name = Notification.Name("gc.test.four")
        var calls = 0

        observers.observe(name) { calls += 1 }
        observers.removeAll()
        observers.removeAll()
        center.post(name: name, object: nil)

        #expect(calls == 0)
    }
}
