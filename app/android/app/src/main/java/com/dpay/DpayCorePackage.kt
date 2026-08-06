package com.dpay

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Registers [DpayCoreModule], [DpayNfcModule], and [DpaySolNfcModule] with React Native (old architecture). */
class DpayCorePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(DpayCoreModule(reactContext), DpayNfcModule(reactContext), DpaySolNfcModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
