import Foundation
import Testing

@testable import GroundcoverRum

// Turning a capture into a wire event: the enricher's ids, timestamps and flattened attributes,
// the event as the wire and the hooks see it, and the custom, log and error shapers.

private let t0: Int64 = 1_800_000_000_000

private func anEnricher(platformAttributes: (() throws -> [String: Any])? = nil) -> EventEnricher {
    EventEnricher(
        idGenerator: RandomIdGenerator(), clock: { t0 }, platformAttributes: platformAttributes)
}

@Suite struct EventEnricherTests {
    private let enricher = anEnricher(platformAttributes: {
        ["screen": ["name": "Home", "key": "k1"]]
    })

    @Test func stampsIdsTheTimestampInNanosecondsAndAnEmptyParentSpanId() {
        let event = enricher.enrich(EnrichInput(type: "custom"))
        #expect(event.timestamp == msToNs(t0))
        #expect(event.startTimestamp == nil)
        #expect(event.parentSpanId == "")
        #expect(event.id.count == 32)
        #expect(event.spanId.count == 16)
        #expect(event.traceId?.hasPrefix(String(repeating: "0", count: 16)) == true)
    }

    @Test func aNetworkEventGetsStartAndEndTimestampsInstead() {
        let event = enricher.enrich(
            EnrichInput(type: "network", timestamp: 5, endTimestamp: 9, spanName: "GET /x"))
        #expect(event.timestamp == nil)
        #expect(event.startTimestamp == 5)
        #expect(event.endTimestamp == 9)
        #expect(event.wireJson["span_name"] as? String == "GET /x")
    }

    @Test func keepsASuppliedTime0IncludedAndReplacesANegativeOne() {
        #expect(enricher.enrich(EnrichInput(type: "log", timestamp: 0)).timestamp == 0)
        #expect(enricher.enrich(EnrichInput(type: "log", timestamp: -1)).timestamp == msToNs(t0))
    }

    @Test func keepsSuppliedSpanAndTraceIds() {
        let event = enricher.enrich(
            EnrichInput(
                type: "network", traceId: String(repeating: "b", count: 32),
                spanId: String(repeating: "a", count: 16)))
        #expect(event.spanId == String(repeating: "a", count: 16))
        #expect(event.traceId == String(repeating: "b", count: 32))
    }

    @Test func platformAttributesWinOverAUserAttributeOfTheSameName() {
        let event = enricher.enrich(EnrichInput(type: "log", attributes: ["screen": "user"]))
        #expect(encodeJson(event.attributes["screen"]) == #"{"key":"k1","name":"Home"}"#)
    }

    @Test func aThrowingContributorYieldsNoPlatformAttributes() {
        struct Boom: Error {}
        let throwing = anEnricher(platformAttributes: { throw Boom() })
        let event = throwing.enrich(EnrichInput(type: "log", attributes: ["a": 1]))
        #expect(encodeJson(event.attributes) == #"{"a":1}"#)
    }
}

@Suite struct FlattenAttributesTests {
    @Test func dotFlattensMapsAndFlattensMapsInListsUnderKeyAndIndex() {
        let out = flattenAttributes([
            "a": ["b": 1, "c": ["d": "x"]],
            "frames": [["function": "f"], 7],
        ])
        #expect(
            encodeJson(out)
                == #"{"a.b":1,"a.c.d":"x","frames":[{"frames[0].function":"f"},7]}"#)
    }

    @Test func boundsDepthAndMarksACycle() {
        var deep: [String: Any] = ["leaf": 1]
        for _ in 0..<12 { deep = ["n": deep] }
        #expect(flattenAttributes(deep).values.contains { $0 as? String == "[Depth Limit]" })
        let cyclic = NSMutableDictionary(dictionary: ["a": 1])
        cyclic["self"] = cyclic
        // Nested: a Swift dictionary at the root is a value, with no identity to come back to.
        #expect(
            encodeJson(flattenAttributes(["obj": cyclic]))
                == #"{"obj.a":1,"obj.self":"[Circular]"}"#)
    }

    @Test func marksAListThatContainsItselfWithoutWalkingItAgain() {
        let list = NSMutableArray()
        list.add(list)
        list.add(list)
        #expect(encodeJson(flattenAttributes(["a": list])) == #"{"a":["[Circular]","[Circular]"]}"#)
    }

    @Test func makesEveryValueJsonSafe() {
        struct Profile: CustomStringConvertible { var description: String { "profile #7" } }
        let out = flattenAttributes(["nan": Double.nan, "when": Profile(), "flag": true])
        #expect(out["nan"] is NSNull)
        #expect(out["when"] as? String == "profile #7")
        #expect(out["flag"] as? Bool == true)
        // Any collection is a list, as the transport writes one a hook put back.
        #expect(flattenAttributes(["tags": Set(["a"])])["tags"] as? [String] == ["a"])
    }
}

@Suite struct RumEventWireTests {
    @Test func theWireCarriesTimestampsOnlyWhenSetAndAlwaysTheIds() {
        let event = RumEvent(
            type: "network", id: "i", spanId: "s", parentSpanId: "", traceId: "t",
            startTimestamp: 5, endTimestamp: 9, spanName: "GET /x", attributes: ["a": 1])
        let expected: NSDictionary = [
            "attributes": ["a": 1], "end_timestamp": 9, "id": "i", "parentSpanId": "",
            "spanId": "s", "span_name": "GET /x", "start_timestamp": 5, "traceId": "t",
            "type": "network",
        ]
        #expect(decodeJsonObject(encodeJson(event.wireJson)).map(NSDictionary.init) == expected)
    }

