package com.groundcover.rum.bridge

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Autolinking entry point — discovered by the RN CLI config, which Expo
 *  prebuild consumes, so host apps need no manual registration. */
class GroundcoverRumPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(GroundcoverRumModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
