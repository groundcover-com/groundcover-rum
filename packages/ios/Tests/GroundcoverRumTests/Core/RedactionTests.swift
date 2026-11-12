import Foundation
import Testing

@testable import GroundcoverRum

// The sensitive-data patterns and the redaction every capture path shares, identical to the other
// SDKs' so every SDK masks the same strings.

private func parseQuery(_ query: String) -> [String: String] {
    var values: [String: String] = [:]
    let trimmed = query.hasPrefix("?") ? String(query.dropFirst()) : query
    for pair in trimmed.split(separator: "&", omittingEmptySubsequences: true) {
        func decode(_ raw: Substring) -> String {
            let spaced = raw.replacingOccurrences(of: "+", with: " ")
            return spaced.removingPercentEncoding ?? spaced
        }
        if let eq = pair.firstIndex(of: "=") {
            let key = decode(pair[..<eq])
            if values[key] == nil { values[key] = decode(pair[pair.index(after: eq)...]) }
        } else if values[decode(pair)] == nil {
            values[decode(pair)] = ""
        }
    }
    return values
}

private let encodedRedacted = "%5BREDACTED%5D"

private func object(_ json: String) throws -> [String: Any] {
    try #require(decodeJsonObject(json))
}

private func options(
    kind: RedactKind? = nil, sensitiveKeys: [String] = [], redact: Redactor? = nil
) -> RedactOptions {
    RedactOptions(sensitiveKeys: sensitiveKeys, redact: redact, kind: kind)
}

@Suite struct SensitiveKeyTests {
    @Test func matchesBuiltInSensitivePatterns() {
        for key in [
            "password", "user_token", "apiKey", "api-key", "Authorization", "creditCard",
            "cardNumber",
        ] {
            #expect(isSensitiveKey(key), "\(key)")
        }
    }

    @Test func doesNotOverMatchInnocuousKeys() {
        for key in ["cardinality", "session_id", "username", "email"] {
            #expect(!isSensitiveKey(key), "\(key)")
        }
    }

    @Test func honorsExtraKeys() {
        #expect(isSensitiveKey("ssn"))
        #expect(isSensitiveKey("internal_ref", ["internal_ref"]))
        #expect(!isSensitiveKey("internal_ref"))
    }
}

@Suite struct RedactHeadersTests {
    @Test func redactsSensitiveHeaderNamesAndPatternsAndKeepsOthers() {
        let result = redactHeaders([
            "Authorization": "Bearer abc", "Cookie": "sid=1", "x-api-token": "secret",
            "Content-Type": "application/json", "Accept": "*/*",
        ])
        #expect(result["Authorization"] == redacted)
        #expect(result["Cookie"] == redacted)
        #expect(result["x-api-token"] == redacted)
        #expect(result["Content-Type"] == "application/json")
        #expect(result["Accept"] == "*/*")
    }

    @Test func redactsHeaderNamesContainingABareKeySubstring() {
        let result = redactHeaders([
            "x-functions-key": "abc", "x-encryption-key": "def", "x-key": "ghi",
        ])
        #expect(
            result == [
                "x-functions-key": redacted, "x-encryption-key": redacted, "x-key": redacted,
            ])
    }
}

@Suite struct RedactQueryStringTests {
    @Test func redactsSensitiveParamsAndPreservesTheRest() {
        let params = parseQuery(redactQueryString("user=bob&token=abc123&page=2"))
        #expect(params["user"] == "bob")
        #expect(params["token"] == redacted)
        #expect(params["page"] == "2")
    }

    @Test func returnsTheInputUnchangedWhenNothingIsSensitive() {
        #expect(redactQueryString("a=1&b=2") == "a=1&b=2")
    }

