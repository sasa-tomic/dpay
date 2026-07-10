package org.dpay.ffitest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.dpay_ffi.decodeQr
import uniffi.dpay_ffi.encodeQr
import uniffi.dpay_ffi.generateKeypair
import uniffi.dpay_ffi.signAuthorization
import uniffi.dpay_ffi.validate
import uniffi.dpay_ffi.verifyWire

/**
 * Runs the EXACT compiled dpay-core on a real Android runtime, through the UniFFI Kotlin binding and
 * the NDK-built libdpay_ffi.so. This is the device-fidelity gate the dev-loop plan deferred: it
 * proves the phone signs with byte-for-byte the same output Claude tests headlessly.
 *
 * The deterministic vector below was produced by the shared core on the host (see the python
 * binding). If a single byte of the protocol/crypto differed on-device, these equalities break.
 */
@RunWith(AndroidJUnit4::class)
class DpayFfiInstrumentedTest {

    private fun hex(s: String): ByteArray =
        ByteArray(s.length / 2) { ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte() }

    // Fixed inputs: secret=[1;32], to=[7;32], $25.00, nonce=[42;16], expiry=2100-01-01Z.
    private val secret = ByteArray(32) { 1 }
    private val to = ByteArray(32) { 7 }
    private val amount = 2_500UL
    private val nonce = ByteArray(16) { 42 }
    private val expiry = 4_102_444_800UL

    // Golden outputs from the host build of the same core.
    private val expectedWire = hex(
        "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c" +
            "0707070707070707070707070707070707070707070707070707070707070707" +
            "c4090000000000002a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a005786f400000000" +
            "be6b428b2780d3fc3c152573bf22ee58683ef1f19e8d381200ac295591a5dcaf" +
            "4a034de1c08cf478f7d03fe700c432c5c45cc17a98b00489d1997932ed867a00" +
            "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"
    )
    private val expectedQr =
        "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1wHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHB8QJAAAAAAAAKioqKioqKioqKioqKioqKgBXhvQAAAAAvmtCiyeA0_w8FSVzvyLuWGg-8fGejTgSAKwpVZGl3K9KA03hwIz0ePfQP-cAxDLFxFzBepiwBInRmXky7YZ6AIqI4910CfGV_VLbLTy6XXLKZwm_HZQSG_N0iAG0D29c"

    /** The phone signs offline and produces the identical wire + QR the sandbox does. */
    @Test
    fun deterministicSigningMatchesHostByteForByte() {
        val wire = signAuthorization(secret, to, amount, nonce, expiry)
        assertEquals("wire length", 192, wire.size)
        assertArrayEquals("on-device wire must equal host wire", expectedWire, wire)
        assertEquals("on-device QR must equal host QR", expectedQr, encodeQr(wire))
        assertArrayEquals("QR decode roundtrip", wire, decodeQr(expectedQr))
        assertTrue("signature verifies", verifyWire(wire))
    }

    /** A real on-device keypair still round-trips (native CSPRNG path through the core). */
    @Test
    fun freshKeypairRoundTrips() {
        val payer = generateKeypair()
        val merchant = generateKeypair()
        assertEquals(32, payer.secret.size)
        assertEquals(32, payer.public.size)
        val wire = signAuthorization(payer.secret, merchant.public, 999UL, nonce, expiry)
        assertTrue(verifyWire(wire))
        assertArrayEquals(wire, decodeQr(encodeQr(wire)))
    }

    /** The policy gate mirrors the canister, in the same rejection order, on-device. */
    @Test
    fun validateMirrorsCanisterGate() {
        val now = 1_800_000_000UL
        val cap = 100_000UL
        val bal = 10_000UL
        assertNull("accepted", validate(amount, now, expiry, cap, bal, false, true))
        assertEquals("bad_signature", validate(amount, now, expiry, cap, bal, false, false))
        assertEquals("zero_amount", validate(0UL, now, expiry, cap, bal, false, true))
        assertEquals("expired", validate(amount, 5_000_000_000UL, expiry, cap, bal, false, true))
        assertEquals("over_cap", validate(amount, now, expiry, 1_000UL, bal, false, true))
        assertEquals("insufficient_funds", validate(amount, now, expiry, cap, 100UL, false, true))
        assertEquals("nonce_reused", validate(amount, now, expiry, cap, bal, true, true))
    }

    /** Tamper detection: flipping any signature byte must fail verification on-device. */
    @Test
    fun tamperedSignatureFailsVerification() {
        val wire = signAuthorization(secret, to, amount, nonce, expiry)
        val tampered = wire.copyOf()
        tampered[100] = (tampered[100] + 1).toByte() // a byte inside the 64-byte signature
        assertFalse(verifyWire(tampered))
    }
}
