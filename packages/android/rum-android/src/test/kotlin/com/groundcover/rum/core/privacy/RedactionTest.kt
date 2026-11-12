package com.groundcover.rum.core.privacy

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RedactField
import com.groundcover.rum.RedactKind
import com.groundcover.rum.Redactor
import com.groundcover.rum.core.common.UserHook
import com.groundcover.rum.core.common.parseOrderedJson
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The sensitive-data patterns and the redaction every capture path shares, identical to the other
// SDKs' so every SDK masks the same strings.

private fun parseQuery(query: String): Map<String, String> {
    val values = LinkedHashMap<String, String>()
    for (pair in query.removePrefix("?").split("&")) {
        if (pair.isEmpty()) continue
        val eq = pair.indexOf('=')
        fun decode(raw: String) = URLDecoder.decode(raw, "UTF-8")
        val key = decode(if (eq == -1) pair else pair.substring(0, eq))
        values.putIfAbsent(key, if (eq == -1) "" else decode(pair.substring(eq + 1)))
    }
    return values
}

private const val ENCODED_REDACTED = "%5BREDACTED%5D"

private fun parsed(json: String): Map<*, *> = parseOrderedJson(json) as Map<*, *>

private fun options(
    kind: RedactKind? = null,
    sensitiveKeys: List<String> = emptyList(),
    redact: Redactor? = null
) = RedactOptions(sensitiveKeys = sensitiveKeys, redact = redact, kind = kind)

class SensitiveKeyTest {
    @Test
    fun matchesBuiltInSensitivePatterns() {
        for (key in listOf(
            "password",
            "user_token",
            "apiKey",
            "api-key",
            "Authorization",
            "creditCard",
            "cardNumber"
        )) {
            assertTrue(key, isSensitiveKey(key))
        }
    }

    @Test
    fun doesNotOverMatchInnocuousKeys() {
        for (key in listOf("cardinality", "session_id", "username", "email")) {
            assertFalse(key, isSensitiveKey(key))
        }
    }

    @Test
    fun honorsExtraKeys() {
        assertTrue(isSensitiveKey("ssn"))
        assertTrue(isSensitiveKey("internal_ref", listOf("internal_ref")))
        assertFalse(isSensitiveKey("internal_ref"))
    }
}

class RedactHeadersTest {
    @Test
    fun redactsSensitiveHeaderNamesAndPatternsAndKeepsOthers() {
        val result = redactHeaders(
            mapOf(
                "Authorization" to "Bearer abc",
                "Cookie" to "sid=1",
                "x-api-token" to "secret",
                "Content-Type" to "application/json",
                "Accept" to "*/*"
            )
        )
        assertEquals(REDACTED, result["Authorization"])
        assertEquals(REDACTED, result["Cookie"])
        assertEquals(REDACTED, result["x-api-token"])
        assertEquals("application/json", result["Content-Type"])
        assertEquals("*/*", result["Accept"])
    }

    @Test
    fun redactsHeaderNamesContainingABareKeySubstring() {
        val result = redactHeaders(
            mapOf("x-functions-key" to "abc", "x-encryption-key" to "def", "x-key" to "ghi")
        )
        assertEquals(
            mapOf(
                "x-functions-key" to REDACTED,
                "x-encryption-key" to REDACTED,
                "x-key" to REDACTED
            ),
            result
        )
    }
}

class RedactQueryStringTest {
    @Test
    fun redactsSensitiveParamsAndPreservesTheRest() {
        val params = parseQuery(redactQueryString("user=bob&token=abc123&page=2"))
        assertEquals("bob", params["user"])
        assertEquals(REDACTED, params["token"])
        assertEquals("2", params["page"])
    }

    @Test
    fun returnsTheInputUnchangedWhenNothingIsSensitive() {
        assertEquals("a=1&b=2", redactQueryString("a=1&b=2"))
    }

    @Test
    fun preservesRepeatedKeys() {
        assertEquals(
            "token=$ENCODED_REDACTED&token=$ENCODED_REDACTED&user=x",
            redactQueryString("token=a&token=b&user=x")
        )
    }

