package com.groundcover.rum.core.privacy

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.RedactField
import com.groundcover.rum.RedactKind
import com.groundcover.rum.Redactor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ResolvePrivacyTest {
    @Test
    fun defaultsToMaskSensitiveWithEveryToggleOn() {
        val privacy = resolvePrivacy(null)
        assertEquals(PrivacyLevel.MASK_SENSITIVE, privacy.level)
        assertTrue(privacy.shouldMaskNetworkBodies)
        assertTrue(privacy.shouldMaskNetworkQueryParams)
        assertTrue(privacy.shouldMaskLogs)
        assertTrue(privacy.shouldMaskErrors)
        assertFalse(privacy.maskInteractionLabels)
    }

    @Test
    fun turnsEveryToggleOffUnderAllowEvenWhenSetOn() {
        val privacy = resolvePrivacy(PrivacyOptions(level = PrivacyLevel.ALLOW, maskLogs = true))
        assertFalse(privacy.maskLogs)
        assertFalse(privacy.shouldMaskLogs)
        assertFalse(privacy.shouldMaskNetworkBodies)
    }

    @Test
    fun letsEachToggleBeOverriddenOnItsOwn() {
        val privacy = resolvePrivacy(PrivacyOptions(maskNetworkBodies = false))
        assertFalse(privacy.shouldMaskNetworkBodies)
        assertTrue(privacy.shouldMaskNetworkQueryParams)
    }

    @Test
    fun masksInteractionLabelsUnderMaskAllOrWhenAskedTo() {
        assertTrue(
            resolvePrivacy(PrivacyOptions(level = PrivacyLevel.MASK_ALL)).maskInteractionLabels
        )
        // As RN: mask-all can't be talked out of masking labels.
        assertTrue(
            resolvePrivacy(
                PrivacyOptions(level = PrivacyLevel.MASK_ALL, maskInteractionLabels = false)
            ).maskInteractionLabels
        )
        assertTrue(
            resolvePrivacy(PrivacyOptions(maskInteractionLabels = true)).maskInteractionLabels
        )
    }

    @Test
    fun carriesTrimmedNonBlankSensitiveKeysAndTheRedactHook() {
        val hook = Redactor { "hooked" }
        val privacy = resolvePrivacy(
            PrivacyOptions(sensitiveKeys = listOf(" order_id ", "", "  "), redact = hook)
        )
        assertEquals(listOf("order_id"), privacy.sensitiveKeys)
        val field = RedactField("k", "v", listOf("k"), RedactKind.LOG, false)
        assertEquals("hooked", privacy.redact?.redact(field))
    }
}
