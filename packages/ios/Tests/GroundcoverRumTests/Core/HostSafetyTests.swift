import Foundation
import Testing

@testable import GroundcoverRum

// What the SDK costs or changes in the host app beyond its own work: the priority the app waits at
// while the SDK starts, and the process-wide hooks it leaves alone.

@Suite("Host safety")
struct HostSafetyTests {
    @Test("a wait on the core queue runs the work at the waiter's priority, not the queue's")
    func waitRunsAtUserInitiated() {
        let executor = QueueExecutor(label: "host-safety-test")
        var qos = QOS_CLASS_UNSPECIFIED
        executor.executeAndWait(timeout: 1) { qos = qos_class_self() }

        #expect(qos == QOS_CLASS_USER_INITIATED)
    }

    @Test("the crash reporter leaves the app's C++ throws alone")
    func crashReporterKeepsCxaThrow() {
        #expect(GCRumCrashReporter.configuration().enableSwapCxaThrow == false)
    }
}
