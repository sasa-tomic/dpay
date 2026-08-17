package com.dpay

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge for the SOL NFC tap transport. Pure Kotlin (no Rust core) — it only starts/stops the two
 * roles and relays the payer's auto-signed `solpay:` URI; all decode/sign/broadcast logic stays in
 * JS. Lifecycle updates reach JS as `DpaySolNfcEvent`s via `RCTDeviceEventEmitter`.
 *
 * Roles map to the SOL modes: **SolPay** = HCE card (the payer is tapped), **SolReceive** = reader.
 */
class DpaySolNfcModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        DpaySolNfc.attach(reactContext)
    }

    override fun getName(): String = "DpaySolNfc"

    // Required no-ops so JS `NativeEventEmitter(DpaySolNfc)` doesn't warn on Android.
    @ReactMethod fun addListener(eventName: String) {}

    @ReactMethod fun removeListeners(count: Double) {}

    // ---------------------------------------------------------------- payer / card (SolPay mode)
    @ReactMethod
    fun armCard(promise: Promise) {
        try { DpaySolNfc.armCard(); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_sol_nfc", e) }
    }

    @ReactMethod
    fun disarmCard(promise: Promise) {
        DpaySolNfc.disarmCard(); promise.resolve(null)
    }

    /** Approve: pass the offline-signed `solpay:` URI for the card to serve. */
    @ReactMethod
    fun approveSolCard(solpayUri: String, promise: Promise) {
        try { DpaySolNfc.approveSolCard(solpayUri); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_sol_nfc", e) }
    }

    @ReactMethod
    fun declineSolCard(promise: Promise) {
        DpaySolNfc.declineSolCard(); promise.resolve(null)
    }

    // ---------------------------------------------------------------- merchant / reader (SolReceive)
    /** Enter reader mode and collect the payer's tap for this `solreq:` URI. */
    @ReactMethod
    fun startSolReader(solreqUri: String, promise: Promise) {
        val act = reactApplicationContext.currentActivity ?: run { promise.reject("dpay_sol_nfc", "no foreground activity"); return }
        try { DpaySolNfc.startReader(act, solreqUri); promise.resolve(null) } catch (e: Throwable) { promise.reject("dpay_sol_nfc", e) }
    }

    /** After broadcasting + confirming online, hand the outcome back to the payer over the same tap.
     *  `status`: 0 = settled, 1 = ledger rejected, 2 = ledger unreachable. `rid` binds the receipt to
     *  the request id (a cross-tap receipt for a different payment is ignored by the payer); `sig` the
     *  on-chain signature. */
    @ReactMethod
    fun confirmSolReceipt(status: Double, rid: String, sig: String, promise: Promise) {
        DpaySolNfc.confirmSolReceipt(status.toInt(), rid, sig)
        promise.resolve(null)
    }

    @ReactMethod
    fun stopSolReader(promise: Promise) {
        // Null is fine: DpaySolNfc.stopReader falls back to the activity reader mode was enabled on.
        DpaySolNfc.stopReader(reactApplicationContext.currentActivity)
        promise.resolve(null)
    }
}