    @Test func preservesRepeatedKeys() {
        #expect(
            redactQueryString("token=a&token=b&user=x")
                == "token=\(encodedRedacted)&token=\(encodedRedacted)&user=x")
    }

    @Test func redactsOAuthParamsByExactKey() {
        let params = parseQuery(
            redactQueryString("code=authcode123&state=csrf456&session_state=s789&page=2"))
        #expect(params["code"] == redacted)
        #expect(params["state"] == redacted)
        #expect(params["session_state"] == redacted)
        #expect(params["page"] == "2")
    }

    @Test func doesNotRedactParamsThatMerelyContainCodeOrState() {
        let params = parseQuery(redactQueryString("zipcode=90210&statename=CA&mode=dark"))
        #expect(params["zipcode"] == "90210")
        #expect(params["statename"] == "CA")
        #expect(params["mode"] == "dark")
    }

    @Test func aRedactedValueIsWrittenBackAsEncodeURIComponentWritesIt() {
        let out = redactQueryString(
            "q=a b",
            options(redact: { field in field.key == "q" ? "x y/z?é" : nil }))
        #expect(out == "q=x%20y%2Fz%3F%C3%A9")
    }
}

@Suite struct RedactUrlTests {
    @Test func redactsQueryParamsAndKeepsPathAndFragment() {
        let out = redactUrl("https://x.com/p?token=abc&q=1#frag")
        #expect(out.contains("https://x.com/p?"))
        #expect(out.contains("token=\(encodedRedacted)"))
        #expect(out.contains("q=1"))
        #expect(out.contains("#frag"))
    }

    @Test func leavesUrlsWithoutAQueryUntouched() {
        #expect(redactUrl("https://x.com/path") == "https://x.com/path")
    }

    @Test func redactsAnOAuthAuthorizationCodeCallbackUrl() {
        let out = redactUrl("https://app.com/?code=authcode123&state=csrf456&page=2")
        #expect(!out.contains("authcode123"))
        #expect(!out.contains("csrf456"))
        #expect(out.contains("page=2"))
    }

    @Test func redactsAQueryInsideTheFragmentAfterARealQuery() {
        let out = redactUrl("https://app.com/path?a=1#/reset?token=SUPERSECRET&section=2")
        #expect(!out.contains("SUPERSECRET"))
        #expect(out.contains("a=1"))
        #expect(out.contains("section=2"))
        #expect(out.contains("#/reset?"))
    }

    @Test func redactsAQueryInsideTheFragmentWithNoQueryBeforeIt() {
        let out = redactUrl("https://app.com/#/auth?access_token=SUPERSECRET")
        #expect(!out.contains("SUPERSECRET"))
        #expect(out.contains("#/auth?"))
    }

    @Test func stripsEmbeddedUserinfo() {
        let out = redactUrl("https://admin:s3cr3t@internal.api/data?x=1")
        #expect(!out.contains("s3cr3t"))
        #expect(!out.contains("admin:"))
        #expect(out.contains("@internal.api/data"))
        #expect(out.contains("x=1"))
    }

    @Test func doesNotTreatAnAtInTheQueryAsUserinfo() {
        #expect(redactUrl("https://x.com/p?email=a@b.com").contains("a@b.com"))
    }
}

@Suite struct RedactBodyTests {
    @Test func aBodyNestedPastTheDepthLimitIsRedactedWhole() {
        // Each level of a parse is a stack frame, and a GCD thread has 512 KB of stack.
        func nested(_ depth: Int) -> String {
            String(repeating: #"{"a":"#, count: depth) + #"{"password":"hunter2"}"#
                + String(repeating: "}", count: depth)
        }
        final class Box: @unchecked Sendable { var out: String? }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            box.out = redactBody(nested(1000))
            done.signal()
        }
        done.wait()
        #expect(box.out == redacted)
    }

