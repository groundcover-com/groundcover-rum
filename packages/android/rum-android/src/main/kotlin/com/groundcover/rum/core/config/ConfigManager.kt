package com.groundcover.rum.core.config

import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.GroundcoverConfigUpdate
import com.groundcover.rum.core.privacy.EffectivePrivacy
import com.groundcover.rum.core.privacy.resolvePrivacy

/**
 * Holds the configuration, memoises the resolved privacy, and applies updates. Session identity
 * lives in the session state.
 */
internal class ConfigManager(input: GroundcoverConfig) {
    val config = SdkConfig(input)
    private var resolvedPrivacy: EffectivePrivacy? = null

    /** Read on every captured event, so memoised; an update drops the memo. */
    val privacy: EffectivePrivacy
        get() = resolvedPrivacy ?: resolvePrivacy(config.options.privacy).also {
            resolvedPrivacy = it
        }

    fun update(update: GroundcoverConfigUpdate) {
        config.update(update)
        resolvedPrivacy = null
    }
}
