package com.dpay

import android.app.Activity
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.TagLostException
import android.nfc.tech.IsoDep
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import uniffi.dpay_ffi.DpayException
import uniffi.dpay_ffi.FfiCardSession
import uniffi.dpay_ffi.FfiReaderConductor
import uniffi.dpay_ffi.NfcPhase
import uniffi.dpay_ffi.NfcStep
import uniffi.dpay_ffi.nfcDecodeReceipt
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcDefaultMaxChunk
import uniffi.dpay_ffi.nfcReceiptBytes

/**
 * Rendezvous between the app's JS layer and the two NFC roles' state machines from the shared core:
 *   • payer  → [FfiCardSession]      (driven by [DpayHostApduService.processCommandApdu])
 *   • merchant → [FfiReaderConductor] (driven by the reader-mode callback over [IsoDep])
 *
 * Both the HCE service and the reader callback run on OS threads outside the Activity, so this
 * singleton is where they meet the app. It only marshals bytes and forwards lifecycle phases /
 * results to JS as `DpayNfcEvent`s — every money/protocol decision stays in the Rust core, the same
 * one Claude tests headlessly (Rust + Python) and on the emulator (instrumented test).
 *
 * The radio hop between two phones is a physical-device gate; everything above the antenna is here.
 */
object DpayNfc {
    const val EVENT = "DpayNfcEvent"

    // A dpay tap moves ~256 bytes, single-frame at this size — near-instant.
    private val maxChunk: UInt = nfcDefaultMaxChunk()

    private var ctx: ReactApplicationContext? = null
    private var card: FfiCardSession? = null
    private var reader: FfiReaderConductor? = null
    private var requestSent = false
    private var receiptSent = false
    // Merchant side: the request nonce (a fallback for stamping the receipt) and a 1-slot rendezvous
    // the reader thread waits on while JS settles online, then delivers the fully-built receipt bytes
    // (see `confirmReceipt`). `pendingReceipt` caches the built receipt so a fast JS confirm that
    // races ahead of the reader thread is not lost.
    private var readerNonce: ByteArray? = null
    private var receiptSignal: ArrayBlockingQueue<ByteArray>? = null
    @Volatile private var pendingReceipt: ByteArray? = null

    // How long the reader holds the field waiting for JS to settle + confirm. Comfortably covers the
    // common fast settle; a timeout is NOT a merchant failure (JS owns the merchant's outcome and the
    // payer falls back to its own "couldn't confirm"), so on timeout we stop delivering *quietly*.
    private const val RECEIPT_CONFIRM_WAIT_SECS = 12L

