import Foundation
import Testing
@testable import GroundcoverRumEngine

/// Which of the two sources wins, and what "cannot tell" looks like.
///
/// The interesting case is a simulator, where `utsname.machine` is the HOST's architecture rather
/// than any device — so a version that read only `uname()` would report `"arm64"` for every
/// simulator and every Apple-silicon Mac, and that value looks real enough that nobody would
/// question it. Testing the decision separately from the two lookups is what makes that assertable
/// on whatever machine happens to run the suite.
@Suite("Device info")
struct GCRumDeviceInfoTests {
    @Test("prefers the simulated device's identifier over the host architecture")
    func simulatorIdentifierWins() {
        #expect(
            GCRumDeviceInfo.hardwareModel(simulatorIdentifier: "iPhone17,1", machine: "arm64")
                == "iPhone17,1"
        )
    }

    @Test("uses uname's machine on a real device, where there is no simulator identifier")
    func machineOnDevice() {
        #expect(
            GCRumDeviceInfo.hardwareModel(simulatorIdentifier: nil, machine: "iPhone17,1")
                == "iPhone17,1"
        )
    }

    /// An empty environment variable is present-but-useless, and `?? ""` alone would return it.
    @Test("ignores a blank simulator identifier rather than reporting it")
    func blankSimulatorIdentifier() {
        #expect(
            GCRumDeviceInfo.hardwareModel(simulatorIdentifier: "   ", machine: "iPhone17,1")
                == "iPhone17,1"
        )
    }

    /// Empty, NOT "unknown": that sentinel is the wire's and belongs to JavaScript, which already
    /// rejects a blank model. Returning it here too would mean two owners of one contract.
    @Test("reports empty when neither source has anything")
    func nothingKnown() {
        #expect(GCRumDeviceInfo.hardwareModel(simulatorIdentifier: nil, machine: "") == "")
        #expect(GCRumDeviceInfo.hardwareModel(simulatorIdentifier: "", machine: "  ") == "")
    }

    /// The one assertion that exercises the real syscall. Deliberately weak about the VALUE — it is
    /// whatever machine runs the suite — and strong about the shape, because a botched CChar-tuple
    /// rebind is the failure mode here and it produces garbage or a crash, not a wrong model.
    @Test("reads a plausible machine identifier from uname")
    func unameIsReadable() {
        let machine = GCRumDeviceInfo.unameMachine()
        #expect(!machine.isEmpty)
        #expect(machine == machine.trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(machine.allSatisfy { $0.isASCII && !$0.isNewline })
    }
}