    @Test
    fun redactsOAuthParamsByExactKey() {
        val params = parseQuery(
            redactQueryString("code=authcode123&state=csrf456&session_state=s789&page=2")
        )
        assertEquals(REDACTED, params["code"])
        assertEquals(REDACTED, params["state"])
        assertEquals(REDACTED, params["session_state"])
        assertEquals("2", params["page"])
    }

    @Test
    fun doesNotRedactParamsThatMerelyContainCodeOrState() {
        val params = parseQuery(redactQueryString("zipcode=90210&statename=CA&mode=dark"))
        assertEquals("90210", params["zipcode"])
        assertEquals("CA", params["statename"])
        assertEquals("dark", params["mode"])
    }

    @Test
    fun aRedactedValueIsWrittenBackAsEncodeURIComponentWritesIt() {
        val out = redactQueryString(
            "q=a b",
            options(redact = { field -> if (field.key == "q") "x y/z?é" else null })
        )
        assertEquals("q=x%20y%2Fz%3F%C3%A9", out)
    }
}

class RedactUrlTest {
    @Test
    fun redactsQueryParamsAndKeepsPathAndFragment() {
        val out = redactUrl("https://x.com/p?token=abc&q=1#frag")
        assertTrue(out.contains("https://x.com/p?"))
        assertTrue(out.contains("token=$ENCODED_REDACTED"))
        assertTrue(out.contains("q=1"))
        assertTrue(out.contains("#frag"))
    }

    @Test
    fun leavesUrlsWithoutAQueryUntouched() {
        assertEquals("https://x.com/path", redactUrl("https://x.com/path"))
    }

    @Test
    fun redactsAnOAuthAuthorizationCodeCallbackUrl() {
        val out = redactUrl("https://app.com/?code=authcode123&state=csrf456&page=2")
        assertFalse(out.contains("authcode123"))
        assertFalse(out.contains("csrf456"))
        assertTrue(out.contains("page=2"))
    }

    @Test
    fun redactsAQueryInsideTheFragmentAfterARealQuery() {
        val out = redactUrl("https://app.com/path?a=1#/reset?token=SUPERSECRET&section=2")
        assertFalse(out.contains("SUPERSECRET"))
        assertTrue(out.contains("a=1"))
        assertTrue(out.contains("section=2"))
        assertTrue(out.contains("#/reset?"))
    }

    @Test
    fun redactsAQueryInsideTheFragmentWithNoQueryBeforeIt() {
        val out = redactUrl("https://app.com/#/auth?access_token=SUPERSECRET")
        assertFalse(out.contains("SUPERSECRET"))
        assertTrue(out.contains("#/auth?"))
    }

    @Test
    fun stripsEmbeddedUserinfo() {
        val out = redactUrl("https://admin:s3cr3t@internal.api/data?x=1")
        assertFalse(out.contains("s3cr3t"))
        assertFalse(out.contains("admin:"))
        assertTrue(out.contains("@internal.api/data"))
        assertTrue(out.contains("x=1"))
    }

    @Test
    fun doesNotTreatAnAtInTheQueryAsUserinfo() {
        assertTrue(redactUrl("https://x.com/p?email=a@b.com").contains("a@b.com"))
    }
}

class RedactBodyTest {
    @Test
    fun deepRedactsJsonObjectBodies() {
        val out = parsed(
            redactBody("""{"user":"bob","password":"hunter2","nested":{"token":"t"}}""")
        )
        assertEquals("bob", out["user"])
        assertEquals(REDACTED, out["password"])
        assertEquals(REDACTED, (out["nested"] as Map<*, *>)["token"])
    }

    @Test
    fun keepsTheBodysKeyOrderAsJSONStringifyDoes() {
        assertEquals(
            """{"z":1,"password":"[REDACTED]","a":{"y":2,"b":3}}""",
            redactBody("""{"z":1,"password":"x","a":{"y":2,"b":3}}""")
        )
    }

    @Test
    fun aHookValueJsonHasNoFormForNeverReopensTheBody() {
        val keys = mutableListOf<String>()
        val out = redactBody(
            """{"amount":5,"tokens":["tok_A","tok_B"],"password":{"x":"p1"}}""",
            options(redact = { field ->
                keys.add(field.key)
                if (field.key == "amount") Double.NaN else null
            })
        )
        // As JSON.stringify writes NaN; the sensitive keys stay redacted whole.
        assertEquals("""{"amount":null,"tokens":"[REDACTED]","password":"[REDACTED]"}""", out)
        assertFalse("no whole-body second pass", keys.contains(""))
    }