    // dpay "not ready" warning SW (mirrors dpay_core::nfc Sw::NOT_READY) — returned when a reader
    // taps but no payer session is armed.
    private val SW_NOT_READY = byteArrayOf(0x62, 0x10)
    private val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)

    fun attach(reactContext: ReactApplicationContext) {
        ctx = reactContext
    }

    // ---------------------------------------------------------------- emit helpers
    private fun emit(map: WritableMap) {
        try {
            ctx?.getJSModule(RCTDeviceEventEmitter::class.java)?.emit(EVENT, map)
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "NFC emit failed", e)
        }
    }

    private fun phaseEvent(role: String, phase: String) {
        val m = Arguments.createMap()
        m.putString("type", "phase")
        m.putString("role", role)
        m.putString("phase", phase)
        emit(m)
    }

    private fun errorEvent(role: String, reason: String) {
        val m = Arguments.createMap()
        m.putString("type", "error")
        m.putString("role", role)
        m.putString("reason", reason)
        emit(m)
    }

    /** Map the core lifecycle phase to the UI status string (see the RN NfcSession view). */
    private fun uiPhase(p: NfcPhase): String = when (p) {
        NfcPhase.IDLE -> "listening"
        NfcPhase.LINKING -> "linking"
        NfcPhase.EXCHANGING -> "exchanging"
        NfcPhase.AWAITING_APPROVAL -> "awaitingApproval"
        NfcPhase.SETTLING -> "settling"
        NfcPhase.COMPLETE -> "success"
        NfcPhase.DECLINED -> "declined"
    }

    private val HEXCH = "0123456789abcdef".toCharArray()
    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            sb.append(HEXCH[v ushr 4]).append(HEXCH[v and 0x0f])
        }
        return sb.toString()
    }

    // ============================================================ payer / HCE card
    /** Ready the phone to be tapped as a payment card (Pay mode). */
    fun armCard() {
        card = FfiCardSession(maxChunk)
        requestSent = false
        receiptSent = false
        phaseEvent("card", "listening")
    }

    fun disarmCard() {
        card = null
        requestSent = false
        receiptSent = false
    }

    /** Called by [DpayHostApduService] for every command APDU. Total function — never throws. */
    fun onCardApdu(command: ByteArray): ByteArray {
        val c = card ?: return SW_NOT_READY // no payer session armed → tell the reader to back off
        return try {
            val resp = c.process(command)
            // Surface the request for the payer to review the first time it is fully held.
            if (c.awaitingDecision() && !requestSent) {
                requestSent = true
                emitRequest(c.request())
            }
            // The merchant's receipt has arrived — the offline payer now learns the outcome.
            if (c.isConfirmed() && !receiptSent) {
                receiptSent = true
                emitReceipt(c.receipt())
            }
            phaseEvent("card", uiPhase(c.phase()))
            resp
        } catch (e: Throwable) {
            // The core never panics, but never let an exception escape into the NFC stack.
            SW_WRONG_LENGTH
        }
    }

    private fun emitReceipt(receiptBytes: ByteArray?) {
        val bytes = receiptBytes ?: return
        try {
            val r = nfcDecodeReceipt(bytes)
            val m = Arguments.createMap()
            m.putString("type", "receipt")
            m.putString("role", "card")
            m.putBoolean("settled", r.settled)
            m.putInt("status", r.status.toInt())
            m.putString("nonceHex", hex(r.nonce))
            emit(m)
        } catch (e: Throwable) {
            errorEvent("card", "Received a malformed receipt")
        }
    }

    /** Field dropped between taps. The armed session (and any approval) survives a re-tap. */
    fun onCardDeactivated() {
        val c = card ?: return
        if (c.isComplete()) phaseEvent("card", "success")
    }

    private fun emitRequest(reqBytes: ByteArray?) {
        val bytes = reqBytes ?: return
        try {
            val r = nfcDecodeRequest(bytes)
            val m = Arguments.createMap()
            m.putString("type", "request")
            m.putString("role", "card")
            m.putString("toHex", hex(r.to))
            // MC1 units 2-4: `amount` emitted as an UNSIGNED decimal STRING (the full u64 range,
            // never a lossy Double). r.amount is ULong; toString() is unsigned decimal.
            m.putString("amount", r.amount.toString())
            m.putString("nonceHex", hex(r.nonce))
            m.putDouble("expiry", r.expiry.toDouble())
            m.putInt("currency", r.currency.toInt())
            emit(m)
        } catch (e: Throwable) {
            errorEvent("card", "Received a malformed request")
        }
    }

    /** Approve: the app has signed the wire; serve it to the reader. */
    fun approveCard(wire: ByteArray) {
        val c = card ?: return
        c.provideWire(wire)
        phaseEvent("card", uiPhase(c.phase()))
    }

    fun declineCard() {
        val c = card ?: return
        c.decline()
        phaseEvent("card", "declined")
    }

    // ============================================================ merchant / reader
    /** Enter reader mode and drive the exchange when a payer's phone is tapped (Receive mode). */
    fun startReader(activity: Activity, request: ByteArray) {
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        when {
            adapter == null -> {
                errorEvent("reader", "This phone has no NFC")
                return
            }
            !adapter.isEnabled -> {
                errorEvent("reader", "NFC is off — turn it on in Settings")
                return
            }
        }
        reader = FfiReaderConductor(request, maxChunk)
        // The nonce lives at request bytes [40, 56): to(32) | amount(8) | nonce(16) | expiry(8).
        readerNonce = if (request.size >= 56) request.copyOfRange(40, 56) else null
        receiptSignal = ArrayBlockingQueue(1)
        pendingReceipt = null
        phaseEvent("reader", "listening")
        // NFC-A / ISO-DEP, and skip the NDEF check (HCE cards are not NDEF tags).
        adapter!!.enableReaderMode(
            activity,
            { tag -> onTag(tag) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            null,
        )
    }

    /** JS calls this after settling online with the outcome code (see the core receipt codes:
     *  0 settled, 1 rejected, 2 unreachable) and the authoritative payment nonce (32 hex chars, or
     *  empty to fall back to the request nonce). Builds the receipt and wakes the reader thread. */
    fun confirmReceipt(status: Int, nonce: ByteArray) {
        val stampNonce = if (nonce.size == 16) nonce else (readerNonce ?: ByteArray(16))
        val receipt = try {
            nfcReceiptBytes(stampNonce, status.toUByte())
        } catch (_: Throwable) {
            return // a bad status/nonce can't be a receipt; the payer will time out to "pending"
        }
        pendingReceipt = receipt
        receiptSignal?.offer(receipt)
    }

    fun stopReader(activity: Activity) {
        try {
            NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity)
        } catch (_: Throwable) {
        }
        reader = null
        readerNonce = null
        receiptSignal = null
        pendingReceipt = null
    }

    /**
     * Runs on a dedicated NFC binder thread (blocking `transceive` is fine here). Drives the reader
     * state machine over the tapped card until it terminates, emitting phases and the final wire.
     */
    private fun onTag(tag: Tag) {
        val r = reader ?: return
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            errorEvent("reader", "Not a dpay phone")
            return
        }
        try {
            isoDep.connect()
            isoDep.timeout = 5000
            phaseEvent("reader", "linking")
            var wireInHand = false
            while (true) {
                val cmd = r.nextCommand()
                if (cmd == null) {
                    // The reader is at Done, waiting for the merchant to settle online and confirm.
                    if (!wireInHand) break
                    phaseEvent("reader", "settling")
                    // Deliver the receipt if JS already settled (fast path), else hold the field a
                    // bounded time for it. A timeout is NOT a merchant error: JS has already decided
                    // and reported the merchant's outcome, and the offline payer independently falls
                    // back to "couldn't confirm". So on timeout we simply stop delivering — quietly,
                    // never a false "Tap failed".
                    val receipt = pendingReceipt ?: receiptSignal?.poll(RECEIPT_CONFIRM_WAIT_SECS, TimeUnit.SECONDS)
                    if (receipt == null) break
                    r.provideReceipt(receipt)
                    continue // resume the loop to push the receipt back to the payer
                }
                val resp = isoDep.transceive(cmd)
                when (r.handleResponse(resp)) {
                    NfcStep.CONTINUE -> phaseEvent("reader", uiPhase(r.phase()))
                    NfcStep.PENDING -> {
                        phaseEvent("reader", "awaitingApproval")
                        // The payer is still deciding; throttle the re-select poll over the radio.
                        Thread.sleep(120)
                    }
                    NfcStep.DONE -> {
                        // The signed wire is in hand → hand it to JS to submit online; keep the field.
                        wireInHand = true
                        emitDone(r.wire())
                    }
                    NfcStep.CONFIRMED -> {
                        emitConfirmed()
                        break
                    }
                    NfcStep.DECLINED -> {
                        phaseEvent("reader", "declined")
                        break
                    }
                }
            }
        } catch (e: TagLostException) {
            errorEvent("reader", "Phones moved apart — try again")
        } catch (e: DpayException) {
            errorEvent("reader", "Communication error — try again")
        } catch (e: Throwable) {
            errorEvent("reader", "Tap failed — try again")
        } finally {
            try {
                isoDep.close()
            } catch (_: Throwable) {
            }
        }
    }

    private fun emitDone(wire: ByteArray?) {
        if (wire == null) {
            errorEvent("reader", "No authorization received")
            return
        }
        val m = Arguments.createMap()
        m.putString("type", "done")
        m.putString("role", "reader")
        m.putString("wireHex", hex(wire))
        emit(m)
    }

    /** The receipt was delivered to the payer — the tap is fully complete on the merchant side. */
    private fun emitConfirmed() {
        val m = Arguments.createMap()
        m.putString("type", "confirmed")
        m.putString("role", "reader")
        emit(m)
    }
}
