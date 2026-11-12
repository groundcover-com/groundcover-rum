package com.groundcover.rum.core.platform

import android.content.Context
import com.groundcover.rum.GroundcoverConfig
import com.groundcover.rum.core.common.systemClock
import com.groundcover.rum.core.pipeline.PlatformServices
import com.groundcover.rum.core.pipeline.ThreadExecutor

/** What the pipeline runs on in an app: the device's storage, clock, network and core thread. */
internal fun devicePlatform(context: Context, config: GroundcoverConfig): PlatformServices {
    val device = DeviceAttributes(
        context,
        config.appId,
        config.options.appVersion,
        config.options.appBuild
    )
    return PlatformServices(
        storage = SharedPreferencesStorage(context),
        clock = systemClock,
        sender = HttpBatchSender(),
        deviceAttributes = device::attributes,
        executor = ThreadExecutor(),
        crashStore = DeviceEngine.shared(context),
        engine = DeviceEngine.shared(context)
    )
}
