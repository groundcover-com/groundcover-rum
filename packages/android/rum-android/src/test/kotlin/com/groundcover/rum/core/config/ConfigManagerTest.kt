package com.groundcover.rum.core.config

import com.groundcover.rum.GroundcoverOptionsUpdate
import com.groundcover.rum.PrivacyLevel
import com.groundcover.rum.PrivacyOptions
import org.junit.Assert.assertEquals
import org.junit.Test

class ConfigManagerTest {
    @Test
    fun holdsTheConfigurationItWasBuiltWithAndItsUpdates() {
        val manager = ConfigManager(anInput())
        assertEquals("app", manager.config.appId)
        manager.update(anUpdate(cluster = "c2"))
        assertEquals("c2", manager.config.cluster)
    }

    @Test
    fun reResolvesPrivacyAfterAnUpdate() {
        val manager = ConfigManager(anInput())
        assertEquals(PrivacyLevel.MASK_SENSITIVE, manager.privacy.level)
        manager.update(
            anUpdate(
                options = GroundcoverOptionsUpdate(
                    privacy = PrivacyOptions(level = PrivacyLevel.ALLOW)
                )
            )
        )
        assertEquals(PrivacyLevel.ALLOW, manager.privacy.level)
    }
}
