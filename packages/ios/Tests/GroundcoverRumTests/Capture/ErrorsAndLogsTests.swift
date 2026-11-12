import Foundation
import GroundcoverRumObjC
import GroundcoverRumSwiftLog
import Logging
import Testing

@testable import GroundcoverRum

// Handled errors' frames from the call site, and platform logs through the swift-log handler.

@Suite struct CallStackTests {
    @Test func theCallersFramesComeFirst() throws {
        let frames = CallStack.frames(Thread.callStackReturnAddresses)
        let first = try #require(frames.first)
        #expect(!first.function.isEmpty)
        #expect(!first.function.contains("14GroundcoverRum"))
        #expect(frames.count <= CallStack.maxFrames)
        #expect(frames.allSatisfy { $0.lineno == 0 && $0.colno == 0 && !$0.filename.isEmpty })
    }

    @Test func atMost200FramesAreKept() {
        let addresses = Array(repeating: NSNumber(value: 0x1), count: 300)
        #expect(CallStack.frames(addresses).count == 200)
    }

    @Test func aFrameWithNoSymbolIsNamedByItsAddress() {
        let frames = CallStack.frames([NSNumber(value: 0x10)])
        #expect(frames.first?.function == "0x10")
    }

    @Test func aFrameIsItsSymbolPlusItsOffsetIntoIt() throws {
        let frames = CallStack.frames([NSNumber(value: try address(of: "qsort") + 0x2c)])
        #expect(frames.first?.function == "qsort + 0x2c")
    }

    @Test func aFrameWithNoSymbolInAKnownImageIsTheOffsetIntoTheImage() throws {
        // An image's own header has no symbol before it, as a stripped app's code has none at all
        // (iOS 18.2 simulator: dladdr names no symbol there, __mh_execute_header exported or not).
        var info = Dl_info()
        let qsort = UnsafeRawPointer(bitPattern: try address(of: "qsort"))
        try #require(dladdr(qsort, &info) != 0)
        let image = (String(cString: info.dli_fname) as NSString).lastPathComponent
        let frames = CallStack.frames([NSNumber(value: UInt(bitPattern: info.dli_fbase) + 0x10)])
        #expect(frames.first?.function == "\(image) + 0x10")
        #expect(frames.first?.filename == image)
    }

    /// Where `symbol` starts, in any image loaded (RTLD_DEFAULT).
    private func address(of symbol: String) throws -> UInt {
        UInt(bitPattern: try #require(dlsym(UnsafeMutableRawPointer(bitPattern: -2), symbol)))
    }
}

private struct PaymentError: Error {}

extension SharedStateTests {
    @Suite struct ErrorsAndLogsTests {
        private func withSharedRuntime(_ body: (FakePlatform) throws -> Void) rethrows {
            let platform = FakePlatform()
            let previous = RumRuntime.shared.replacePlatform { _ in platform.services }
            defer {
                RumRuntime.shared.reset()
                RumRuntime.shared.replacePlatform(previous)
            }
            try? RumRuntime.shared.start(
                GroundcoverConfig(
                    apiKey: "k", dsn: "ingest.example", cluster: "c", environment: "e",
                    appId: "a",
                    options: GroundcoverOptions(
                        transport: TransportOptions(batchSize: 0, compression: false))))
            RumRuntime.shared.dispatch("presence") { $0.presence() }
            try body(platform)
        }

        private func events(_ platform: FakePlatform, _ type: String) -> [[String: Any]] {
            platform.requests.flatMap(\.events).filter { $0["type"] as? String == type }
                .compactMap { $0["attributes"] as? [String: Any] }
        }

        @Test func aHandledErrorCarriesTheFramesOfTheCallSite() throws {
            try withSharedRuntime { platform in
                Groundcover.captureError(PaymentError(), metadata: ["step": "pay"])
                let event = try #require(events(platform, "exception").first)
                let frames = try #require(event["error_stacktrace"] as? [[String: Any]])
                #expect(!frames.isEmpty)
                let function = frames.first?["error_stacktrace[0].function"] as? String
                #expect(function?.contains("GroundcoverRumTests") == true)
            }
        }

        @Test func aHandledErrorFromObjectiveCCarriesTheFramesOfItsCallSite() throws {
            try withSharedRuntime { platform in
                // Through objc_msgSend, as an Objective-C host calls the facade.
                let facade: AnyObject = GCRum.self
                _ = facade.perform(
                    NSSelectorFromString("captureError:metadata:"),
                    with: NSError(domain: "pay", code: 1), with: nil)
                let event = try #require(events(platform, "exception").first)
                let frames = try #require(event["error_stacktrace"] as? [[String: Any]])
                let function = frames.first?["error_stacktrace[0].function"] as? String
                #expect(function?.contains("GroundcoverRumTests") == true)
            }
        }

        @Test func swiftLogMessagesAreLogEventsAtTheirLevelWithTheirMetadata() throws {
            try withSharedRuntime { platform in
                var handler = GroundcoverLogHandler(label: "checkout")
                handler.logLevel = .trace
                handler[metadataKey: "order"] = "A-1"
                let logger = Logger(label: "checkout") { _ in handler }
                logger.notice("paid", metadata: ["attempt": "2"])
                logger.warning("slow")
                logger.critical("failed")
                logger.info("skip me groundcoverIgnore")
                let logs = events(platform, "log")
                #expect(logs.map { $0["level"] as? String } == ["info", "warn", "error"])
                #expect(logs.first?["message"] as? String == "paid")
                #expect(logs.first?["logger"] as? String == "checkout")
                #expect(logs.first?["order"] as? String == "A-1")
                #expect(logs.first?["attempt"] as? String == "2")
            }
        }

        @Test func messagesBelowTheHandlersLevelAreNotSent() throws {
            try withSharedRuntime { platform in
                let logger = Logger(label: "x") { GroundcoverLogHandler(label: $0) }
                logger.debug("too quiet")
                logger.info("loud enough")
                #expect(events(platform, "log").map { $0["message"] as? String } == ["loud enough"])
            }
        }
    }
}
