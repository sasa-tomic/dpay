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
import uniffi.dpay_ffi.nfcDecodeReceipt
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcDefaultMaxChunk
import uniffi.dpay_ffi.nfcReceiptBytes
import uniffi.dpay_ffi.nfcReceiptCodes
import uniffi.dpay_ffi.nfcRequestBytes
import uniffi.dpay_ffi.signAuthorization
import uniffi.dpay_ffi.verifyWire

/**
 * Runs the dpay NFC *transport state machines* on a real Android runtime — the exact
 * [FfiCardSession] (payer / HCE) and [FfiReaderConductor] (merchant / reader) that the
 * `DpayHostApduService` and the reader-mode loop drive on a phone. The radio hop between two devices
 * is a physical gate, but every byte of APDU framing, chunk reassembly, and phase logic runs here,
 * so an emulator pass proves the on-device protocol is byte-identical to what Claude tests headlessly
 * in Rust and Python.
 */
@RunWith(AndroidJUnit4::class)
class DpayNfcInstrumentedTest {

    private val amount = 4_200UL
    private val nonce = ByteArray(16) { 7 }
    private val expiry = 4_102_444_800UL

    /**
     * Loop the merchant reader against the payer HCE card entirely in memory (as the two phones
     * would over the radio), returning the reassembled wire — or null if the payer declined.
     */
    private fun drive(maxChunk: UInt, approve: Boolean): ByteArray? {
        val payer = generateKeypair()
        val merchant = generateKeypair()
        val request = nfcRequestBytes(merchant.`public`, amount, nonce, expiry, 0u)

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
                    card.provideWire(signAuthorization(payer.secret, merchant.`public`, amount, nonce, expiry, 0u))
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

    /** A real offline-signed wire survives the whole exchange — single-frame and byte-fragmented. */
    @Test
    fun signedWireSurvivesExchangeAndVerifies() {
        for (mc in listOf(nfcDefaultMaxChunk(), 1u)) {
            val wire = drive(mc, approve = true)
            assertNotNull("chunk=$mc delivered a wire", wire)
            assertEquals("196-byte wire", 196, wire!!.size)
            assertTrue("chunk=$mc: reassembled wire verifies on-device", verifyWire(wire))
        }
    }

    /** Decline surfaces as Declined — never a hang, never a bogus wire. */
    @Test
    fun declineIsReported() {
        assertNull(drive(nfcDefaultMaxChunk(), approve = false))
    }

    /**
     * The complete round trip on-device: request → offline-signed auth → the merchant "settles" →
     * the settlement receipt returns to the (offline) payer, who ends up Confirmed and can read the
     * outcome. This is the full flow the app performs over one tap.
     */
    @Test
    fun receiptReturnsToPayerOnDevice() {
        val payer = generateKeypair()
        val merchant = generateKeypair()
        val request = nfcRequestBytes(merchant.`public`, amount, nonce, expiry, 0u)
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
                card.provideWire(signAuthorization(payer.secret, merchant.`public`, amount, nonce, expiry, 0u))
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
        val request = nfcRequestBytes(merchant.`public`, 100UL, n, expiry, 0u)
        val mc = nfcDefaultMaxChunk()
        val card = FfiCardSession(mc)
        val reader = FfiReaderConductor(request, mc)

        reader.handleResponse(card.process(reader.nextCommand()!!)) // SELECT handshake
        assertEquals(NfcPhase.EXCHANGING, reader.phase())

        val ack = card.process(reader.nextCommand()!!)              // push the request
        assertEquals(NfcPhase.AWAITING_APPROVAL, card.phase())
        assertFalse(card.isComplete())
        reader.handleResponse(ack)

        card.provideWire(signAuthorization(payer.secret, merchant.`public`, 100UL, n, expiry, 0u))
        assertEquals(NfcPhase.EXCHANGING, card.phase())

        val step = reader.handleResponse(card.process(reader.nextCommand()!!)) // pull the wire
        assertEquals(NfcStep.DONE, step)
        assertTrue(card.isComplete()) // the wire left the phone…
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
