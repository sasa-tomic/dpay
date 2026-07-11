package com.dpay

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge for the NFC tap flow. It only starts/stops the two roles and relays the payer's
 * approve/decline; all bytes and phases flow through [DpayNfc] into the shared Rust core. Lifecycle
 * updates reach JS as `DpayNfcEvent`s via `RCTDeviceEventEmitter` (subscribe with `NativeEventEmitter`).
 *
 * Roles map to the app's modes: **Pay** = HCE card (the payer is tapped), **Receive** = reader
 * (the merchant reads the tap).
 */
class DpayNfcModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        DpayNfc.attach(reactContext)
    }

    override fun getName(): String = "DpayNfc"

    // Required no-ops so JS `NativeEventEmitter(DpayNfc)` doesn't warn on Android.
    @ReactMethod fun addListener(eventName: String) {}

    @ReactMethod fun removeListeners(count: Double) {}

    private val HEXCH = "0123456789abcdef".toCharArray()

    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            sb.append(HEXCH[v ushr 4]).append(HEXCH[v and 0x0f])
        }
        return sb.toString()
    }

    private fun unhex(s: String): ByteArray =
        ByteArray(s.length / 2) {
            ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte()
        }

    // ---------------------------------------------------------------- payer / card (Pay mode)
    @ReactMethod
    fun armCard(promise: Promise) {
        try { DpayNfc.armCard(); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_nfc", e) }
    }

    @ReactMethod
    fun disarmCard(promise: Promise) {
        DpayNfc.disarmCard(); promise.resolve(null)
    }

    /** Approve: pass the offline-signed 192-byte wire (hex) for the card to serve. */
    @ReactMethod
    fun approveCard(wireHex: String, promise: Promise) {
        try { DpayNfc.approveCard(unhex(wireHex)); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_nfc", e) }
    }

    @ReactMethod
    fun declineCard(promise: Promise) {
        DpayNfc.declineCard(); promise.resolve(null)
    }

    // ---------------------------------------------------------------- merchant / reader (Receive)
    /** Build the raw request wire (hex) the reader pushes — mirrors the request QR's bytes. */
    @ReactMethod
    fun buildRequest(toHex: String, amount: Double, nonceHex: String, expiry: Double, promise: Promise) {
        try {
            val bytes = uniffi.dpay_ffi.nfcRequestBytes(
                unhex(toHex),
                amount.toLong().toULong(),
                unhex(nonceHex),
                expiry.toLong().toULong(),
            )
            promise.resolve(hex(bytes))
        } catch (e: Throwable) {
            promise.reject("dpay_nfc", e)
        }
    }

    /** Enter reader mode and collect the payer's tap for this request (hex). */
    @ReactMethod
    fun startReader(requestHex: String, promise: Promise) {
        val act = currentActivity ?: run { promise.reject("dpay_nfc", "no foreground activity"); return }
        try { DpayNfc.startReader(act, unhex(requestHex)); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_nfc", e) }
    }

    @ReactMethod
    fun stopReader(promise: Promise) {
        currentActivity?.let { DpayNfc.stopReader(it) }
        promise.resolve(null)
    }
}
