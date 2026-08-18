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

    // How long the reader holds the field and retries while a tapped dpay card isn't answering
    // usefully yet — a routed-but-unarmed card (payer not in Pay mode; NOT_READY at SELECT while
    // they open the app) or an exchange that keeps failing at the RF margin during a sloppy
    // physical approach. Bounded so a hopeless tap terminates with a precise, actionable message
    // instead of a generic "Communication error"; every outcome is reported, never silently dropped.
    private const val PAYER_ARM_WAIT_MS = 10_000L
    private const val PAYER_ARM_POLL_MS = 250L

    // dpay "not ready" warning SW (mirrors dpay_core::nfc Sw::NOT_READY) — returned when a reader
    // taps but no payer session is armed.
    private val SW_NOT_READY = byteArrayOf(0x62, 0x10)
    private val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)

    // The IC rail's AID, hex-string form for the CardEmulation repair (must equal the manifest
    // apduservice.xml filter and the core literal — `just aid-parity` checks all three).
    private const val AID_HEX = "F06470617901"

    // The Activity bound as the preferred card service while armed (see [DpayAidRouting]); the OS
    // also drops the binding itself when it leaves the foreground.
    private var preferredOn: Activity? = null

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
        // Repair the OS AID routing if an app update left it stale (see [DpayAidRouting]) — the
        // 6A82-from-the-OS failure mode that reads as "not a dpay phone" on the merchant side.
        preferredOn = ctx?.let { DpayAidRouting.ensure(it, DpayHostApduService::class.java, AID_HEX) }
        phaseEvent("card", "listening")
    }

    fun disarmCard() {
        card = null
        requestSent = false
        receiptSent = false
        DpayAidRouting.clear(preferredOn)
        preferredOn = null
    }

    /** Called by [DpayHostApduService] for every command APDU. Total function — never throws. */
    fun onCardApdu(command: ByteArray): ByteArray {
        val c = card ?: run {
            android.util.Log.w("dpay", "card apdu while UNARMED (${command.size}B) → NOT_READY")
            return SW_NOT_READY // no payer session armed → tell the reader to back off
        }
        return try {
            val resp = c.process(command)
            android.util.Log.i("dpay", "card apdu: cmd=${hex(command)} resp=${hex(resp)}")
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
            errorEvent("card", "Card error — try again")
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
    // The activity reader mode was enabled on. Android's disableReaderMode(activity) must be given
    // an activity instance; if JS calls stopReader when reactContext.currentActivity is momentarily
    // null (activity recreating), the stored reference still lets us tear the RF field down —
    // otherwise reader mode stays ON at the OS level and poisons every later session.
    private var readerActivity: Activity? = null

    /** Enter reader mode and drive the exchange when a payer's phone is tapped (Receive mode). */
    fun startReader(activity: Activity, request: ByteArray) {
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        when {
            adapter == null -> {
                android.util.Log.w("dpay", "startReader: no NFC adapter on this device")
                errorEvent("reader", "This phone has no NFC")
                return
            }
            !adapter.isEnabled -> {
                android.util.Log.w("dpay", "startReader: NFC adapter present but disabled")
                errorEvent("reader", "NFC is off — turn it on in Settings")
                return
            }
        }
        // Restart hygiene: if an earlier session left reader mode registered (stopReader with a
        // null activity), tear it down before re-enabling on this activity.
        stopReader(activity)
        readerActivity = activity
        reader = FfiReaderConductor(request, maxChunk)
        // The nonce lives at request bytes [40, 56): to(32) | amount(8) | nonce(16) | expiry(8).
        readerNonce = if (request.size >= 56) request.copyOfRange(40, 56) else null
        receiptSignal = ArrayBlockingQueue(1)
        pendingReceipt = null
        // NFC-A / ISO-DEP, and skip the NDEF check (HCE cards are not NDEF tags). Some OEM/older
        // builds (e.g. LineageOS on older devices) throw from enableReaderMode — classify + log the
        // stack so a physical re-test pinpoints it instead of a generic "Tap failed".
        try {
            adapter!!.enableReaderMode(
                activity,
                { tag -> onTag(tag) },
                NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
                null,
            )
            phaseEvent("reader", "listening")
            android.util.Log.i("dpay", "startReader: reader mode enabled")
        } catch (e: Throwable) {
            android.util.Log.e("dpay", "enableReaderMode failed", e)
            errorEvent("reader", "Couldn't start NFC (${e.javaClass.simpleName}) — try again")
            stopReader(activity)
        }
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

    fun stopReader(activity: Activity?) {
        // Prefer the activity reader mode was actually enabled on; the caller's currentActivity can
        // be null at teardown while the OS-level reader mode is still polling.
        val target = readerActivity ?: activity
        if (target == null) {
            android.util.Log.w("dpay", "stopReader: no activity reference — reader mode may stay on")
        } else {
            try {
                NfcAdapter.getDefaultAdapter(target)?.disableReaderMode(target)
            } catch (e: Throwable) {
                android.util.Log.w("dpay", "disableReaderMode failed", e)
            }
        }
        readerActivity = null
        reader = null
        readerNonce = null
        receiptSignal = null
        pendingReceipt = null
    }

    /**
     * Runs on a dedicated NFC binder thread (blocking `transceive` is fine here). Drives the reader
     * state machine over the tapped card until it terminates, emitting phases and the final wire.
     *
     * Error policy: a tap discovered during a sloppy physical approach often loses its first
     * exchange at the RF margin — that is EXPECTED physics, not a merchant-flow failure, so it must
     * never kill the session (the JS state machine treats an `error` event as terminal and stops
     * reacting to everything, i.e. "stops scanning"). Transient failures (tag lost, failed
     * exchange) therefore return to the `listening` phase — reader mode stays enabled and the next
     * physical re-tap starts a fresh onTag. Only hopeless cases terminate with an error: bring-up
     * failure, a recovery window that expired while the field still held, or an unexpected throw.
     */
    private fun onTag(tag: Tag) {
        val r = reader ?: return
        android.util.Log.i("dpay", "onTag: techs=${tag.techList.joinToString(",")}")
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            // A non-IsoDep tag (bank card, headphones, passport…) answered the poll — not a dpay
            // phone, but ALSO not a reason to kill the merchant session: log it and keep scanning.
            android.util.Log.w("dpay", "onTag: no IsoDep tech on this tag — ignoring, still listening")
            return
        }
        var wireInHand = false
        try {
            isoDep.connect()
            isoDep.timeout = 5000
            phaseEvent("reader", "linking")
            var recoveryStart = 0L // 0 = not in a recovery window (unarmed card / failing exchange)
            var sawNotReady = false // a 6210 was seen at SELECT — the card IS a routed dpay phone
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
                val step = try {
                    val resp = isoDep.transceive(cmd)
                    android.util.Log.i(
                        "dpay",
                        "onTag exchange: cmd=${hex(cmd)} resp=${hex(resp ?: ByteArray(0))}"
                    )
                    r.handleResponse(resp)
                } catch (e: DpayException) {
                    // The core rejected the card's answer (bad status, short/garbled bytes at the RF
                    // margin, cold-starting HCE…). Early failures leave the conductor in NeedSelect,
                    // so re-SELECTing is protocol-safe. Recover while the field holds — the approach
                    // may simply be sloppy; expire into a terminal, classified error.
                    //
                    // 6A82 at SELECT (NfcNotDpay) is EITHER a genuine non-dpay card OR a dpay phone
                    // whose OS isn't routing the AID to our HCE service right now (payer app killed
                    // by aggressive battery management, screen off) — indistinguishable on the wire.
                    // It therefore gets the SAME bounded recovery window as every other early
                    // failure: a payer waking their phone mid-tap resumes seamlessly, and only a
                    // card held uselessly for the full window terminates (with the precise copy).
                    if (wireInHand) {
                        // The wire is already with JS (it owns the outcome); only the best-effort
                        // receipt push failed. Not a merchant error — the payer independently falls
                        // back to "couldn't confirm".
                        android.util.Log.w("dpay", "onTag: receipt push failed (${classify(e)}) — wire already delivered")
                        break
                    }
                    val now = System.currentTimeMillis()
                    if (recoveryStart == 0L) {
                        recoveryStart = now
                        android.util.Log.w("dpay", "onTag: exchange failed (${classify(e)}) — recovering while the field holds")
                        phaseEvent("reader", "linking")
                    } else if (now - recoveryStart > PAYER_ARM_WAIT_MS) {
                        android.util.Log.w("dpay", "onTag: no useful answer after ${PAYER_ARM_WAIT_MS}ms (${classify(e)})")
                        if (sawNotReady) {
                            // The card identified itself as dpay (6210) but the payer never armed.
                            errorEvent("reader", "The payer’s dpay app isn’t open — ask them to open Pay, then try again")
                        } else if (e is DpayException.NfcNotDpay) {
                            // 6A82-only is EITHER a genuine non-dpay card OR a dpay phone whose OS
                            // isn't routing (stale table on an old build, payer app killed). Copy
                            // must stay honest + actionable for the routing case — it is the common
                            // one among dpay users.
                            errorEvent("reader", "Couldn’t reach a dpay wallet — ask them to open dpay (or toggle NFC off and on), then try again")
                        } else {
                            throw e // hopeless while coupled — terminal, classified by the outer catch
                        }
                        break
                    }
                    Thread.sleep(PAYER_ARM_POLL_MS)
                    continue
                }
                when (step) {
                    NfcStep.CONTINUE -> {
                        recoveryStart = 0L // a real answer — leave the recovery window
                        phaseEvent("reader", uiPhase(r.phase()))
                    }
                    NfcStep.PENDING -> {
                        recoveryStart = 0L
                        phaseEvent("reader", "awaitingApproval")
                        // The payer is still deciding; throttle the re-select poll over the radio.
                        Thread.sleep(120)
                    }
                    NfcStep.WAITING_FOR_PAYER -> {
                        // The dpay card is routed but unarmed (payer not in Pay mode). The core keeps
                        // the reader in NeedSelect — hold the field while the payer opens the app,
                        // then terminate with a precise message if they never do.
                        sawNotReady = true
                        if (recoveryStart == 0L) {
                            recoveryStart = System.currentTimeMillis()
                            android.util.Log.w("dpay", "onTag: dpay card routed but payer session not armed")
                            phaseEvent("reader", "linking")
                        } else if (System.currentTimeMillis() - recoveryStart > PAYER_ARM_WAIT_MS) {
                            android.util.Log.w("dpay", "onTag: payer never armed after ${PAYER_ARM_WAIT_MS}ms")
                            errorEvent("reader", "The payer’s dpay app isn’t open — ask them to open Pay, then try again")
                            break
                        }
                        Thread.sleep(PAYER_ARM_POLL_MS)
                    }
                    NfcStep.DONE -> {
                        recoveryStart = 0L
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
                    else -> {
                        // Exhaustiveness guard: a future NfcStep variant must be handled, not dropped.
                        android.util.Log.w("dpay", "onTag: unhandled NfcStep ${step.javaClass.simpleName}")
                        errorEvent("reader", "Communication error — try again")
                        break
                    }
                }
            }
        } catch (e: TagLostException) {
            // The field broke — expected during a physical approach. Before the wire is in hand this
            // is pure physics: go back to listening (reader mode stays enabled; the next coupling
            // fires a fresh onTag). After the wire is in hand JS already owns the outcome.
            if (wireInHand) {
                android.util.Log.w("dpay", "onTag: tag lost after wire delivered — receipt push abandoned")
            } else {
                android.util.Log.w("dpay", "onTag: tag lost mid-exchange — back to listening", e)
                phaseEvent("reader", "listening")
            }
        } catch (e: DpayException) {
            android.util.Log.w("dpay", "onTag: core protocol error (${classify(e)})", e)
            errorEvent("reader", "Communication error — try again")
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "onTag: unexpected failure (${e.javaClass.simpleName})", e)
            errorEvent("reader", "Tap failed — try again")
        } finally {
            try {
                isoDep.close()
            } catch (_: Throwable) {
            }
        }
    }

    /**
     * uniffi drops the thiserror Display strings (the Kotlin exception message is always ""), so
     * classify by the generated subclass — stable names, used for log breadcrumbs only.
     */
    private fun classify(e: DpayException): String = when (e) {
        is DpayException.NfcProtocol -> "NfcProtocol"
        is DpayException.NfcNotDpay -> "NfcNotDpay"
        is DpayException.NfcWrongState -> "NfcWrongState"
        is DpayException.BadInput -> "BadInput"
        else -> e.javaClass.simpleName
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
