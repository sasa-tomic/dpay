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
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcRequestBytes
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

    // Golden outputs from the host build of the same core. The wire is the frozen 292-byte layout
    // (signing(196) | sig(64) | from_pub(32)); the three 32-byte name/memo fields are empty here
    // (NUL-padded) since this test is about crypto fidelity, not display names — the signing region
    // still grew 100→196 bytes, so the signature differs from the pre-name-layout golden.
    private val expectedWire = hex(
        "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c" +
            "0707070707070707070707070707070707070707070707070707070707070707" +
            "c4090000000000002a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a005786f400000000" +
            "0000000000000000000000000000000000000000000000000000000000000000" +
            "0000000000000000000000000000000000000000000000000000000000000000" +
            "0000000000000000000000000000000000000000000000000000000000000000" +
            "00000000f17a9147baa176876a2d50a7d0eef9ed5ccefe5c8bc414b5c6cf6048" +
            "4cd835a5ae89774fa947cc6ccbc82b6c9ad782ee59c825ea8f60821fdc9c2587" +
            "791d10038a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801" +
            "b40f6f5c"
    )
    private val expectedQr =
        "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1wHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHB8QJAAAAAAAAKioqKioqKioqKioqKioqKgBXhvQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPF6kUe6oXaHai1Qp9Du-e1czv5ci8QUtcbPYEhM2DWlrol3T6lHzGzLyCtsmteC7lnIJeqPYIIf3Jwlh3kdEAOKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXA"

    /** The phone signs offline and produces the identical wire + QR the sandbox does. */
    @Test
    fun deterministicSigningMatchesHostByteForByte() {
        val wire = signAuthorization(secret, to, amount, nonce, expiry, 0u, "", "", "")
        assertEquals("wire length", 292, wire.size)
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
        val wire = signAuthorization(payer.secret, merchant.public, 999UL, nonce, expiry, 0u, "", "", "")
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
        val wire = signAuthorization(secret, to, amount, nonce, expiry, 0u, "", "", "")
        val tampered = wire.copyOf()
        tampered[196] = (tampered[196] + 1).toByte() // first byte of the 64-byte signature (offset 196..260)
        assertFalse(verifyWire(tampered))
    }

    /**
     * MC1 units 2-4: an amount > 2^53 (the IEEE-754 loss zone the old `number`/`Double` JS/Kotlin
     * path collapsed) round-trips EXACTLY through the on-device core. Number(9007199254740993) ===
     * 9007199254740992 (lossy); ULong carries the exact value. The @ReactMethod path marshals the
     * amount as a decimal STRING (`BigInteger(amount).toLong().toULong()`), and the FFI core handles
     * the full u64 range — this drives the real `.so` to prove the request encode→decode round-trip
     * is byte-exact for 2^53+1, and the signed wire verifies. (The on-device self-check via `just
     * app` separately exercises the String-signature `@ReactMethod` surface.)
     */
    @Test
    fun bigAmountAbove2p53RoundTripsExactly() {
        val big = "9007199254740993".toULong() // 2^53 + 1
        // Request encode → decode round-trip carries the exact u64 (the FFI handles the full range).
        val request = nfcRequestBytes(to, big, nonce, expiry, 0u, "", "")
        val decoded = nfcDecodeRequest(request)
        assertEquals("2^53+1 round-trips exactly through the on-device core (no number loss)", big, decoded.amount)
        // Signing with the big amount produces a verifiable wire (the FROZEN wire bytes carry the
        // amount as a u64 LE; the on-device core encodes the full range exactly).
        val wire = signAuthorization(secret, to, big, nonce, expiry, 0u, "", "", "")
        assertTrue("the >2^53 authorization verifies on-device", verifyWire(wire))
    }
}