    @Test
    fun writesJsonNumbersBackAsJSONStringifyDoes() {
        assertEquals(
            """{"amount":1,"e":1000,"x":1.5,"n":[2],"tiny":1.5e-7,"big":1e+21}""",
            redactBody(
                """{"amount": 1.0, "e": 1e3, "x": 1.5, "n": [2.0], "tiny": 1.5e-7, "big": 1e21}"""
            )
        )
    }

    @Test
    fun writesStringsBackAsJSONStringifyDoes() {
        assertEquals(
            """{"path":"a/b","quote":"say \"hi\"","line":"a\nb","é":"é"}""",
            redactBody(
                """{"path":"a/b","quote":"say \"hi\"","line":"a\nb","é":"é"}"""
            )
        )
    }

    @Test
    fun redactsJsonInsideArrays() {
        assertEquals(
            """[{"secret":"[REDACTED]"},{"ok":"y"}]""",
            redactBody("""[{"secret":"x"},{"ok":"y"}]""")
        )
    }

    @Test
    fun redactsFormEncodedBodies() {
        val params = parseQuery(redactBody("grant_type=password&password=secret&user=bob"))
        assertEquals(REDACTED, params["password"])
        assertEquals("bob", params["user"])
    }

    @Test
    fun redactsAWriteKeyInAJsonBody() {
        val out = parsed(
            redactBody("""{"writeKey":"test-write-key-0000000000","event":"track"}""")
        )
        assertEquals(REDACTED, out["writeKey"])
        assertEquals("track", out["event"])
    }

    @Test
    fun doesNotRedactGenericCodeOrStateKeysInsideJsonBodies() {
        val out = parsed(redactBody("""{"code":200,"state":"open","user":"bob"}"""))
        assertEquals(200L, out["code"])
        assertEquals("open", out["state"])
    }

    @Test
    fun fallsBackToTheFreeTextScrubForNonJson() {
        assertTrue(redactBody("login failed for token: abc123").contains(REDACTED))
    }

