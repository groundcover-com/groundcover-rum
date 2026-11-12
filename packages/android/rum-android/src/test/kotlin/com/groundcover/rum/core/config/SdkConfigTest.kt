package com.groundcover.rum.core.config

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.GroundcoverOptions
import com.groundcover.rum.GroundcoverOptionsUpdate
import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RumEventName
import com.groundcover.rum.RumUser
import com.groundcover.rum.TracingOptions
import com.groundcover.rum.TracingOrigin
import com.groundcover.rum.TransportOptions
import com.groundcover.rum.UserUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The configuration the pipeline runs on: defaults, the DSN, the session cap, what an update may
// change and how it merges.

internal fun anInput(
    dsn: String = "ingest.example",
    user: RumUser? = null,
    options: GroundcoverOptions = GroundcoverOptions()
) = GroundcoverConfig(
    apiKey = "key",
    dsn = dsn,
    cluster = "cluster",
    environment = "env",
    appId = "app",
    user = user,
    options = options
)

internal fun anUpdate(
    cluster: String? = null,
    dsn: String? = null,
    environment: String? = null,
    releaseId: String? = null,
    user: UserUpdate? = null,
    options: GroundcoverOptionsUpdate? = null
) = GroundcoverConfigUpdate(
    dsn = dsn,
    cluster = cluster,
    environment = environment,
    releaseId = releaseId,
    user = user,
    options = options
)

class SdkConfigTest {
    @Test
    fun appliesTheCoreDefaults() {
        val options = SdkConfig(anInput()).options
        assertEquals(1.0, options.sessionSampleRate, 0.0)
        assertFalse(options.debug)
        assertTrue(options.enabledEvents.isEmpty())
        assertEquals(DEFAULT_SESSION_MAX_DURATION_MS, options.sessionMaxDurationMs)
        assertTrue(options.tracing.propagationUrls.isEmpty())
        assertEquals("", options.tracing.traceIdHeaderName)
        assertEquals("", options.tracing.origin.name)
        // resolvePrivacy owns the default, so it can tell an explicit level from an omitted one.
        assertNull(options.privacy.level)
    }

    @Test
    fun theEndpointGainsHttpsOnlyWhenTheDsnNamesNoScheme() {
        assertEquals("https://ingest.example", SdkConfig(anInput()).endpoint)
        assertEquals(
            "http://localhost:9393",
            SdkConfig(anInput(dsn = "http://localhost:9393")).endpoint
        )
    }

    @Test
    fun aSessionCapWithin1MinuteTo8HoursIsKeptBothEndsIncluded() {
        for (ms in listOf(60_000L, 6 * 3_600_000L, 8 * 3_600_000L)) {
            val options = SdkConfig(
                anInput(options = GroundcoverOptions(sessionMaxDurationMs = ms))
            ).options
            assertEquals(ms, options.sessionMaxDurationMs)
        }
    }

    @Test
    fun aSessionCapOutsideThatRangeFallsBackTo4Hours() {
        for (ms in listOf(59_000L, 9 * 3_600_000L, 0L, -1L)) {
            val options = SdkConfig(
                anInput(options = GroundcoverOptions(sessionMaxDurationMs = ms))
            ).options
            assertEquals("$ms", DEFAULT_SESSION_MAX_DURATION_MS, options.sessionMaxDurationMs)
        }
    }

    @Test
    fun theSessionCapIsKeptWhenAnUpdateOmitsItOrBringsAValueOutOfRange() {
        val config = SdkConfig(
            anInput(options = GroundcoverOptions(sessionMaxDurationMs = 2 * 3_600_000L))
        )
        config.update(anUpdate(options = GroundcoverOptionsUpdate(debug = true)))
        assertEquals(2 * 3_600_000L, config.options.sessionMaxDurationMs)
        config.update(
            anUpdate(options = GroundcoverOptionsUpdate(sessionMaxDurationMs = 12 * 3_600_000L))
        )
        // Out of range: the session keeps the cap it runs on, not a default the app never chose.
        assertEquals(2 * 3_600_000L, config.options.sessionMaxDurationMs)
        config.update(
            anUpdate(options = GroundcoverOptionsUpdate(sessionMaxDurationMs = 3_600_000L))
        )
        assertEquals(3_600_000L, config.options.sessionMaxDurationMs)
    }

    @Test
    fun anUpdateMergesAPartialTracingOriginAndKeepsItsSiblingField() {
        val config = SdkConfig(
            anInput(
                options = GroundcoverOptions(
                    tracing = TracingOptions(
                        propagationUrls = listOf("https://a/*"),
                        origin = TracingOrigin("n", "v")
                    )
                )
            )
        )
        config.update(
            anUpdate(
                options = GroundcoverOptionsUpdate(
                    tracing = TracingOptions(traceIdHeaderName = "x-trace")
                )
            )
        )
        val tracing = config.options.tracing
        assertEquals(listOf("https://a/*"), tracing.propagationUrls)
        assertEquals("x-trace", tracing.traceIdHeaderName)
        assertEquals("n", tracing.origin.name)
    }

