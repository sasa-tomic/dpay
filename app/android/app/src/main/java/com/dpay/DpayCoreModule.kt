package com.dpay

import android.nfc.NfcAdapter
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.math.BigInteger

/**
 * React Native bridge to the shared money/protocol core.
 *
 * Every method here delegates to the UniFFI-generated Kotlin binding (`uniffi.dpay_ffi.*`), which
 * loads the NDK-built `libdpay_ffi.so` — i.e. the *exact* compiled `dpay-core` the canister, relay,
 * sim, and Claude's headless tests use. No money logic is reimplemented in Kotlin or JS; this class
 * only marshals hex strings across the bridge. Bytes are passed as lowercase hex (RN's bridge has no
 * byte-array type); **amounts are decimal-digit STRINGS** (MC1 units 2-4: raw u64 never travels as
 * `Double`, which is lossy above 2^53). Time/currency stay `Double` (small bounded values).
 */
class DpayCoreModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "DpayCore"

    private val HEX = "0123456789abcdef".toCharArray()

    private fun hex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    private fun unhex(s: String): ByteArray =
        ByteArray(s.length / 2) {
            ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte()
        }

    /**
     * Parse a raw-u64 decimal STRING (from the JS bridge) into a ULong for the UniFFI binding.
     * MC1 units 2-4: `BigInteger(amount).toLong().toULong()` is EXACT for the full u64 bit-pattern
     * — `toLong()` takes the low 64 bits (so values in `[2^63, 2^64)` wrap to a negative long), and
     * `.toULong()` reinterprets those same bits unsigned. A malformed amount rejects the promise
     * with a debuggable code+message (never silent).
     */
    private fun rawU64(amount: String, field: String, promise: Promise): ULong? {
        return try {
            BigInteger(amount.trim()).toLong().toULong()
        } catch (e: Throwable) {
            promise.reject("dpay_core", "invalid $field: ${e.message}", e)
            null
        }
    }

    /** Fresh on-device Ed25519 keypair (native CSPRNG, inside Rust). */
    @ReactMethod
    fun generateKeypair(promise: Promise) {
        try {
            val kp = uniffi.dpay_ffi.generateKeypair()
            val out = Arguments.createMap()
            out.putString("secretHex", hex(kp.secret))
            out.putString("publicHex", hex(kp.`public`)) // `public` is a Kotlin hard keyword
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Wire-format byte lengths from the core (single source of truth). Resolved as Double because
     *  RN's bridge has no u64; values (292/196/132) are tiny. App.tsx derives its self-check expected
     *  hex length from this so no magic literal can rot on a wire resize. */
    @ReactMethod
    fun wireLen(promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.wireLen().toDouble())
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    @ReactMethod
    fun signingLen(promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.signingLen().toDouble())
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    @ReactMethod
    fun requestLen(promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.requestLen().toDouble())
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Build + sign the authorization OFFLINE; returns the 292-byte wire as hex. */
    @ReactMethod
    fun signAuthorization(
        secretHex: String,
        toHex: String,
        amount: String,
        nonceHex: String,
        expiry: Double,
        currency: Double,
        fromName: String,
        toName: String,
        memo: String,
        promise: Promise,
    ) {
        // MC1 units 2-4: `amount` is a raw-u64 decimal STRING. `rawU64` is exact for the full u64
        // bit-pattern and rejects the promise with a debuggable message on a malformed input.
        val amountU = rawU64(amount, "amount", promise) ?: return
        try {
            val wire = uniffi.dpay_ffi.signAuthorization(
                unhex(secretHex),
                unhex(toHex),
                amountU,
                unhex(nonceHex),
                expiry.toLong().toULong(),
                currency.toInt().toUInt(),
                fromName,
                toName,
                memo,
            )
            promise.resolve(hex(wire))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Sign a withdrawal authorization (ckBTC → native BTC out) OFFLINE; returns the 64-byte Ed25519
     * signature as hex. This is the non-custodial withdrawal gate: the facade verifies this signature
     * under `from_pubkey` (== the ckBTC debit subaccount) before moving funds. Mirrors `signAuthorization`
     * — the canonical signing bytes come from the shared core (single source of truth).
     */
    @ReactMethod
    fun signWithdrawal(
        secretHex: String,
        btcAddress: String,
        amount: String,
        nonceHex: String,
        expiry: Double,
        currency: Double,
        promise: Promise,
    ) {
        val amountU = rawU64(amount, "amount", promise) ?: return
        try {
            val sig = uniffi.dpay_ffi.signWithdrawal(
                unhex(secretHex),
                btcAddress,
                amountU,
                unhex(nonceHex),
                expiry.toLong().toULong(),
                currency.toInt().toUInt(),
            )
            promise.resolve(hex(sig))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Receiver side: encode a payment request {to, amount, nonce, expiry, currency, to_name, memo} to
     * a base64url string. `toName` is the merchant's own display name and `memo` an optional note;
     * both are copied verbatim by the payer into their signed authorization.
     */
    @ReactMethod
    fun encodeRequest(
        toHex: String,
        amount: String,
        nonceHex: String,
        expiry: Double,
        currency: Double,
        toName: String,
        memo: String,
        promise: Promise,
    ) {
        val amountU = rawU64(amount, "amount", promise) ?: return
        try {
            promise.resolve(
                uniffi.dpay_ffi.encodeRequest(
                    unhex(toHex),
                    amountU,
                    unhex(nonceHex),
                    expiry.toLong().toULong(),
                    currency.toInt().toUInt(),
                    toName,
                    memo,
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Payer side: decode a scanned merchant request QR into {toHex, amount, nonceHex, expiry, currency}.
     *  MC1 units 2-4: `amount` is emitted as an UNSIGNED decimal STRING (the full u64 range, never a
     *  lossy Double). */
    @ReactMethod
    fun decodeRequest(qr: String, promise: Promise) {
        try {
            val r = uniffi.dpay_ffi.decodeRequest(qr)
            val out = Arguments.createMap()
            out.putString("toHex", hex(r.to))
            out.putString("amount", r.amount.toString())
            out.putString("nonceHex", hex(r.nonce))
            out.putDouble("expiry", r.expiry.toDouble())
            out.putInt("currency", r.currency.toInt())
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Compact base64url QR string carried to the merchant. */
    @ReactMethod
    fun encodeQr(wireHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.encodeQr(unhex(wireHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Verify the signature in a wire blob (what the merchant/relay/canister re-check). */
    @ReactMethod
    fun verifyWire(wireHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.verifyWire(unhex(wireHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Policy gate mirroring the canister; resolves null when acceptable, else the reason string.
     *  MC1 units 2-4: amount/cap/balance are raw-u64 decimal STRINGS (exact for the full range);
     *  now/expiry stay Double (unix-seconds time, a small bounded value). */
    @ReactMethod
    fun validate(
        amount: String,
        now: Double,
        expiry: Double,
        cap: String,
        balance: String,
        nonceSeen: Boolean,
        sigOk: Boolean,
        promise: Promise,
    ) {
        val amountU = rawU64(amount, "amount", promise) ?: return
        val capU = rawU64(cap, "cap", promise) ?: return
        val balanceU = rawU64(balance, "balance", promise) ?: return
        try {
            promise.resolve(
                uniffi.dpay_ffi.validate(
                    amountU,
                    now.toLong().toULong(),
                    expiry.toLong().toULong(),
                    capU,
                    balanceU,
                    nonceSeen,
                    sigOk,
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Verify a canister/ledger-signed receipt signature (R2 outcome attestation) before the app
     * shows "Paid ✓". Mirrors `dpay_ffi::verify_receipt_sig` (strict Ed25519 verify over the
     * canonical ReceiptClaim built inside the Rust core). Hex in, boolean out.
     */
    @ReactMethod
    fun verifyReceiptSig(
        nonceHex: String,
        fromHex: String,
        toHex: String,
        amount: String,
        currency: Double,
        blockIndex: String,
        settleTs: String,
        receiptSigHex: String,
        pubkeyHex: String,
        promise: Promise,
    ) {
        // MC1 units 2-4: amount/blockIndex/settleTs are raw-u64 decimal STRINGS (the claim carries
        // them as u64 LE; exact transport closes the >2^53 loss surface). currency stays Double (u32).
        val amountU = rawU64(amount, "amount", promise) ?: return
        val blockIndexU = rawU64(blockIndex, "blockIndex", promise) ?: return
        val settleTsU = rawU64(settleTs, "settleTs", promise) ?: return
        try {
            promise.resolve(
                uniffi.dpay_ffi.verifyReceiptSig(
                    unhex(nonceHex),
                    unhex(fromHex),
                    unhex(toHex),
                    amountU,
                    currency.toLong().toUInt(),
                    blockIndexU,
                    settleTsU,
                    unhex(receiptSigHex),
                    unhex(pubkeyHex),
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Report the device NFC radio state for the UI status chip: "ready" (adapter present + enabled),
     * "off" (present but disabled in system settings), or "unsupported" (no NFC hardware). This is
     * the *radio* status only — the tap-to-pay HCE transport (see `dpay_core::nfc`) is a separate,
     * physical-device-gated feature; QR always works regardless of this value. A probe failure
     * resolves "unknown" (the chip then hides) rather than rejecting.
     */
    @ReactMethod
    fun nfcStatus(promise: Promise) {
        try {
            val adapter = NfcAdapter.getDefaultAdapter(reactApplicationContext)
            val status = when {
                adapter == null -> "unsupported"
                adapter.isEnabled -> "ready"
                else -> "off"
            }
            promise.resolve(status)
        } catch (e: Throwable) {
            promise.resolve("unknown")
        }
    }
}
