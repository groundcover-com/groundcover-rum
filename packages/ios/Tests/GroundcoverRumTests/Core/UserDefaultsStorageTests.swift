import Foundation
import Testing

@testable import GroundcoverRum

// The core keeps session state where the testing hooks, and the Flutter SDK, keep it: the
// com.groundcover.rum suite, as decimal strings. In the hooks' serialized suite, since both write
// the one suite.

extension SharedStateTests.TestingHooksTests {
    @Test func theSessionStartTheHookWritesReadsBackThroughTheCoreAsExactNanoseconds() {
        let expected = Int64((Date().timeIntervalSince1970 - 3600) * 1000) * 1_000_000
        GroundcoverRumTesting.backdateSessionStart(by: 3600)

        let ns = SafeStorage(UserDefaultsStorage()).getIntegerItem("gcStartTime")
        #expect(abs(ns - expected) < 5_000_000_000)
        #expect(ns % 1_000_000 == 0)
    }

    @Test func whatTheCoreStoresTheForgetHookRemoves() throws {
        let storage = UserDefaultsStorage()
        try storage.setItem("gcId", "abc")
        #expect(try storage.getItem("gcId") == "abc")
        GroundcoverRumTesting.forgetSession()
        #expect(try storage.getItem("gcId") == nil)
    }
}