    @Test func aCopysAttributesAreItsOwnAllTheWayDown() {
        let original = RumEvent(
            type: "log", id: "i", spanId: "s", timestamp: 1, attributes: ["nested": ["k": "v"]])
        let copy = copyRumEvent(original)
        copy.attributes["nested"] = ["k": "changed"]
        copy.timestamp = 2
        #expect(encodeJson(original.attributes) == #"{"nested":{"k":"v"}}"#)
        #expect(original.timestamp == 1)
        #expect(copy.id == original.id)
    }
}

@Suite struct EventShaperTests {
    @Test func aCustomEventIsSentAsGivenWithoutRedaction() {
        let input = shapeCustomEvent(
            CustomEventCapture(name: "purchase", attributes: ["password": "x"], timestampNs: 7))
        #expect(input.type == "custom")
        #expect(input.timestamp == 7)
        #expect(
            encodeJson(input.attributes)
                == #"{"custom_event_attributes":{"password":"x"},"custom_event_name":"purchase"}"#)
    }

    @Test func aLogStripsMessageLevelAndTheReservedKeysFromUserAttributes() {
        let input = shapeLogEvent(
            LogCapture(
                message: "hello", level: .info,
                attributes: [
                    "message": "spoofed", "level": "error", "screen": "spoofed", "orderId": 7,
                ]),
            privacy: resolvePrivacy(nil), reservedKeys: ["screen"])
        #expect(input.type == "log")
        #expect(encodeJson(input.attributes) == #"{"level":"info","message":"hello","orderId":7}"#)
    }

    @Test func aLogKeepsAUserKeyNoPlatformReserved() {
        let input = shapeLogEvent(
            LogCapture(message: "hello", level: .warn, attributes: ["location": "warehouse-7"]),
            privacy: resolvePrivacy(nil))
        #expect(input.attributes["location"] as? String == "warehouse-7")
    }

    @Test func aLogIsRedactedUnderTheLogPrivacyRules() {
        let input = shapeLogEvent(
            LogCapture(
                message: "login password=hunter2", level: .error, attributes: ["token": "t"]),
            privacy: resolvePrivacy(nil))
        #expect(input.attributes["message"] as? String == "login password=[REDACTED]")
        #expect(input.attributes["token"] as? String == redacted)
    }

    @Test func anExceptionIsShapedWithItsFingerprint() {
        let input = shapeErrorEvent(
            ErrorCapture(
                type: "PlaygroundError", message: "bad input",
                frames: [ErrorFrame(filename: "App.swift", function: "run()", lineno: 3, colno: 0)],
                handled: true, metadata: ["stage": "test"]),
            privacy: resolvePrivacy(nil))
        #expect(input.type == "exception")
        #expect(
            encodeJson(input.attributes)
                == #"{"error_fingerprint":"PlaygroundError:bad input","error_handled":true,"error_message":"bad input","error_metadata":{"stage":"test"},"error_stacktrace":[{"colno":0,"filename":"App.swift","function":"run()","lineno":3}],"error_type":"PlaygroundError"}"#
        )
    }

    @Test func handledDefaultsToFalseAndAnEmptyMessageAndTypeToTheirDefaults() {
        let input = shapeErrorEvent(
            ErrorCapture(type: "", message: ""), privacy: resolvePrivacy(nil))
        #expect(input.attributes["error_handled"] as? Bool == false)
        #expect(input.attributes["error_message"] as? String == "Unknown error")
        #expect(input.attributes["error_type"] as? String == "Error")
        // The fingerprint uses the defaulted type, never an empty one.
        #expect(input.attributes["error_fingerprint"] as? String == "Error:Unknown error")
        #expect(input.attributes["error_metadata"] == nil)
    }

    @Test func masksTheMessageAndMetadataAndFingerprintsTheRedactedMessage() {
        let input = shapeErrorEvent(
            ErrorCapture(
                type: "Error", message: "login failed password=hunter2",
                metadata: ["tenant": "acme"]),
            privacy: resolvePrivacy(PrivacyOptions(sensitiveKeys: ["tenant"])))
        #expect(input.attributes["error_message"] as? String == "login failed password=[REDACTED]")
        #expect(
            input.attributes["error_fingerprint"] as? String
                == "Error:login failed password=[REDACTED]")
        #expect(encodeJson(input.attributes["error_metadata"]) == #"{"tenant":"[REDACTED]"}"#)
    }

    @Test func leavesEverythingAsItIsUnderAllow() {
        let input = shapeErrorEvent(
            ErrorCapture(
                type: "Error", message: "login failed password=hunter2",
                metadata: ["tenant": "acme"]),
            privacy: resolvePrivacy(PrivacyOptions(level: .allow, sensitiveKeys: ["tenant"])))
        #expect(input.attributes["error_message"] as? String == "login failed password=hunter2")
        #expect(encodeJson(input.attributes["error_metadata"]) == #"{"tenant":"acme"}"#)
    }
}

@Suite struct ErrorTypeNameTests {
    @Test func aBridgedAppleErrorIsNamedByItsSwiftType() {
        // What URLSession, FileManager and the POSIX calls hand an app: an NSError underneath.
        let url = NSError(domain: NSURLErrorDomain, code: NSURLErrorBadServerResponse)
        let cocoa = NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOENT))
        #expect(errorTypeName(url) == "URLError")
        #expect(errorTypeName(cocoa) == "CocoaError")
        #expect(errorTypeName(posix) == "POSIXError")
        #expect(errorTypeName(URLError(.badServerResponse)) == "URLError")
    }

    @Test func anyOtherNSErrorIsNamedByItsDomainAndASwiftErrorByItsType() {
        enum CheckoutError: Error { case declined }
        let billing = NSError(domain: "com.example.billing", code: 1)
        #expect(errorTypeName(billing) == "com.example.billing")
        #expect(errorTypeName(CheckoutError.declined) == "CheckoutError")
    }
}
