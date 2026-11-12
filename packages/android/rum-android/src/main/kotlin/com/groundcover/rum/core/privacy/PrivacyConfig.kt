package com.groundcover.rum.core.privacy

import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import com.groundcover.rum.Redactor

/** The privacy settings every capture path reads, resolved once from the `privacy` options. */
internal class EffectivePrivacy(
    val level: PrivacyLevel,
    /** The per-surface toggles, already false under [PrivacyLevel.ALLOW]. */
    val maskNetworkBodies: Boolean,
    val maskNetworkQueryParams: Boolean,
    val maskLogs: Boolean,
    val maskErrors: Boolean,
    val sensitiveKeys: List<String>,
    val redact: Redactor?,
    /** Mask tap labels. On under [PrivacyLevel.MASK_ALL] whatever the toggle says. */
    val maskInteractionLabels: Boolean
) {
    // The `level != allow && maskX` gates, in one place so no capture path re-derives them.
    val shouldMaskNetworkBodies get() = level != PrivacyLevel.ALLOW && maskNetworkBodies
    val shouldMaskNetworkQueryParams get() = level != PrivacyLevel.ALLOW && maskNetworkQueryParams
    val shouldMaskLogs get() = level != PrivacyLevel.ALLOW && maskLogs
    val shouldMaskErrors get() = level != PrivacyLevel.ALLOW && maskErrors
}

/** Trimmed, non-empty strings only. */
internal fun normalizeStringList(values: List<String>?): List<String> =
    values.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }

/**
 * Effective privacy from the provided options. An omitted level means
 * [PrivacyLevel.MASK_SENSITIVE], and every per-surface toggle defaults on unless the level is
 * [PrivacyLevel.ALLOW].
 */
internal fun resolvePrivacy(privacy: PrivacyOptions?): EffectivePrivacy {
    val level = privacy?.level ?: PrivacyLevel.MASK_SENSITIVE
    val isAllow = level == PrivacyLevel.ALLOW
    fun orDefaultOn(value: Boolean?) = if (isAllow) false else value ?: true

    return EffectivePrivacy(
        level = level,
        maskNetworkBodies = orDefaultOn(privacy?.maskNetworkBodies),
        maskNetworkQueryParams = orDefaultOn(privacy?.maskNetworkQueryParams),
        maskLogs = orDefaultOn(privacy?.maskLogs),
        maskErrors = orDefaultOn(privacy?.maskErrors),
        sensitiveKeys = normalizeStringList(privacy?.sensitiveKeys),
        redact = privacy?.redact,
        // As RN: mask-all always masks labels; the toggle only adds masking.
        maskInteractionLabels = level == PrivacyLevel.MASK_ALL ||
            privacy?.maskInteractionLabels == true
    )
}