    @Test
    fun anUpdateReplacesListsWholesale() {
        val config = SdkConfig(
            anInput(
                options = GroundcoverOptions(
                    tracing = TracingOptions(propagationUrls = listOf("a", "b"))
                )
            )
        )
        config.update(
            anUpdate(
                options = GroundcoverOptionsUpdate(
                    tracing = TracingOptions(propagationUrls = listOf("c"))
                )
            )
        )
        assertEquals(listOf("c"), config.options.tracing.propagationUrls)
    }

    @Test
    fun anUpdateMergesAPartialPrivacyInsteadOfReplacingIt() {
        val config = SdkConfig(
            anInput(
                options = GroundcoverOptions(
                    privacy = PrivacyOptions(
                        level = PrivacyLevel.MASK_ALL,
                        sensitiveKeys = listOf("order_id")
                    )
                )
            )
        )
        config.update(
            anUpdate(
                options = GroundcoverOptionsUpdate(privacy = PrivacyOptions(maskLogs = false))
            )
        )
        assertEquals(PrivacyLevel.MASK_ALL, config.options.privacy.level)
        assertEquals(listOf("order_id"), config.options.privacy.sensitiveKeys)
        assertEquals(false, config.options.privacy.maskLogs)
    }

    @Test
    fun anUpdateMergesTransportFieldByField() {
        val config = SdkConfig(
            anInput(options = GroundcoverOptions(transport = TransportOptions(batchSize = 5)))
        )
        config.update(
            anUpdate(
                options = GroundcoverOptionsUpdate(
                    transport = TransportOptions(compression = false)
                )
            )
        )
        assertEquals(5, config.options.transport.batchSize)
        assertEquals(false, config.options.transport.compression)
    }

    @Test
    fun whatInitFixesSurvivesAnUpdate() {
        val config = SdkConfig(
            anInput(
                options = GroundcoverOptions(
                    enabledEvents = listOf(RumEventName.CRASHES),
                    sessionSampleRate = 0.25,
                    appVersion = "1.2.3"
                )
            )
        )
        config.update(anUpdate(options = GroundcoverOptionsUpdate(debug = true)))
        assertEquals(listOf(RumEventName.CRASHES), config.options.enabledEvents)
        assertEquals(0.25, config.options.sessionSampleRate, 0.0)
        assertEquals("1.2.3", config.options.appVersion)
        assertTrue(config.options.debug)
    }

    @Test
    fun aPartialUserMergesIsKeptWhenOmittedAndIsClearedOnRequest() {
        val config = SdkConfig(anInput(user = RumUser(id = "u1", email = "a@b")))
        config.update(anUpdate(user = UserUpdate.set(RumUser(name = "Ann"))))
        assertEquals("u1", config.user?.id)
        assertEquals("a@b", config.user?.email)
        assertEquals("Ann", config.user?.name)

        config.update(anUpdate(cluster = "c2"))
        assertEquals("u1", config.user?.id)

        config.update(anUpdate(user = UserUpdate.clear()))
        assertNull(config.user)
    }

    @Test
    fun userPropertiesAreMadeJsonOnceAsTheyAreSet() {
        // Every batch envelope carries them: an app object would be encoded again each time, and
        // a cycle would fail every batch.
        class Profile {
            override fun toString() = "profile #7"
        }
        val loop = mutableMapOf<String, Any?>("a" to 1)
        loop["self"] = loop
        val config = SdkConfig(
            anInput(
                user = RumUser(
                    id = "u1",
                    properties = mapOf("profile" to Profile(), "loop" to loop)
                )
            )
        )
        val properties = config.user?.properties!!
        assertEquals("profile #7", properties["profile"])
        assertEquals("[Circular]", (properties["loop"] as Map<*, *>)["self"])

        config.update(
            anUpdate(user = UserUpdate.set(RumUser(properties = mapOf("plan" to Profile()))))
        )
        assertEquals("u1", config.user?.id)
        assertEquals("profile #7", config.user?.properties?.get("plan"))
        assertNull(config.user?.properties?.get("profile"))
    }

    @Test
    fun identityFieldsChangeOnlyWhenGivenAndNonEmpty() {
        val config = SdkConfig(anInput())
        config.update(anUpdate(dsn = "other.example", environment = "", releaseId = "abc123"))
        assertEquals("other.example", config.dsn)
        assertEquals("env", config.environment)
        assertEquals("abc123", config.releaseId)
        assertEquals("cluster", config.cluster)
    }

    @Test
    fun anEventIsEnabledWhenTheListNamesItOrIsEmpty() {
        assertTrue(isEventEnabled(emptyList(), RumEventName.LOGS))
        assertTrue(isEventEnabled(null, RumEventName.LOGS))
        assertTrue(isEventEnabled(listOf(RumEventName.LOGS), RumEventName.LOGS))
        assertFalse(isEventEnabled(listOf(RumEventName.CRASHES), RumEventName.LOGS))
    }
}