    @Test
    fun boundsDeepNestingAndNeverLeaksBelowTheDepthCap() {
        var deep = """{"password":"x"}"""
        repeat(50) { deep = """{"nested":$deep}""" }
        assertFalse(redactBody(deep).contains(""""password":"x""""))
    }

    @Test
    fun preservesArrayLength() {
        val body = (0 until 5000).joinToString(",", "[", "]") { """{"i":$it}""" }
        assertEquals(5000, (parseOrderedJson(redactBody(body)) as List<*>).size)
    }

    @Test
    fun fallsBackToATextScrubForOversizedJsonBodies() {
        val filler = "x".repeat(200_000)
        val out = redactBody("""{"password":"secret","note":"$filler"}""")
        assertTrue(out.contains(REDACTED))
        assertFalse(out.contains("secret"))
    }

    @Test
    fun returnsEmptyInputUnchanged() {
        assertEquals("", redactBody(""))
    }

    @Test
    fun aBodyNestedPastTheDepthLimitIsRedactedWhole() {
        // Past the parse limit (64 levels) the text scrub can't be trusted with it: its unquoted
        // value runs `{"a":{"a":…{"password":"hunter2"` together under a harmless key.
        val deep = "{\"a\":".repeat(1000) + "{\"password\":\"hunter2\"}" + "}".repeat(1000)
        assertEquals(REDACTED, redactBody(deep))
    }

    @Test
    fun aBodyNestedExactlyToTheDepthLimitKeepsItsPasswordRedacted() {
        // One level short of being redacted whole, so it must parse: the text scrub would miss it.
        val body = "{\"a\":".repeat(63) + "{\"password\":\"hunter2\"}" + "}".repeat(63)
        assertFalse(redactBody(body).contains("hunter2"))
    }

    @Test
    fun aNumberPastTheDoubleRangeReadsAsJavaScriptReadsIt() {
        // JSON.parse reads 1e999 as Infinity, and JSON.stringify writes that as null.
        assertEquals(
            "{\"profile\":{\"password\":\"[REDACTED]\"},\"n\":null}",
            redactBody("{\"profile\":{\"password\":\"hunter2\"},\"n\":1e999}")
        )
    }
}

class RedactTextTest {
    @Test
    fun scrubsAKeyOnlyTheAppCallsSensitiveAndLeavesTheRest() {
        val opts = options(sensitiveKeys = listOf("order_id"))
        assertEquals("order_id=[REDACTED] for bob", redactText("order_id=42 for bob", opts))
        assertEquals("cart has 3 items, total 42", redactText("cart has 3 items, total 42", opts))
    }

    @Test
    fun scrubsKeyValueAndKeyColonValuePairs() {
        assertTrue(redactText("password=secret").contains(REDACTED))
        assertTrue(redactText("token: abc123").contains(REDACTED))
    }

    @Test
    fun leavesNonSensitiveTextUntouched() {
        assertEquals("user logged in successfully", redactText("user logged in successfully"))
    }

    @Test
    fun redactsTheWholeValueAfterASpace() {
        val out = redactText("Authorization: Bearer eyJtoken123")
        assertFalse(out.contains("eyJtoken123"))
        assertFalse(out.contains("Bearer"))
        assertTrue(out.contains(REDACTED))
    }

    @Test
    fun redactsASensitivePairInsideAPrintedMap() {
        // A printed map nests pairs: a harmless label before it must not swallow them.
        val headers = redactText(
            "Request headers: {Authorization: Bearer eyJ.abc.def, Accept: application/json}"
        )
        assertFalse(headers.contains("eyJ.abc.def"))
        assertTrue(headers.contains("Accept: application/json"))
        val user = redactText("User: {token: abc123, name: bob}")
        assertFalse(user.contains("abc123"))
        assertTrue(user.contains("name: bob"))
        assertFalse(redactText("ctx: {req: {headers: {x_auth: s3cr3t}}}").contains("s3cr3t"))
    }

    @Test
    fun doesNotBleedPastALineBoundary() {
        val out = redactText("token: abc123\nstatus: ok")
        assertFalse(out.contains("abc123"))
        assertTrue(out.contains("status: ok"))
    }

    @Test
    fun redactsOAuthCodeAndStateInQueryShapedFreeText() {
        val out = redactText("callback code=oauthcode123&state=csrf456&page=2")
        assertFalse(out.contains("oauthcode123"))
        assertFalse(out.contains("csrf456"))
        assertTrue(out.contains("page=2"))
    }

    @Test
    fun doesNotRedactCodeOrStateColonsInPlainLogLines() {
        val out = redactText("request finished code: 200 state: idle")
        assertTrue(out.contains("200"))
        assertTrue(out.contains("idle"))
    }

    @Test
    fun redactsHeaderStyleBareKeyNames() {
        val out = redactText("x-functions-key: supersecret")
        assertFalse(out.contains("supersecret"))
        assertTrue(out.contains(REDACTED))
    }

    @Test
    fun redactsASensitivePairEmbeddedAfterAHarmlessKey() {
        val out = redactText("navigated to /login?next=/home?token=SUPERSECRET")
        assertFalse(out.contains("SUPERSECRET"))
        assertTrue(out.contains(REDACTED))
    }

    @Test
    fun boundsWorkOnOversizedInput() {
        val out = redactText("a".repeat(200_000) + " token=SUPERSECRET")
        assertFalse(out.contains("SUPERSECRET"))
        assertTrue(out.endsWith("…"))
    }

    @Test
    fun aValueOfTensOfThousandsOfEscapesNeitherOverflowsTheStackNorLeaks() {
        // The JVM's regex engine recurses once per escape in a quoted value; past what the stack
        // holds the whole text is redacted.
        val escapes = "\\\"".repeat(40_000)
        val out = redactText("\"token\":\"$escapes\"")
        assertFalse(out.contains("\\\"\\\""))
    }

    @Test
    fun aWordCharacterIsAsciiAsInJavaScript() {
        // `\w` is ASCII in JavaScript and Unicode in ICU, Android's regex engine: "é" must not
        // join the key, which leaves `code`, a sensitive query key on its own.
        assertEquals("écode=[REDACTED]", redactText("écode=123"))
    }
}

class RedactObjectTest {
    @Test
    fun deepRedactsWithoutMutatingTheInput() {
        val nested = mutableMapOf<String, Any?>("token" to "t")
        val input = mapOf("a" to "1", "secret" to "x", "nested" to nested)
        val out = redactObject(input)
        assertEquals(REDACTED, out["secret"])
        assertEquals(REDACTED, (out["nested"] as Map<*, *>)["token"])
        assertEquals("x", input["secret"])
        assertEquals("t", nested["token"])
    }

    @Test
    fun terminatesOnACycle() {
        val a = mutableMapOf<String, Any?>("name" to "a")
        val b = mutableMapOf<String, Any?>("name" to "b", "a" to a)
        a["b"] = b
        val out = redactObject(a)
        assertEquals("a", out["name"])
        assertEquals(REDACTED, (out["b"] as Map<*, *>)["a"])
    }

    @Test
    fun walksAMapSharedBetweenSiblings() {
        val shared = mapOf("city" to "NYC")
        val out = redactObject(mapOf("home" to shared, "work" to shared))
        assertEquals("NYC", (out["home"] as Map<*, *>)["city"])
        assertEquals("NYC", (out["work"] as Map<*, *>)["city"])
    }

    @Test
    fun stringifiesAValueThatIsNeitherAContainerNorAPrimitive() {
        class Profile {
            override fun toString() = "profile #7"
        }
        assertEquals("profile #7", redactObject(mapOf("when" to Profile()))["when"])
    }

    @Test
    fun setsAndArraysAreWalkedLikeLists() {
        val login = mapOf("user" to "bob", "password" to "hunter2")
        val out = redactObject(
            mapOf("logins" to setOf(login), "ids" to intArrayOf(1, 2), "tags" to arrayOf("a"))
        )
        assertEquals(listOf(mapOf("user" to "bob", "password" to REDACTED)), out["logins"])
        assertEquals(listOf(1, 2), out["ids"])
        assertEquals(listOf("a"), out["tags"])
    }

    @Test
    fun aStringifiedObjectIsScrubbedAsText() {
        data class Payment(val amount: Int, val password: String)
        val payment = Payment(amount = 12, password = "hunter2")
        val log = redactLogFields(resolvePrivacy(null), "checkout", mapOf("request" to payment))
        val metadata = redactMetadata(mapOf("request" to payment), resolvePrivacy(null))
        for (value in listOf(log.attributes?.get("request"), metadata?.get("request"))) {
            assertEquals("Payment(amount=12, password=$REDACTED", value)
            assertFalse((value as String).contains(payment.password))
        }
    }
}

class RedactMetadataTest {
    @Test
    fun keyRedactsMetadataWhileMasking() {
        val out = redactMetadata(mapOf("password" to "x", "step" to 2), resolvePrivacy(null))
        assertEquals(REDACTED, out?.get("password"))
        assertEquals(2, out?.get("step"))
    }

    @Test
    fun appliesTheUsersSensitiveKeys() {
        val out = redactMetadata(
            mapOf("tenant" to "acme"),
            resolvePrivacy(PrivacyOptions(sensitiveKeys = listOf("tenant")))
        )
        assertEquals(REDACTED, out?.get("tenant"))
    }

    @Test
    fun returnsMetadataUntouchedUnderAllowAndPassesNilThrough() {
        val metadata = mapOf("password" to "x")
        val out =
            redactMetadata(metadata, resolvePrivacy(PrivacyOptions(level = PrivacyLevel.ALLOW)))
        assertEquals("x", out?.get("password"))
        assertNull(redactMetadata(null, resolvePrivacy(null)))
    }
}

class RedactLogFieldsTest {
    @Test
    fun masksMessageTextAndAttributeValues() {
        val out = redactLogFields(
            resolvePrivacy(null),
            "login password=secret",
            mapOf("password" to "secret", "user" to "bob")
        )
        assertEquals("login password=[REDACTED]", out.message)
        assertEquals(REDACTED, out.attributes?.get("password"))
        assertEquals("bob", out.attributes?.get("user"))
    }

    @Test
    fun isANoOpWhenLogMaskingIsOff() {
        val out = redactLogFields(
            resolvePrivacy(PrivacyOptions(maskLogs = false)),
            "password=secret",
            mapOf("password" to "secret")
        )
        assertEquals("password=secret", out.message)
        assertEquals("secret", out.attributes?.get("password"))
    }
}

class RedactHookTest {
    @Test
    fun isCalledPerLeafWithTypedValuePathKindAndSensitiveFlag() {
        val fields = mutableListOf<RedactField>()
        redactObject(
            mapOf("user" to "bob", "nested" to mapOf("count" to 3)),
            options(kind = RedactKind.LOG, redact = { field ->
                fields.add(field)
                null
            })
        )
        val user = fields.first { it.key == "user" }
        assertEquals("bob", user.value)
        assertEquals(listOf("user"), user.path)
        assertEquals(RedactKind.LOG, user.kind)
        assertFalse(user.sensitive)
        val count = fields.first { it.key == "count" }
        assertEquals(3, count.value)
        assertEquals(listOf("nested", "count"), count.path)
    }

    @Test
    fun isNeverCalledOnContainersOnlyLeaves() {
        val fields = mutableListOf<RedactField>()
        redactObject(
            mapOf("a" to mapOf("b" to mapOf("c" to "x"))),
            options(redact = { field ->
                fields.add(field)
                null
            })
        )
        assertEquals(listOf("x"), fields.map { it.value })
    }

    @Test
    fun canTransformTheOriginalValue() {
        val out = parsed(
            redactBody(
                """{"card":"4111111111111111"}""",
                options(kind = RedactKind.REQUEST_BODY, redact = { field ->
                    if (field.key == "card") "****" + "${field.value}".takeLast(4) else null
                })
            )
        )
        assertEquals("****1111", out["card"])
    }

    @Test
    fun redactsAFieldTheBuiltInsMiss() {
        val out = parsed(
            redactBody(
                """{"nickname":"bob"}""",
                options(redact = { field -> if (field.key == "nickname") REDACTED else null })
            )
        )
        assertEquals(REDACTED, out["nickname"])
    }

    @Test
    fun defersToTheDefaultWhenItReturnsNil() {
        val out = parsed(
            redactBody("""{"password":"hunter2","user":"bob"}""", options(redact = { null }))
        )
        assertEquals(REDACTED, out["password"])
        assertEquals("bob", out["user"])
    }

    @Test
    fun neverSeesTheLeavesOfASensitiveKeysSubtree() {
        val fields = mutableListOf<RedactField>()
        val out = parsed(
            redactBody(
                """{"credential":{"token":"x"}}""",
                options(redact = { field ->
                    fields.add(field)
                    null
                })
            )
        )
        assertEquals(REDACTED, out["credential"])
        assertFalse(fields.any { it.key == "token" })
    }

    @Test
    fun fallsBackToTheBuiltInResultWhenItThrows() {
        val out = parsed(
            redactBody(
                """{"password":"hunter2"}""",
                options(redact = { throw IllegalStateException("boom") })
            )
        )
        assertEquals(REDACTED, out["password"])
    }

    @Test
    fun receivesRequestBodyVersusResponseBodyKinds() {
        val fields = mutableListOf<RedactField>()
        val collect = Redactor { field ->
            fields.add(field)
            null
        }
        redactBody("""{"a":"1"}""", options(kind = RedactKind.REQUEST_BODY, redact = collect))
        redactBody("""{"a":"1"}""", options(kind = RedactKind.RESPONSE_BODY, redact = collect))
        assertEquals(
            listOf(RedactKind.REQUEST_BODY, RedactKind.RESPONSE_BODY),
            fields.map {
                it.kind
            }
        )
    }

    @Test
    fun isCalledOnceWithTheWholeStringForUnstructuredText() {
        val fields = mutableListOf<RedactField>()
        redactText(
            "plain log line",
            options(kind = RedactKind.LOG, redact = { field ->
                fields.add(field)
                null
            })
        )
        assertEquals(1, fields.size)
        assertEquals("", fields.single().key)
        assertEquals("plain log line", fields.single().value)
    }

    @Test
    fun aNonNilResultReplacesAWholeStringWhateverItsType() {
        assertEquals("0", redactText("token: abc", options(redact = { 0 })))
        assertEquals("false", redactText("token: abc", options(redact = { false })))
        assertTrue(redactText("token: abc", options(redact = { null })).contains(REDACTED))
    }

    @Test
    fun runsInTheUserHookScope() {
        var running = false
        redactText(
            "plain",
            options(redact = {
                running = UserHook.isRunning
                null
            })
        )
        assertTrue(running)
    }
}
