package com.dpay

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              // Bridge to the shared Rust core (dpay-core via UniFFI).
              add(DpayCorePackage())
            }

        override fun getJSMainModuleName(): String = "index"

        override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

        // RN 0.82+ removed the legacy architecture; overriding isNewArchEnabled to false throws at
        // startup. The base DefaultReactNativeHost resolves it from BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
        // which is driven by the `newArchEnabled=true` gradle property. The hand-written DpayCore /
        // DpayNfc NativeModules are wrapped by the New Arch interop layer (BridgelessNativeModuleProxy),
        // so they keep working as legacy modules under the bridgeless runtime with no codegen changes.
        override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
      }

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    // RN 0.79+ merges several per-feature .so files (react_featureflagsjni, react_devtoolsruntimesettings,
    // etc.) INTO libreactnative.so to cut APK size and load time. SoLoader needs the
    // OpenSourceMergedSoMapping so its loadLibrary("react_featureflagsjni") call resolves to a symbol
    // inside the merged library instead of looking for a standalone libreact_featureflagsjni.so that
    // is no longer shipped. Passing `false` (the legacy flag) means "do not use a merged mapping" →
    // UnsatisfiedLinkError on first feature-flag read at startup.
    SoLoader.init(this, OpenSourceMergedSoMapping)
    // The New Architecture is always enabled in RN 0.82+; load() the native entry point unconditionally.
    load()
  }
}
