package com.dpay

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * React Native bridge to the shared money/protocol core.
 *
 * Every method here delegates to the UniFFI-generated Kotlin binding (`uniffi.dpay_ffi.*`), which
 * loads the NDK-built `libdpay_ffi.so` — i.e. the *exact* compiled `dpay-core` the canister, relay,
 * sim, and Claude's headless tests use. No money logic is reimplemented in Kotlin or JS; this class
 * only marshals hex strings across the bridge. Bytes are passed as lowercase hex (RN's bridge has no
 * byte-array type); amounts/time are doubles (safe: values stay well under 2^53).
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

    /** Build + sign the authorization OFFLINE; returns the 192-byte wire as hex. */
    @ReactMethod
    fun signAuthorization(
        secretHex: String,
        toHex: String,
        amount: Double,
        nonceHex: String,
        expiry: Double,
        promise: Promise,
    ) {
        try {
            val wire = uniffi.dpay_ffi.signAuthorization(
                unhex(secretHex),
                unhex(toHex),
                amount.toLong().toULong(),
                unhex(nonceHex),
                expiry.toLong().toULong(),
            )
            promise.resolve(hex(wire))
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

    /** Policy gate mirroring the canister; resolves null when acceptable, else the reason string. */
    @ReactMethod
    fun validate(
        amount: Double,
        now: Double,
        expiry: Double,
        cap: Double,
        balance: Double,
        nonceSeen: Boolean,
        sigOk: Boolean,
        promise: Promise,
    ) {
        try {
            promise.resolve(
                uniffi.dpay_ffi.validate(
                    amount.toLong().toULong(),
                    now.toLong().toULong(),
                    expiry.toLong().toULong(),
                    cap.toLong().toULong(),
                    balance.toLong().toULong(),
                    nonceSeen,
                    sigOk,
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }
}
