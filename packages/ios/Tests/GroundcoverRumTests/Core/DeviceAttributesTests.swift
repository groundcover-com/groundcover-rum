import Foundation
import Testing

@testable import GroundcoverRum

// The session envelope's device part, in the React Native SDK's shape, plus `sdk`, which tells
// native sessions from RN and Flutter ones under the shared `source`.

@Suite struct DeviceAttributesTests {
    @Test func theScreenIsReadAgainForTheNextBatch() {
        // A rotation or a Dynamic Type change between two batches.
        final class Screen: @unchecked Sendable { var width = 390.0 }
        let screen = Screen()
        let device = DeviceAttributes(
            appId: "a", appVersion: nil, appBuild: nil,
            readScreen: {
                ["width": screen.width, "height": 844.0, "scale": 3.0, "fontScale": 1.0]
            },
            onMain: { $0() })
        func width() -> Double? {
            let hardware = device.attributes()["device"] as? [String: Any]
            return (hardware?["screen"] as? [String: Any])?["width"] as? Double
        }
        device.refreshScreen()
        #expect(width() == 390)
        screen.width = 844
        _ = width()
        #expect(width() == 844)
    }

    @Test func theEnvelopeCarriesSourceOsDeviceAppAndSdk() async {
        let device = DeviceAttributes(appId: "my-ios-app", appVersion: nil, appBuild: nil)
        await MainActor.run { device.refreshScreen() }
        let attributes = device.attributes()
        #expect(attributes["source"] as? String == "mobile-rum")
        let os = attributes["os"] as? [String: Any]
        #expect(os?["name"] as? String == "ios")
        #expect((os?["version"] as? String)?.isEmpty == false)
        let hardware = attributes["device"] as? [String: Any]
        #expect(hardware?["brand"] as? String == "Apple")
        #expect((hardware?["model"] as? String)?.isEmpty == false)
        let screen = hardware?["screen"] as? [String: Any]
        #expect((screen?["width"] as? Double ?? 0) > 0)
        #expect((screen?["scale"] as? Double ?? 0) >= 1)
        #expect((screen?["fontScale"] as? Double ?? 0) > 0)
        #expect((attributes["app"] as? [String: Any])?["id"] as? String == "my-ios-app")
        let sdk = attributes["sdk"] as? [String: Any]
        #expect(sdk?["name"] as? String == "groundcover-rum-ios")
        #expect(sdk?["version"] as? String == sdkVersion)
    }

    @Test func theConfiguredAppVersionAndBuildWinOverTheBundlesAndBlankOnesAreLeftOut() {
        let info: [String: Any] = ["CFBundleShortVersionString": "1.2", "CFBundleVersion": "34"]
        let configured = DeviceAttributes(
            appId: "a", appVersion: "9.9", appBuild: " ", infoDictionary: info)
        let app = configured.attributes()["app"] as? [String: Any]
        #expect(app?["version"] as? String == "9.9")
        #expect(app?["build"] as? String == "34")

        let bare = DeviceAttributes(appId: "a", appVersion: nil, appBuild: nil, infoDictionary: [:])
        let bareApp = bare.attributes()["app"] as? [String: Any]
        #expect(bareApp?["version"] == nil)
        #expect(bareApp?["build"] == nil)
    }
}
