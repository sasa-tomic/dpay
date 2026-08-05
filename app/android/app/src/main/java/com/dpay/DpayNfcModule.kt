package com.dpay

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.math.BigInteger

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

    /** Exclusive u64 upper bound (2^64) for [rawU64] range validation — shift form avoids a
     *  typo-prone decimal literal. Mirrors `DpayCoreModule.U64_LIMIT`. */
    private val U64_LIMIT = BigInteger.valueOf(1).shiftLeft(64)

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

    /**
     * Parse a raw-u64 decimal STRING into a ULong for the UniFFI binding; rejects the promise
     * (never silent) on a malformed or out-of-`[0, 2^64)` value. Mirrors `DpayCoreModule.rawU64` —
     * the sign + range guard runs BEFORE the bit-truncating `toLong()` so a negative or overflowing
     * amount can't silently corrupt the wire (PR2 defense-in-depth).
     */
    private fun rawU64(amount: String, field: String, promise: Promise): ULong? {
        val bi = try {
            BigInteger(amount.trim())
        } catch (e: Throwable) {
            promise.reject("dpay_nfc", "invalid $field: ${e.message}", e)
            return null
        }
        if (bi.signum() < 0 || bi >= U64_LIMIT) {
            promise.reject("dpay_nfc", "out of u64 range for $field: $amount")
            return null
        }
        return bi.toLong().toULong()
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

    /** Approve: pass the offline-signed 292-byte wire (hex) for the card to serve. */
    @ReactMethod
    fun approveCard(wireHex: String, promise: Promise) {
        try { DpayNfc.approveCard(unhex(wireHex)); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_nfc", e) }
    }

    @ReactMethod
    fun declineCard(promise: Promise) {
        DpayNfc.declineCard(); promise.resolve(null)
    }

    // ---------------------------------------------------------------- merchant / reader (Receive)
    /**
     * Build the raw request wire (hex) the reader pushes — mirrors the request QR's bytes. `toName`
     * is the merchant's own display name and `memo` an optional note; both ride in the 132-byte
     * request so the payer (reviewing "Pay $X to <to_name>") and the signed authorization carry them
     * — same param order as `DpayCore.encodeRequest`.
     */
    @ReactMethod
    fun buildRequest(
        toHex: String,
        amount: String,
        nonceHex: String,
        expiry: Double,
        currency: Double,
        toName: String,
        memo: String,
        promise: Promise,
    ) {
        // MC1 units 2-4: `amount` is a raw-u64 decimal STRING. `rawU64` is exact for the full u64
        // bit-pattern and rejects the promise (never silent) on a malformed or out-of-range value.
        val amountU = rawU64(amount, "amount", promise) ?: return
        try {
            val bytes = uniffi.dpay_ffi.nfcRequestBytes(
                unhex(toHex),
                amountU,
                unhex(nonceHex),
                expiry.toLong().toULong(),
                currency.toInt().toUInt(),
                toName,
                memo,
            )
            promise.resolve(hex(bytes))
        } catch (e: Throwable) {
            promise.reject("dpay_nfc", e)
        }
    }

    /** Enter reader mode and collect the payer's tap for this request (hex). */
    @ReactMethod
    fun startReader(requestHex: String, promise: Promise) {
        // RN 0.80 deprecated ReactContextBaseJavaModule.getCurrentActivity() in favor of
        // reactApplicationContext.currentActivity (the former was a Java method, accessible from
        // Kotlin as the `currentActivity` property; the new path is a Kotlin property on
        // ReactApplicationContext).
        val act = reactApplicationContext.currentActivity ?: run { promise.reject("dpay_nfc", "no foreground activity"); return }
        try { DpayNfc.startReader(act, unhex(requestHex)); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_nfc", e) }
    }

    /** After settling online, hand the outcome back to the payer over the same tap. `status`:
     *  0 = settled, 1 = ledger rejected, 2 = ledger unreachable. `nonceHex` is the authoritative
     *  payment nonce (32 hex chars) the ledger settled, so the payer can match it to what it signed;
     *  an empty/short value falls back to the request nonce natively. */
    @ReactMethod
    fun confirmReceipt(status: Double, nonceHex: String, promise: Promise) {
        val nonce = if (nonceHex.length == 32) unhex(nonceHex) else ByteArray(0)
        DpayNfc.confirmReceipt(status.toInt(), nonce)
        promise.resolve(null)
    }

    @ReactMethod
    fun stopReader(promise: Promise) {
        reactApplicationContext.currentActivity?.let { DpayNfc.stopReader(it) }
        promise.resolve(null)
    }
}
