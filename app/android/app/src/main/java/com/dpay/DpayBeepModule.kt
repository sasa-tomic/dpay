package com.dpay

import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** The payment-complete beep (founder 2026-10-09): a short notification tone played ONLY when a
 *  payment reaches terminal success (QR settle, confirmed NFC tap) — never on sign, submit, or
 *  hand-off. ToneGenerator needs no asset, no permission, and no audio-focus negotiation for a
 *  ~250ms blip on STREAM_NOTIFICATION. Failures are swallowed by design: acoustic feedback must
 *  never become an error surface. */
class DpayBeepModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "DpayBeep"

    @ReactMethod
    fun play() {
        try {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 250)
            // Release after the tone finishes; releasing early cuts the sound off mid-blip.
            Handler(Looper.getMainLooper()).postDelayed({ tone.release() }, 350)
        } catch (_: Exception) {
            // best-effort by design
        }
    }
}
