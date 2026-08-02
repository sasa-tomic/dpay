package com.dpay

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "dpay"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  /**
   * Keep the app chrome out from under the system bars on Android 15+.
   *
   * Android 15 (API 35) enforces edge-to-edge for apps targeting SDK 35: `StatusBar
   * translucent={false}` and `statusBarColor` are ignored and the window is laid out behind the
   * status + navigation bars. RN 0.75's built-in `SafeAreaView` is a no-op on Android, so without
   * this the wallet header drew under the status icons on a real API 35 device.
   *
   * The enforcement is keyed on the device API, not targetSdk: an app targeting SDK 35 only goes
   * edge-to-edge when run on an API 35+ device. On API <=34 the legacy window model still holds —
   * the system reserves the bar space itself and `translucent={false}` works, so this inset
   * reservation is only needed on API 35+. The whole block is gated on SDK_INT >= 35 to match
   * that boundary exactly (and avoid depending on the legacy decor's inset-consumption quirks).
   *
   * We reserve the status + navigation bar insets as padding on the content frame, and explicitly
   * request a fresh insets dispatch because super.onCreate() already consumed the initial one
   * before the listener was registered (otherwise the listener would miss the first dispatch on a
   * plain cold start and only fire later if a permission dialog / keyboard triggered a re-dispatch).
   */
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT < 35) return
    val content = findViewById<View>(android.R.id.content)
    content.setOnApplyWindowInsetsListener { v, insets ->
      val top = insets.getInsets(WindowInsets.Type.statusBars()).top
      val bottom = insets.getInsets(WindowInsets.Type.navigationBars()).bottom
      v.setPadding(v.paddingLeft, top, v.paddingRight, bottom)
      insets
    }
    content.requestApplyInsets()
  }
}
