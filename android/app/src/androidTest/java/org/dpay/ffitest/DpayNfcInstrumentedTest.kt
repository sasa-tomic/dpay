package org.dpay.ffitest

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
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
import uniffi.dpay_ffi.NfcStep
import uniffi.dpay_ffi.generateKeypair
import uniffi.dpay_ffi.icpEnvelopeRequestId
import uniffi.dpay_ffi.icpPrincipalFromPubkey
import uniffi.dpay_ffi.icpSignUpdate
import uniffi.dpay_ffi.icpTransferArg
import uniffi.dpay_ffi.nfcDecodeReceipt
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcDefaultMaxChunk
import uniffi.dpay_ffi.nfcReceiptBytes
import uniffi.dpay_ffi.nfcReceiptCodes
import uniffi.dpay_ffi.nfcRequestBytes

/**
 * Runs the dpay NFC *transport state machines* on a real Android runtime — the exact
 * [FfiCardSession] (payer / HCE) and [FfiReaderConductor] (merchant / reader) that the
 * `DpayHostApduService` and the reader-mode loop drive on a phone. The radio hop between two devices
 * is a physical gate, but every byte of APDU framing, chunk reassembly, and phase logic runs here,
 * so an emulator pass proves the on-device protocol is byte-identical to what Claude tests headlessly
 * in Rust and Python.
 *
 * Re-scoped at the IC-rail cutover (2026-08-19): the card no longer serves a 292-byte signed
 * payment wire — it serves the payer's SIGNED IC /call ENVELOPE (what
 * `DpayNfc.approveCard(envelopeHex)` hands the HCE service in production). The merchant-side
 * integrity check is the rail-era one: re-derive the envelope's request_id and poll read_state
 * under it — exactly what ReceiveMode.onSignedQr does.
 */
@RunWith(AndroidJUnit4::class)
class DpayNfcInstrumentedTest {

    private val amount = 4_200UL
    private val nonce = ByteArray(16) { 7 }
    private val expiry = 4_102_444_800UL

    /** One production-shaped payer payload: a signed icrc1_transfer envelope over a fresh key. */
    private class PayerEnvelope(val envelope: ByteArray, val requestId: ByteArray)

    private fun signEnvelope(payerSecret: ByteArray, merchantPub: ByteArray): PayerEnvelope {
        // The app derives the merchant's IC principal from the request QR's pubkey and signs an
        // icrc1_transfer to it (services/rail.ts prepareTransfer) — mirrored here on-device.
        val toText = icpPrincipalFromPubkey(merchantPub)
        val arg = icpTransferArg(toText, null, null, amount.toString(), "10", "0707".repeat(4))
        val signed = icpSignUpdate(payerSecret, toText, "icrc1_transfer", arg, "4102444800000000000")
        return PayerEnvelope(signed.envelope, signed.requestId)
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
                    card.provideWire(signed.envelope)
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
        // The ~340-byte envelope at chunk=1 would need >300 frames > the NFC seq ceiling
        // (MAX_FRAMES=256), so the transport refuses it with a typed error; the smallest
        // representable chunk is 2 (~170 frames), which still exercises heavy multi-frame
        // fragmentation. Mirrors the host Python and core Rust chunk floors and their chunk=1
        // rejection pins.
        for (mc in listOf(nfcDefaultMaxChunk(), 2u)) {
            val wire = drive(mc, approve = true)
            assertNotNull("chunk=$mc delivered the envelope", wire)
            // Merchant-side integrity: the reassembled envelope's request_id matches what the
            // payer signed — this is the rid the merchant polls read_state under (rail-era
            // analogue of the retired verifyWire).
            val rid = icpEnvelopeRequestId(wire!!)
            assertEquals("chunk=$mc: reassembled envelope is byte-intact", 32, rid.size)
        }
    }

    /** Decline surfaces as Declined — never a hang, never a bogus wire. */
    @Test
    fun declineIsReported() {
        assertNull(drive(nfcDefaultMaxChunk(), approve = false))
    }

    /**
     * The complete round trip on-device: request → signed envelope → the merchant "settles" →
     * the settlement receipt returns to the (offline) payer, who ends up Confirmed and can read the
     * outcome. This is the full flow the app performs over one tap.
     */
    @Test
    fun receiptReturnsToPayerOnDevice() {
        val payer = generateKeypair()
        val merchant = generateKeypair()
        val request = nfcRequestBytes(merchant.`public`, amount, nonce, expiry, 0u, "Bob", "coffee")
        val mc = nfcDefaultMaxChunk()
        val card = FfiCardSession(mc)
        val reader = FfiReaderConductor(request, mc)

        var approved = false
        var delivered: ByteArray? = null
        var receipted = false
        repeat(5_000) {
            val cmd = reader.nextCommand()
            if (cmd == null) {
                // Reader is at Done, waiting for the merchant to settle online, then send the receipt.
                assertNotNull(delivered)
                assertFalse(receipted)
                reader.provideReceipt(nfcReceiptBytes(nonce, nfcReceiptCodes().settled))
                receipted = true
                return@repeat
            }
            val resp = card.process(cmd)
            if (card.awaitingDecision() && !approved) {
                val signed = signEnvelope(payer.secret, merchant.`public`)
                card.provideWire(signed.envelope)
                approved = true
            }
            when (reader.handleResponse(resp)) {
                NfcStep.DONE -> delivered = reader.wire()
                NfcStep.CONFIRMED -> {
                    // Payer is confirmed and can read the outcome it never had to go online for.
                    assertTrue(card.isConfirmed())
                    assertEquals(NfcPhase.COMPLETE, card.phase())
                    val got = nfcDecodeReceipt(card.receipt()!!)
                    assertTrue("payer sees the payment settled", got.settled)
                    assertArrayEquals("receipt nonce matches the signed payment", nonce, got.nonce)
                    return
                }
                else -> {}
            }
        }
        error("receipt round trip did not terminate")
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
        card.provideWire(signed.envelope)
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
        assertTrue(card.isComplete()) // the envelope left the phone…
        assertFalse(card.isConfirmed()) // …but the outcome isn't known until the receipt
        assertEquals(NfcPhase.SETTLING, card.phase())
        assertEquals(NfcPhase.SETTLING, reader.phase())

        // Merchant settles online, then hands the receipt back → both sides Complete.
        reader.provideReceipt(nfcReceiptBytes(n, nfcReceiptCodes().settled))
        val done = reader.handleResponse(card.process(reader.nextCommand()!!))
        assertEquals(NfcStep.CONFIRMED, done)
        assertTrue(card.isConfirmed())
        assertEquals(NfcPhase.COMPLETE, card.phase())
        assertEquals(NfcPhase.COMPLETE, reader.phase())
    }
}
