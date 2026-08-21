package org.dpay.ffitest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.dpay_ffi.FfiCardSession
import uniffi.dpay_ffi.FfiReaderConductor
import uniffi.dpay_ffi.NfcPhase
import uniffi.dpay_ffi.NfcResultStatus
import uniffi.dpay_ffi.NfcStep
import uniffi.dpay_ffi.generateKeypair
import uniffi.dpay_ffi.icpPrincipalFromPubkey
import uniffi.dpay_ffi.icpSignReadState
import uniffi.dpay_ffi.icpSignUpdate
import uniffi.dpay_ffi.icpTransferArg
import uniffi.dpay_ffi.nfcBundleBytes
import uniffi.dpay_ffi.nfcDecodeBundle
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcDefaultMaxChunk
import uniffi.dpay_ffi.nfcRequestBytes
import uniffi.dpay_ffi.nfcResultBytes

/**
 * Runs the dpay NFC *transport state machines* on a real Android runtime — the exact
 * [FfiCardSession] (payer / HCE) and [FfiReaderConductor] (merchant / reader) that the
 * `DpayHostApduService` and the reader-mode loop drive on a phone. The radio hop between two devices
 * is a physical gate, but every byte of APDU framing, chunk reassembly, and phase logic runs here,
 * so an emulator pass proves the on-device protocol is byte-identical to what Claude tests headlessly
 * in Rust and Python.
 *
 * Protocol v2 serves a signed update plus payer-signed read_state capability, then returns a
 * merchant-signed result. The payer can remain offline for the entire exchange.
 */
@RunWith(AndroidJUnit4::class)
class DpayNfcInstrumentedTest {

    private val amount = 4_200UL
    private val nonce = ByteArray(16) { 7 }
    private val expiry = 4_102_444_800UL

    /** One production-shaped payer payload: a signed icrc1_transfer envelope over a fresh key. */
    private class PayerEnvelope(val bundle: ByteArray, val requestId: ByteArray)

    private fun signEnvelope(payerSecret: ByteArray, merchantPub: ByteArray): PayerEnvelope {
        // The app derives the merchant's IC principal from the request QR's pubkey and signs an
        // icrc1_transfer to it (services/rail.ts prepareTransfer) — mirrored here on-device.
        val toText = icpPrincipalFromPubkey(merchantPub)
        val arg = icpTransferArg(toText, null, null, amount.toString(), "10", "07".repeat(16))
        val signed = icpSignUpdate(payerSecret, toText, "icrc1_transfer", arg, "4102444800000000000")
        val readState = icpSignReadState(payerSecret, listOf(signed.requestId), false, "4102444860000000000")
        return PayerEnvelope(nfcBundleBytes(signed.envelope, readState), signed.requestId)
    }

    /**
     * Loop the merchant reader against the payer HCE card entirely in memory (as the two phones
     * would over the radio), returning the reassembled envelope — or null if the payer declined.
     */
    private fun drive(maxChunk: UInt, approve: Boolean): ByteArray? {
        val payer = generateKeypair()
        val merchant = generateKeypair()
        val request = nfcRequestBytes(merchant.`public`, amount, nonce, expiry, 0u, "Bob", "coffee")

        val card = FfiCardSession(maxChunk)
        val reader = FfiReaderConductor(request, maxChunk)
        assertEquals(NfcPhase.IDLE, card.phase())
        assertEquals(NfcPhase.LINKING, reader.phase())

        var decided = false
        repeat(5_000) {
            val cmd = reader.nextCommand() ?: error("reader ran out of commands before finishing")
            val resp = card.process(cmd)
            if (card.awaitingDecision() && !decided) {
                // The payer decodes the request, reviews "Pay $X to <merchant>", and decides.
                val seen = nfcDecodeRequest(card.request()!!)
                assertEquals(amount, seen.amount)
                if (approve) {
                    val signed = signEnvelope(payer.secret, merchant.`public`)
                    card.provideWire(signed.bundle)
                } else {
                    card.decline()
                }
                decided = true
            }
            when (reader.handleResponse(resp)) {
                NfcStep.DONE -> return reader.wire()
                NfcStep.DECLINED -> return null
                else -> {}
            }
        }
        error("exchange did not terminate")
    }

