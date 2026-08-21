package org.dpay.ffitest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.dpay_ffi.decodeRequest
import uniffi.dpay_ffi.encodeRequest
import uniffi.dpay_ffi.generateKeypair
import uniffi.dpay_ffi.icpDecodeMinterOk
import uniffi.dpay_ffi.icpDecodeTransferResult
import uniffi.dpay_ffi.icpEnvelopeRequestId
import uniffi.dpay_ffi.icpPrincipalFromPubkey
import uniffi.dpay_ffi.icpSelfPrincipal
import uniffi.dpay_ffi.icpSignUpdate
import uniffi.dpay_ffi.icpTransferArg
import uniffi.dpay_ffi.keypairFromSecret
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcRequestBytes

/**
 * Runs the EXACT compiled dpay-core on a real Android runtime, through the UniFFI Kotlin binding and
 * the NDK-built libdpay_ffi.so. This is the device-fidelity gate: it proves the phone produces
 * byte-for-byte the same outputs Claude tests headlessly.
 *
 * Re-scoped to the CURRENT surface at the IC-rail cutover (2026-08-19): the app no longer signs
 * 292-byte payment wires — it signs user-principal IC /call envelopes locally and submits them to
 * /api/v2. The retired wire-crypto methods (signAuthorization / verifyWire / encodeQr / validate /
 * wireLen) are gone from the FFI; this test now pins the request-QR codec and the full IC rail
 * round-trip (transfer arg → signed envelope → request_id) plus the reply decoders, all against
 * host-captured goldens. If a single byte of the protocol/crypto differed on-device, these
 * equalities break.
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

    // Host-captured goldens (python binding over the same .so sources; see crates/dpay-ffi/verify.sh).
    private val expectedQr =
        "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwfECQAAAAAAACoqKioqKioqKioqKioqKioAV4b0AAAAAAAAAABBbGljZQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGRpbm5lcgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private val expectedToText = "pzfel-cp5eq-fnyhd-etogg-ndsd3-2jdew-yikrl-pobuj-wwnd4-4e2as-3ae"
    private val expectedSelfText = "wf3fv-4c4nr-7ks2b-xa4u7-kf3no-32glf-lf7e4-4ng4a-wwtlu-a2vnq-nae"
    private val expectedArg = hex(
        "4449444c066c06fbca0101c6fcb60204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac3" +
            "0368ad86ca8305026e036d7b6e7d6e780100011dfd240adc1c649b8c668e43de92325b085456f70689b59a3e70" +
            "9a04b60200010a01082a2a2a2a2a2a2a2a0000c413"
    )
    private val expectedEnvelope = hex(
        "d9d9f7a367636f6e74656e74a66c726571756573745f747970656463616c6c6e696e67726573735f657870697279" +
            "1b38eecfcf56a600006673656e646572581d5c6c7ea968370729f5176d76f4659565f939c69b80b5a6ba03556c1" +
            "a026b63616e69737465725f6964581dfd240adc1c649b8c668e43de92325b085456f70689b59a3e709a04b6026b" +
            "6d6574686f645f6e616d656e69637263315f7472616e736665726361726758704449444c066c06fbca0101c6fcb6" +
            "0204ba89e5c20402a2de94eb060282f3f3910c05d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d" +
            "6e780100011dfd240adc1c649b8c668e43de92325b085456f70689b59a3e709a04b60200010a01082a2a2a2a2a2a" +
            "2a2a0000c4136d73656e6465725f7075626b6579582c302a300506032b65700321008a88e3dd7409f195fd52db2d" +
            "3cba5d72ca6709bf1d94121bf3748801b40f6f5c6a73656e6465725f7369675840c0ec2323790f3f2766ae37b853" +
            "26b18abc86a2d9e6754c351858ae2443a2557337d8472d1cb9e198c2d337556fc88b1b280616bc55a3dd2cb45f7b" +
            "736cadf20d"
    )
    private val expectedRid = hex("5689afe0e6525c589122cc474bb04ccdab0d0c4714b4530f4a6231a05cd056f0")

    /** The merchant request QR the phone encodes is byte-identical to the host's, names and all. */
    @Test
    fun requestQrMatchesHostByteForByte() {
        val qr = encodeRequest(to, amount, nonce, expiry, 0u, "Alice", "dinner")
        assertEquals("on-device request QR must equal host QR", expectedQr, qr)
        assertEquals("encoding is deterministic", qr, encodeRequest(to, amount, nonce, expiry, 0u, "Alice", "dinner"))
        val data = decodeRequest(qr)
        assertArrayEquals("to", to, data.to)
        assertEquals("amount", amount, data.amount)
        assertArrayEquals("nonce", nonce, data.nonce)
        assertEquals("expiry", expiry, data.expiry)
        assertEquals("currency", 0u, data.currency)
        assertEquals("toName", "Alice", data.toName)
        assertEquals("memo", "dinner", data.memo)
    }

    /** A real on-device keypair still round-trips (native CSPRNG path through the core). */
    @Test
    fun freshKeypairRoundTrips() {
        val payer = generateKeypair()
        assertEquals(32, payer.secret.size)
        assertEquals(32, payer.public.size)
        val derived = keypairFromSecret(payer.secret)
        assertArrayEquals("public key derives from secret on-device", payer.public, derived.public)
    }

    /**
     * The full IC rail round-trip on-device: principal derivation, the icrc1_transfer candid arg,
     * the signed /call envelope, and its request_id — every byte matching the host goldens. The
     * envelope signature is deterministic ed25519, so byte-equality here is the rail-era analogue
     * of the old wire golden.
     */
    @Test
    fun icpRailMatchesHostByteForByte() {
        assertEquals("self principal is seed-stable", expectedSelfText, icpSelfPrincipal(secret))
        val toText = icpPrincipalFromPubkey(to)
        assertEquals("to principal", expectedToText, toText)

        val arg = icpTransferArg(toText, null, null, amount.toString(), "10", "2a".repeat(8))
        assertArrayEquals("transfer arg must equal host bytes", expectedArg, arg)

        val signed = icpSignUpdate(secret, toText, "icrc1_transfer", arg, "4102444800000000000")
        assertArrayEquals("signed envelope must equal host bytes", expectedEnvelope, signed.envelope)
        assertArrayEquals("request_id must equal host rid", expectedRid, signed.requestId)

        // Transport integrity: either side can re-derive the same request id from the immutable
        // envelope; only the sender is authorized to poll its request_status on the IC.
        assertArrayEquals("envelope rid round-trips", expectedRid, icpEnvelopeRequestId(signed.envelope))
    }

    /**
     * Reply decoders on-device: the LIVE-captured icrc1_transfer Ok reply and BadFee reply (from
     * the mainnet DUSD ledger), plus the frozen minter retrieve/withdraw Ok({block_index}) shape
     * (production candid 0.10.22 — the same bytes the e2e fake-IC gateway emits).
     */
    @Test
    fun replyDecodersMatchGoldens() {
        val okArg = hex(
            "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd" +
                "0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018b" +
                "bdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000002"
        )
        val ok = icpDecodeTransferResult(okArg)
        assertTrue("transfer Ok", ok.ok)
        assertEquals("block index", "2", ok.blockIndex)

        val badFeeArg = hex(
            "4449444c086b02bc8a017dc5fed201016b08d1c4987c02c291ecb9027f94c1c7890403eb82a8970404a1c3ebfd" +
                "0705f087e6db090693e5bec80c7feb9cdbd50f076c02c7ebc4d00971c498b1b50d7d6c019bb3bea60a7d6c018b" +
                "bdf29b017d6c01bf9bb7f00d7d6c01a3bb918c0a786c019cbab69c027d01000104904e"
        )
        val badFee = icpDecodeTransferResult(badFeeArg)
        assertTrue("BadFee reply decodes as refusal", !badFee.ok)
        assertEquals("BadFee", badFee.errVariant)

        // Minter retrieve/withdraw Ok: frozen prefix + nat64 LE block_index (1234 = 0xd204 LE).
        val minterOk = icpDecodeMinterOk(hex("4449444c026b01bc8a01016c01e09ecba90278010000" + "d204000000000000"))
        assertTrue("minter Ok", minterOk.ok)
        assertEquals("minter block index", "1234", minterOk.blockIndex)
    }

    /**
     * MC1 units 2-4: an amount > 2^53 (the IEEE-754 loss zone the old `number`/`Double` JS/Kotlin
     * path collapsed) round-trips EXACTLY through the on-device core. Number(9007199254740993) ===
     * 9007199254740992 (lossy); ULong carries the exact value. The @ReactMethod path marshals the
     * amount as a decimal STRING, and the FFI core handles the full u64 range — this drives the
     * real `.so` through the NFC request path (the bytes NFC transports) to prove the round-trip is
     * byte-exact for 2^53+1.
     */
    @Test
    fun bigAmountAbove2p53RoundTripsExactly() {
        val big = "9007199254740993".toULong() // 2^53 + 1
        val request = nfcRequestBytes(to, big, nonce, expiry, 0u, "", "")
        val decoded = nfcDecodeRequest(request)
        assertEquals("2^53+1 round-trips exactly through the on-device core (no number loss)", big, decoded.amount)
        // …and the QR path carries it too (the u64 travels the same 8 LE bytes in both codecs).
        assertEquals(big, decodeRequest(encodeRequest(to, big, nonce, expiry, 0u, "", "")).amount)
    }
}
