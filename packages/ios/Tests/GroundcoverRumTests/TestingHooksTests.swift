import Foundation
import Testing

@testable import GroundcoverRum

// The session hooks write the persisted state the SDK reads at start, in its format: milliseconds
// for the last activity, nanoseconds for the start, both decimal strings.

extension SharedStateTests {
    @Suite struct TestingHooksTests {
        private let defaults = SessionStorage.defaults

        init() {
            for key in SessionStorage.sessionKeys {
                defaults.removeObject(forKey: key)
            }
        }

        @Test func backdatingActivityWritesItInMilliseconds() throws {
            let expected = (Date().timeIntervalSince1970 - 31 * 60) * 1000
            GroundcoverRumTesting.backdateLastActivity(by: 31 * 60)

            let stored = try #require(defaults.string(forKey: "gcLastActivity"))
            let ms = try #require(Double(stored))
            #expect(abs(ms - expected) < 5_000)
        }

        @Test func backdatingTheStartWritesItInNanoseconds() throws {
            let expected = (Date().timeIntervalSince1970 - 5 * 60 * 60) * 1e9
            GroundcoverRumTesting.backdateSessionStart(by: 5 * 60 * 60)

            let stored = try #require(defaults.string(forKey: "gcStartTime"))
            let ns = try #require(Double(stored))
            #expect(abs(ns - expected) < 5e12)
            #expect(stored.count == 19)
        }

        @Test func forgettingTheSessionRemovesEveryKey() {
            for key in SessionStorage.sessionKeys {
                defaults.set("x", forKey: key)
            }
            GroundcoverRumTesting.forgetSession()
            for key in ["gcId", "gcStartTime", "gcLastActivity", "gcSample"] {
                #expect(defaults.object(forKey: key) == nil)
            }
        }

        /// The crash and hang hooks' gate on a device: a development profile, never an Ad Hoc or
        /// Enterprise one.
        @Test(arguments: [(true, true), (false, false)])
        func aProfileIsDevelopmentByItsDebuggingEntitlement(allowed: Bool, development: Bool) {
            let plist = """
                <?xml version="1.0" encoding="UTF-8"?>
                <plist version="1.0"><dict><key>Entitlements</key><dict>\
                <key>get-task-allow</key><\(allowed ? "true" : "false")/></dict></dict></plist>
                """
            // The signed envelope around the property list, as bytes either side of it.
            let profile = Data([0x30, 0x80, 0x06, 0x09]) + Data(plist.utf8) + Data([0x00, 0xA0])
            #expect(GroundcoverRumTesting.isDevelopmentProfile(profile) == development)
        }

        @Test func aProfileWithoutTheEntitlementOrAPlistIsNotDevelopment() {
            let plist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>"
            #expect(!GroundcoverRumTesting.isDevelopmentProfile(Data(plist.utf8)))
            #expect(!GroundcoverRumTesting.isDevelopmentProfile(Data([0x30, 0x80, 0x00])))
        }

        @Test func theStateLivesInTheFlutterSuite() {
            GroundcoverRumTesting.backdateLastActivity(by: 0)
            #expect(
                UserDefaults(suiteName: "com.groundcover.rum")?.string(forKey: "gcLastActivity")
                    != nil)
        }
    }
}