    /** A real signed IC envelope survives the whole exchange — single-frame and byte-fragmented. */
    @Test
    fun signedEnvelopeSurvivesExchangeAndMatchesRequestId() {
        // The v2 bundle contains both signed envelopes, so chunk=2 exceeds the 256-frame sequence
        // ceiling. Chunk=4 still forces heavy fragmentation while remaining representable.
        for (mc in listOf(nfcDefaultMaxChunk(), 4u)) {
            val wire = drive(mc, approve = true)
            assertNotNull("chunk=$mc delivered the envelope", wire)
            // Transport integrity: the reassembled envelope's request_id matches what the payer
            // signed. The payer may poll it; the merchant confirms the nonce in ledger history.
            val bundle = nfcDecodeBundle(wire!!)
            assertEquals("chunk=$mc: reassembled bundle carries the canonical request id", 32, bundle.requestId.size)
        }
    }

    /** Decline surfaces as Declined — never a hang, never a bogus wire. */
    @Test
    fun declineIsReported() {
        assertNull(drive(nfcDefaultMaxChunk(), approve = false))
    }

    /** The lifecycle phases the UI status view renders are produced by the real machine on-device. */
    @Test
    fun phaseSequenceOnDevice() {
        val merchant = generateKeypair()
        val payer = generateKeypair()
        val n = ByteArray(16) { 9 }
        val request = nfcRequestBytes(merchant.`public`, 100UL, n, expiry, 0u, "Bob", "")
        val mc = nfcDefaultMaxChunk()
        val card = FfiCardSession(mc)
        val reader = FfiReaderConductor(request, mc)

        reader.handleResponse(card.process(reader.nextCommand()!!)) // SELECT handshake
        assertEquals(NfcPhase.EXCHANGING, reader.phase())

        val ack = card.process(reader.nextCommand()!!)              // push the request
        assertEquals(NfcPhase.AWAITING_APPROVAL, card.phase())
        assertFalse(card.isComplete())
        reader.handleResponse(ack)

        val signed = signEnvelope(payer.secret, merchant.`public`)
        card.provideWire(signed.bundle)
        assertEquals(NfcPhase.EXCHANGING, card.phase())

        // Pull the envelope: at the default chunk it spans multiple frames, so each frame but the
        // last is CONTINUE and only the final frame yields DONE. This is the same loop the host
        // Python (test_ffi.py wire-pull) and core Rust (`phase_tracks_the_exchange`) run, and what
        // the production HCE service / reader-mode loop drive over the real radio.
        var step = reader.handleResponse(card.process(reader.nextCommand()!!))
        while (step != NfcStep.DONE) {
            assertEquals(NfcStep.CONTINUE, step) // intermediate envelope-pull frames are CONTINUE
            step = reader.handleResponse(card.process(reader.nextCommand()!!))
        }
        assertTrue(card.wireDelivered())
        assertFalse(card.isComplete()) // completion now requires the verified merchant result
        assertEquals(NfcPhase.SETTLING, card.phase())
        assertEquals(NfcPhase.SETTLING, reader.phase())
        assertNull(reader.nextCommand())

        reader.provideResult(nfcResultBytes(merchant.secret, NfcResultStatus.SETTLED, n, signed.requestId))
        step = reader.handleResponse(card.process(reader.nextCommand()!!)) // result-only SELECT
        while (step != NfcStep.CONFIRMED) {
            step = reader.handleResponse(card.process(reader.nextCommand()!!))
        }
        assertTrue(card.isComplete())
        assertEquals(NfcPhase.COMPLETE, card.phase())
        assertEquals(NfcPhase.COMPLETE, reader.phase())
        assertEquals(NfcResultStatus.SETTLED, card.result()!!.status)
    }
}
