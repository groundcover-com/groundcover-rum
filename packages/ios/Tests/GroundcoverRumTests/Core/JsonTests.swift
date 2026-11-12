import Foundation
import Testing

@testable import GroundcoverRum

// What the app hands the SDK unflattened (user properties, what a hook puts back) becomes plain
// JSON data once, so one odd value never costs a whole batch.

@Suite struct JsonTests {
    private struct Profile: CustomStringConvertible {
        var description: String { "profile #7" }
    }

    @Test func jsonScalarsMapsAndListsAreKeptAsTheyAre() {
        let value: [String: Any] = [
            "s": "x", "i": 1, "d": 1.5, "b": true, "none": Optional<Int>.none as Any,
            "list": [1, "two"],
        ]
        #expect(
            encodeJson(value) == #"{"b":true,"d":1.5,"i":1,"list":[1,"two"],"none":null,"s":"x"}"#)
    }

    @Test func aBoolStaysABoolAndANumberANumberWhateverWrapsThem() {
        let value: [String: Any] = [
            "yes": NSNumber(value: true), "one": NSNumber(value: 1),
            "ns": Int64(1_800_000_000_000_000_001),
        ]
        #expect(encodeJson(value) == #"{"ns":1800000000000000001,"one":1,"yes":true}"#)
    }

    @Test func aNonFiniteNumberIsNullAndAnythingElseItsStringForm() {
        let value: [String: Any] = [
            "nan": Double.nan, "inf": Double.infinity, "profile": Profile(), "url": "a/b",
        ]
        #expect(encodeJson(value) == #"{"inf":null,"nan":null,"profile":"profile #7","url":"a/b"}"#)
    }

    @Test func aNumberThatDoesNotBridgeToNSNumberStillMakesValidJson() {
        // JSONSerialization throws an Objective-C exception on these, which nothing can catch.
        var value: [String: Any] = ["half": Float16(1.5)]
        if #available(iOS 18.0, *) {
            value["wide"] = Int128(5)
            value["huge"] = UInt128.max
        }
        let data = toJsonData(value)
        #expect(JSONSerialization.isValidJSONObject(data))
        let map = data as? [String: Any]
        #expect(map?["half"] as? Double == 1.5)
        if #available(iOS 18.0, *) {
            #expect(map?["wide"] as? Int64 == 5)
            #expect(map?["huge"] as? String == String(describing: UInt128.max))
        }
    }

    @Test func aMapsKeysBecomeStrings() {
        #expect(encodeJson([1: "a"] as [Int: String]) == #"{"1":"a"}"#)
    }

    @Test func aCollectionThatContainsItselfIsMarkedCircular() {
        let loop = NSMutableDictionary(dictionary: ["a": 1])
        loop["self"] = loop
        let list = NSMutableArray(array: [1])
        list.add(list)
        #expect(encodeJson(loop) == #"{"a":1,"self":"[Circular]"}"#)
        #expect(encodeJson(list) == #"[1,"[Circular]"]"#)
    }

    @Test func theSameCollectionTwiceSideBySideIsNotACycle() {
        let shared = NSDictionary(dictionary: ["k": 1])
        #expect(encodeJson([shared, shared]) == #"[{"k":1},{"k":1}]"#)
    }

    @Test func nestingPast32LevelsIsCut() throws {
        var value: [String: Any] = ["leaf": true]
        for _ in 0..<40 { value = ["n": value] }
        var node = try #require(toJsonData(value) as? [String: Any])
        for _ in 0..<31 { node = try #require(node["n"] as? [String: Any]) }
        #expect(node["n"] as? String == "[Depth Limit]")
    }

    @Test func toJsonMapMakesTheSameDataAsAMap() {
        let map = toJsonMap(["when": Profile(), "nested": ["x": Double.nan]])
        #expect(map["when"] as? String == "profile #7")
        #expect((map["nested"] as? [String: Any])?["x"] is NSNull)
    }

    @Test func decodeJsonObjectReadsAnObjectAndNothingElse() {
        #expect(decodeJsonObject(#"{"a":1}"#)?["a"] as? Int == 1)
        #expect(decodeJsonObject("[1]") == nil)
        #expect(decodeJsonObject("not json") == nil)
    }
}