    @Test func aBodyNestedExactlyToTheDepthLimitKeepsItsPasswordRedacted() {
        // One level short of being redacted whole, so it must parse: the text scrub would miss it.
        let body =
            String(repeating: #"{"a":"#, count: 63) + #"{"password":"hunter2"}"#
            + String(repeating: "}", count: 63)
        #expect(!redactBody(body).contains("hunter2"))
    }

    @Test func aNumberPastTheDoubleRangeReadsAsJavaScriptReadsIt() {
        // JSON.parse reads 1e999 as Infinity, and JSON.stringify writes that as null.
        #expect(
            redactBody(#"{"profile":{"password":"hunter2"},"n":1e999}"#)
                == #"{"profile":{"password":"[REDACTED]"},"n":null}"#)
    }

    @Test func deepRedactsJsonObjectBodies() throws {
        let parsed = try object(
            redactBody(#"{"user":"bob","password":"hunter2","nested":{"token":"t"}}"#))
        #expect(parsed["user"] as? String == "bob")
        #expect(parsed["password"] as? String == redacted)
        #expect((parsed["nested"] as? [String: Any])?["token"] as? String == redacted)
    }

    @Test func keepsTheBodysKeyOrderAsJSONStringifyDoes() {
        #expect(
            redactBody(#"{"z":1,"password":"x","a":{"y":2,"b":3}}"#)
                == #"{"z":1,"password":"[REDACTED]","a":{"y":2,"b":3}}"#)
    }

    @Test func aHookValueJsonHasNoFormForNeverReopensTheBody() throws {
        final class Keys: @unchecked Sendable { var all: [String] = [] }
        let keys = Keys()
        let out = redactBody(
            #"{"amount":5,"tokens":["tok_A","tok_B"],"password":{"x":"p1"}}"#,
            options(redact: { field in
                keys.all.append(field.key)
                return field.key == "amount" ? Double.nan : nil
            }))
        // As JSON.stringify writes NaN; the sensitive keys stay redacted whole.
        #expect(out == #"{"amount":null,"tokens":"[REDACTED]","password":"[REDACTED]"}"#)
        #expect(!keys.all.contains(""), "no whole-body second pass")
    }

    @Test func writesJsonNumbersBackAsJSONStringifyDoes() {
        #expect(
            redactBody(
                #"{"amount": 1.0, "e": 1e3, "x": 1.5, "n": [2.0], "tiny": 1.5e-7, "big": 1e21}"#)
                == #"{"amount":1,"e":1000,"x":1.5,"n":[2],"tiny":1.5e-7,"big":1e+21}"#)
    }

    @Test func writesStringsBackAsJSONStringifyDoes() {
        #expect(
            redactBody(#"{"path":"a/b","quote":"say \"hi\"","line":"a\nb","é":"é"}"#)
                == #"{"path":"a/b","quote":"say \"hi\"","line":"a\nb","é":"é"}"#)
    }

    @Test func redactsJsonInsideArrays() throws {
        let out = redactBody(#"[{"secret":"x"},{"ok":"y"}]"#)
        #expect(out == #"[{"secret":"[REDACTED]"},{"ok":"y"}]"#)
    }

    @Test func redactsFormEncodedBodies() {
        let params = parseQuery(redactBody("grant_type=password&password=secret&user=bob"))
        #expect(params["password"] == redacted)
        #expect(params["user"] == "bob")
    }

    @Test func redactsAWriteKeyInAJsonBody() throws {
        let parsed = try object(
            redactBody(#"{"writeKey":"test-write-key-0000000000","event":"track"}"#))
        #expect(parsed["writeKey"] as? String == redacted)
        #expect(parsed["event"] as? String == "track")
    }

    @Test func doesNotRedactGenericCodeOrStateKeysInsideJsonBodies() throws {
        let parsed = try object(redactBody(#"{"code":200,"state":"open","user":"bob"}"#))
        #expect(parsed["code"] as? Int == 200)
        #expect(parsed["state"] as? String == "open")
    }

    @Test func fallsBackToTheFreeTextScrubForNonJson() {
        #expect(redactBody("login failed for token: abc123").contains(redacted))
    }

    @Test func boundsDeepNestingAndNeverLeaksBelowTheDepthCap() {
        var deep = #"{"password":"x"}"#
        for _ in 0..<50 { deep = #"{"nested":\#(deep)}"# }
        #expect(!redactBody(deep).contains(#""password":"x""#))
    }

    @Test func preservesArrayLength() throws {
        let body = "[" + (0..<5000).map { #"{"i":\#($0)}"# }.joined(separator: ",") + "]"
        let out = redactBody(body)
        let parsed = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [Any]
        #expect(parsed?.count == 5000)
    }

    @Test func fallsBackToATextScrubForOversizedJsonBodies() {
        let filler = String(repeating: "x", count: 200_000)
        let out = redactBody(#"{"password":"secret","note":"\#(filler)"}"#)
        #expect(out.contains(redacted))
        #expect(!out.contains("secret"))
    }

    @Test func returnsEmptyInputUnchanged() {
        #expect(redactBody("") == "")
    }
}

@Suite struct RedactTextTests {
    @Test func scrubsAKeyOnlyTheAppCallsSensitiveAndLeavesTheRest() {
        let opts = options(sensitiveKeys: ["order_id"])
        #expect(redactText("order_id=42 for bob", opts) == "order_id=[REDACTED] for bob")
        #expect(redactText("cart has 3 items, total 42", opts) == "cart has 3 items, total 42")
    }

    @Test func scrubsKeyValueAndKeyColonValuePairs() {
        #expect(redactText("password=secret").contains(redacted))
        #expect(redactText("token: abc123").contains(redacted))
    }

    @Test func leavesNonSensitiveTextUntouched() {
        #expect(redactText("user logged in successfully") == "user logged in successfully")
    }

    @Test func redactsTheWholeValueAfterASpace() {
        let out = redactText("Authorization: Bearer eyJtoken123")
        #expect(!out.contains("eyJtoken123"))
        #expect(!out.contains("Bearer"))
        #expect(out.contains(redacted))
    }

    @Test func redactsASensitivePairInsideAPrintedMap() {
        // A printed dictionary nests pairs: a harmless label before it must not swallow them.
        let headers = redactText(
            "Request headers: {Authorization: Bearer eyJ.abc.def, Accept: application/json}")
        #expect(!headers.contains("eyJ.abc.def"))
        #expect(headers.contains("Accept: application/json"))
        let user = redactText("User: {token: abc123, name: bob}")
        #expect(!user.contains("abc123"))
        #expect(user.contains("name: bob"))
        #expect(!redactText("ctx: {req: {headers: {x_auth: s3cr3t}}}").contains("s3cr3t"))
    }

    @Test func doesNotBleedPastALineBoundary() {
        let out = redactText("token: abc123\nstatus: ok")
        #expect(!out.contains("abc123"))
        #expect(out.contains("status: ok"))
    }

    @Test func redactsOAuthCodeAndStateInQueryShapedFreeText() {
        let out = redactText("callback code=oauthcode123&state=csrf456&page=2")
        #expect(!out.contains("oauthcode123"))
        #expect(!out.contains("csrf456"))
        #expect(out.contains("page=2"))
    }

    @Test func doesNotRedactCodeOrStateColonsInPlainLogLines() {
        let out = redactText("request finished code: 200 state: idle")
        #expect(out.contains("200"))
        #expect(out.contains("idle"))
    }

    @Test func redactsHeaderStyleBareKeyNames() {
        let out = redactText("x-functions-key: supersecret")
        #expect(!out.contains("supersecret"))
        #expect(out.contains(redacted))
    }

    @Test func redactsASensitivePairEmbeddedAfterAHarmlessKey() {
        let out = redactText("navigated to /login?next=/home?token=SUPERSECRET")
        #expect(!out.contains("SUPERSECRET"))
        #expect(out.contains(redacted))
    }

    @Test func boundsWorkOnOversizedInput() {
        let out = redactText(String(repeating: "a", count: 200_000) + " token=SUPERSECRET")
        #expect(!out.contains("SUPERSECRET"))
        #expect(out.hasSuffix("…"))
    }

    @Test func aWordCharacterIsAsciiAsInJavaScript() {
        // `\w` is ASCII in JavaScript and Unicode in ICU, Android's regex engine: "é" must not
        // join the key, which leaves `code`, a sensitive query key on its own.
        #expect(redactText("écode=123") == "écode=[REDACTED]")
    }
}

@Suite struct RedactObjectTests {
    @Test func deepRedactsWithoutMutatingTheInput() {
        let nested = NSMutableDictionary(dictionary: ["token": "t"])
        let input: [String: Any] = ["a": "1", "secret": "x", "nested": nested]
        let out = redactObject(input)
        #expect(out["secret"] as? String == redacted)
        #expect((out["nested"] as? [String: Any])?["token"] as? String == redacted)
        #expect(input["secret"] as? String == "x")
        #expect(nested["token"] as? String == "t")
    }

    @Test func terminatesOnACycle() {
        let a = NSMutableDictionary(dictionary: ["name": "a"])
        let b = NSMutableDictionary(dictionary: ["name": "b", "a": a])
        a["b"] = b
        // Nested: a Swift dictionary at the root is a value, with no identity to come back to.
        let out = redactObject(["root": a])["root"] as? [String: Any]
        #expect(out?["name"] as? String == "a")
        #expect((out?["b"] as? [String: Any])?["a"] as? String == redacted)
    }

    @Test func walksAMapSharedBetweenSiblings() {
        let shared = NSDictionary(dictionary: ["city": "NYC"])
        let out = redactObject(["home": shared, "work": shared])
        #expect((out["home"] as? [String: Any])?["city"] as? String == "NYC")
        #expect((out["work"] as? [String: Any])?["city"] as? String == "NYC")
    }

    @Test func stringifiesAValueThatIsNeitherAContainerNorAPrimitive() {
        struct Profile: CustomStringConvertible { var description: String { "profile #7" } }
        #expect(redactObject(["when": Profile()])["when"] as? String == "profile #7")
    }

    @Test func setsAndArraysAreWalkedLikeLists() throws {
        let out = redactObject([
            "accounts": Set([["password": "hunter2"]]), "ids": NSSet(array: [1]),
        ])
        let accounts = try #require(out["accounts"] as? [Any])
        #expect((accounts.first as? [String: Any])?["password"] as? String == redacted)
        #expect(out["ids"] as? [Int] == [1])
    }

    @Test func aStringifiedObjectIsScrubbedAsText() throws {
        struct Payment {
            var holder = "Dana"
            var password = "hunter2"
        }
        let out = try #require(redactObject(["payment": Payment()])["payment"] as? String)
        #expect(!out.contains("hunter2"))
        #expect(out.contains("password: \(redacted)"))
        #expect(out.contains("Dana"))
    }

    @Test func aNilOptionalIsNullNotTheWordNil() {
        let missing: String? = nil
        let present: String? = "u_1"
        let out = redactObject(["missing": missing as Any, "present": present as Any])
        #expect(out["missing"] is NSNull)
        #expect(out["present"] as? String == "u_1")
    }
}

@Suite struct RedactMetadataTests {
    @Test func keyRedactsMetadataWhileMasking() {
        let out = redactMetadata(["password": "x", "step": 2], resolvePrivacy(nil))
        #expect(out?["password"] as? String == redacted)
        #expect(out?["step"] as? Int == 2)
    }

    @Test func appliesTheUsersSensitiveKeys() {
        let out = redactMetadata(
            ["tenant": "acme"], resolvePrivacy(PrivacyOptions(sensitiveKeys: ["tenant"])))
        #expect(out?["tenant"] as? String == redacted)
    }

    @Test func returnsMetadataUntouchedUnderAllowAndPassesNilThrough() {
        let out = redactMetadata(["password": "x"], resolvePrivacy(PrivacyOptions(level: .allow)))
        #expect(out?["password"] as? String == "x")
        #expect(redactMetadata(nil, resolvePrivacy(nil)) == nil)
    }
}

@Suite struct RedactLogFieldsTests {
    @Test func masksMessageTextAndAttributeValues() {
        let out = redactLogFields(
            resolvePrivacy(nil), message: "login password=secret",
            attributes: ["password": "secret", "user": "bob"])
        #expect(out.message == "login password=[REDACTED]")
        #expect(out.attributes?["password"] as? String == redacted)
        #expect(out.attributes?["user"] as? String == "bob")
    }

    @Test func isANoOpWhenLogMaskingIsOff() {
        let out = redactLogFields(
            resolvePrivacy(PrivacyOptions(maskLogs: false)), message: "password=secret",
            attributes: ["password": "secret"])
        #expect(out.message == "password=secret")
        #expect(out.attributes?["password"] as? String == "secret")
    }
}

@Suite struct RedactHookTests {
    private final class Fields: @unchecked Sendable {
        var all: [RedactField] = []
    }

    @Test func isCalledPerLeafWithTypedValuePathKindAndSensitiveFlag() throws {
        let fields = Fields()
        _ = redactObject(
            ["user": "bob", "nested": ["count": 3]],
            options(
                kind: .log,
                redact: { field in
                    fields.all.append(field)
                    return nil
                }))
        let user = try #require(fields.all.first { $0.key == "user" })
        #expect(user.value as? String == "bob")
        #expect(user.path == ["user"])
        #expect(user.kind == .log)
        #expect(!user.sensitive)
        let count = try #require(fields.all.first { $0.key == "count" })
        #expect(count.value as? Int == 3)
        #expect(count.path == ["nested", "count"])
    }

    @Test func isNeverCalledOnContainersOnlyLeaves() {
        let fields = Fields()
        _ = redactObject(
            ["a": ["b": ["c": "x"]]],
            options(redact: { field in
                fields.all.append(field)
                return nil
            }))
        #expect(fields.all.map { $0.value as? String } == ["x"])
    }

    @Test func canTransformTheOriginalValue() throws {
        let out = try object(
            redactBody(
                #"{"card":"4111111111111111"}"#,
                options(
                    kind: .requestBody,
                    redact: { field in
                        field.key == "card"
                            ? "****" + String("\(field.value ?? "")".suffix(4)) : nil
                    })))
        #expect(out["card"] as? String == "****1111")
    }

    @Test func redactsAFieldTheBuiltInsMiss() throws {
        let out = try object(
            redactBody(
                #"{"nickname":"bob"}"#,
                options(redact: { field in field.key == "nickname" ? redacted : nil })))
        #expect(out["nickname"] as? String == redacted)
    }

    @Test func defersToTheDefaultWhenItReturnsNil() throws {
        let out = try object(
            redactBody(#"{"password":"hunter2","user":"bob"}"#, options(redact: { _ in nil })))
        #expect(out["password"] as? String == redacted)
        #expect(out["user"] as? String == "bob")
    }

    @Test func neverSeesTheLeavesOfASensitiveKeysSubtree() throws {
        let fields = Fields()
        let out = try object(
            redactBody(
                #"{"credential":{"token":"x"}}"#,
                options(redact: { field in
                    fields.all.append(field)
                    return nil
                })))
        #expect(out["credential"] as? String == redacted)
        #expect(!fields.all.contains { $0.key == "token" })
    }

    @Test func fallsBackToTheBuiltInResultWhenItThrows() throws {
        struct Boom: Error {}
        let out = try object(
            redactBody(#"{"password":"hunter2"}"#, options(redact: { _ in throw Boom() })))
        #expect(out["password"] as? String == redacted)
    }

    @Test func receivesRequestBodyVersusResponseBodyKinds() {
        let fields = Fields()
        let collect: Redactor = { field in
            fields.all.append(field)
            return nil
        }
        _ = redactBody(#"{"a":"1"}"#, options(kind: .requestBody, redact: collect))
        _ = redactBody(#"{"a":"1"}"#, options(kind: .responseBody, redact: collect))
        #expect(fields.all.map(\.kind) == [.requestBody, .responseBody])
    }

    @Test func isCalledOnceWithTheWholeStringForUnstructuredText() {
        let fields = Fields()
        _ = redactText(
            "plain log line",
            options(
                kind: .log,
                redact: { field in
                    fields.all.append(field)
                    return nil
                }))
        #expect(fields.all.count == 1)
        #expect(fields.all.first?.key == "")
        #expect(fields.all.first?.value as? String == "plain log line")
    }

    @Test func aNonNilResultReplacesAWholeStringWhateverItsType() {
        #expect(redactText("token: abc", options(redact: { _ in 0 })) == "0")
        #expect(redactText("token: abc", options(redact: { _ in false })) == "false")
        #expect(redactText("token: abc", options(redact: { _ in nil })).contains(redacted))
    }

    @Test func runsInTheUserHookScope() {
        final class Seen: @unchecked Sendable { var running = false }
        let seen = Seen()
        _ = redactText(
            "plain",
            options(redact: { _ in
                seen.running = UserHook.isRunning
                return nil
            }))
        #expect(seen.running)
    }
}
