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
import uniffi.dpay_ffi.DpayException
import uniffi.dpay_ffi.FfiCardSession
import uniffi.dpay_ffi.FfiReaderConductor
import uniffi.dpay_ffi.NfcPhase
import uniffi.dpay_ffi.NfcResultStatus
import uniffi.dpay_ffi.NfcStep
import uniffi.dpay_ffi.nfcBundleBytes
import uniffi.dpay_ffi.nfcDecodeBundle
import uniffi.dpay_ffi.nfcDecodeRequest
import uniffi.dpay_ffi.nfcDefaultMaxChunk
import uniffi.dpay_ffi.nfcResultBytes

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

    // The request and opaque signed envelope are fragmented at this payload size.
    private val maxChunk: UInt = nfcDefaultMaxChunk()

    private var ctx: ReactApplicationContext? = null
    private val cardLock = Any()
    private var card: FfiCardSession? = null
    private var requestSent = false
    private var wireDelivered = false
    private var resultDelivered = false

    // Reader callbacks outlive the JS call that created them and may still be unwinding when a
    // replacement session starts. Keep the conductor + Activity behind one identity token so an
    // old onTag thread can only touch its captured conductor, and can never emit for or tear down
    // the replacement. All current-session checks and reader-mode lifecycle changes are serialized
    // on readerLock; holding the lock through an emit makes the check + emit atomic vs replacement.
    private val readerLock = Any()
    private var readerGeneration = 0L
    private data class ReaderSession(
        val generation: Long,
        val conductor: FfiReaderConductor,
        val activity: Activity,
    )
    private var readerSession: ReaderSession? = null

    // How long the reader holds the field and retries while a tapped dpay card isn't answering
    // usefully yet — a routed-but-unarmed card (payer not in Pay mode; NOT_READY at SELECT while
    // they open the app) or an exchange that keeps failing at the RF margin during a sloppy
    // physical approach. Bounded so a hopeless tap terminates with a precise, actionable message
    // instead of a generic "Communication error"; every outcome is reported, never silently dropped.
    private const val PAYER_ARM_WAIT_MS = 10_000L
    private const val PAYER_ARM_POLL_MS = 250L
    private const val RESULT_WAIT_MS = 35_000L
    private const val RESULT_POLL_MS = 25L

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

    private fun isCurrentReaderLocked(session: ReaderSession): Boolean =
        readerSession === session && readerGeneration == session.generation

    private fun isCurrentReader(session: ReaderSession): Boolean = synchronized(readerLock) {
        isCurrentReaderLocked(session)
    }

    private fun readerPhaseEvent(session: ReaderSession, phase: String) {
        synchronized(readerLock) {
            if (isCurrentReaderLocked(session)) phaseEvent("reader", phase)
        }
    }

    private fun readerErrorEvent(session: ReaderSession, reason: String) {
        synchronized(readerLock) {
            if (isCurrentReaderLocked(session)) errorEvent("reader", reason)
        }
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
        synchronized(cardLock) {
            card = FfiCardSession(maxChunk)
            requestSent = false
            wireDelivered = false
            resultDelivered = false
        }
        // Repair the OS AID routing if an app update left it stale (see [DpayAidRouting]) — the
        // 6A82-from-the-OS failure mode that reads as "not a dpay phone" on the merchant side.
        preferredOn = ctx?.let { DpayAidRouting.ensure(it, DpayHostApduService::class.java, AID_HEX) }
        phaseEvent("card", "listening")
    }

    fun disarmCard() {
        synchronized(cardLock) {
            card = null
            requestSent = false
            wireDelivered = false
            resultDelivered = false
        }
        DpayAidRouting.clear(preferredOn)
        preferredOn = null
    }

    /** Called by [DpayHostApduService] for every command APDU. Total function — never throws. */
    fun onCardApdu(command: ByteArray): ByteArray = synchronized(cardLock) {
        val c = card ?: run {
            android.util.Log.w("dpay", "card apdu while UNARMED (${command.size}B) → NOT_READY")
            return@synchronized SW_NOT_READY // no payer session armed → tell the reader to back off
        }
        return try {
            val resp = c.process(command)
            android.util.Log.i("dpay", "card apdu: cmd=${hex(command)} resp=${hex(resp)}")
            // Surface the request for the payer to review the first time it is fully held.
            if (c.awaitingDecision() && !requestSent) {
                requestSent = true
                emitRequest(c.request())
            }
            if (c.wireDelivered() && !wireDelivered) {
                wireDelivered = true
                phaseEvent("card", "settling")
                emitCardDelivered()
            }
            if (c.isComplete() && !resultDelivered) {
                resultDelivered = true
                emitResult(c.result())
                phaseEvent("card", "success")
            } else if (!c.isComplete()) {
                phaseEvent("card", uiPhase(c.phase()))
            }
            resp
        } catch (e: Throwable) {
            // The core never panics, but never let an exception escape into the NFC stack.
            errorEvent("card", "Card error — try again")
            SW_WRONG_LENGTH
        }
    }

    /** Field dropped between taps. The armed session (and any approval) survives a re-tap. */
    fun onCardDeactivated() {
        card ?: return
    }

    private fun emitCardDelivered() {
        val m = Arguments.createMap()
        m.putString("type", "done")
        m.putString("role", "card")
        emit(m)
    }

    private fun emitResult(result: uniffi.dpay_ffi.NfcCardResult?) {
        val r = result ?: return
        val m = Arguments.createMap()
        m.putString("type", "result")
        m.putString("role", "card")
        m.putInt("status", when (r.status) {
            NfcResultStatus.SETTLED -> 0
            NfcResultStatus.REJECTED -> 1
            NfcResultStatus.UNKNOWN -> 2
        })
        m.putString("nonceHex", hex(r.nonce))
        m.putString("requestIdHex", hex(r.requestId))
        emit(m)
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
            // Approve-before-pay review card (QR parity): the payee's display name + memo ride the
            // wire's 32-byte name field / memo field (NUL-trimmed by the core decode). The TS
            // NfcEvent types them optional; the review shows "to <name>" + short key, or the short
            // key alone when no name was set (a name is never shown without the key).
            m.putString("toName", r.toName)
            m.putString("memo", r.memo)
            emit(m)
        } catch (e: Throwable) {
            errorEvent("card", "Received a malformed request")
        }
    }

    /** Approve: the app has signed the wire; serve it to the reader. */
    fun approveCard(update: ByteArray, readState: ByteArray, nonce: ByteArray) = synchronized(cardLock) {
        val c = card ?: throw IllegalStateException("no active NFC card")
        val activeNonce = nfcDecodeRequest(c.request() ?: throw IllegalStateException("NFC card has no request")).nonce
        require(activeNonce.contentEquals(nonce)) { "NFC approval does not match the active request" }
        c.provideWire(nfcBundleBytes(update, readState))
        phaseEvent("card", uiPhase(c.phase()))
    }

    fun declineCard(nonce: ByteArray) = synchronized(cardLock) {
        val c = card ?: throw IllegalStateException("no active NFC card")
        val activeNonce = nfcDecodeRequest(c.request() ?: throw IllegalStateException("NFC card has no request")).nonce
        require(activeNonce.contentEquals(nonce)) { "NFC decline does not match the active request" }
        c.decline()
        phaseEvent("card", "declined")
    }

    /** Merchant settlement owner: sign and queue exactly one nonce/request-id-bound result. */
    fun confirmResult(status: Int, nonce: ByteArray, requestId: ByteArray, merchantSecret: ByteArray) {
        val mapped = when (status) {
            0 -> NfcResultStatus.SETTLED
            1 -> NfcResultStatus.REJECTED
            else -> NfcResultStatus.UNKNOWN
        }
        val bytes = nfcResultBytes(merchantSecret, mapped, nonce, requestId)
        synchronized(readerLock) {
            val session = readerSession ?: throw IllegalStateException("no active NFC reader")
            // A JS settlement may finish after its native session was replaced. Only the session
            // that actually delivered this DPN2 bundle may receive its result.
            val delivered = session.conductor.wire()
                ?: throw IllegalStateException("active NFC reader has not delivered a payment bundle")
            val deliveredRequestId = nfcDecodeBundle(delivered).requestId
            if (!deliveredRequestId.contentEquals(requestId)) {
                throw IllegalArgumentException("NFC result request ID does not match the active reader bundle")
            }
            session.conductor.provideResult(bytes)
            phaseEvent("reader", "exchanging")
        }
    }

    // ============================================================ merchant / reader
    // Android's disableReaderMode(activity) must receive the Activity reader mode was enabled on.
    // ReaderSession retains that exact instance even while currentActivity is momentarily null.

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
        // Preserve the existing fail-loud contract for malformed requests: conductor creation
        // throws to DpayNfcModule before the current native reader is disturbed.
        val conductor = FfiReaderConductor(request, maxChunk)
        var attemptedSession: ReaderSession? = null
        // NFC-A / ISO-DEP, and skip the NDEF check (HCE cards are not NDEF tags). Some OEM/older
        // builds (e.g. LineageOS on older devices) throw from enableReaderMode — classify + log the
        // stack so a physical re-test pinpoints it instead of a generic "Tap failed".
        try {
            synchronized(readerLock) {
                // Restart hygiene and atomic replacement: invalidate + disable the prior session
                // before publishing or enabling the new callback.
                stopCurrentReaderLocked(activity)
                readerGeneration += 1
                val session = ReaderSession(
                    readerGeneration,
                    conductor,
                    activity,
                )
                attemptedSession = session
                readerSession = session
                adapter!!.enableReaderMode(
                    activity,
                    { tag -> onTag(tag, session) },
                    NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
                    null,
                )
            }
            val session = checkNotNull(attemptedSession)
            readerPhaseEvent(session, "listening")
            android.util.Log.i("dpay", "startReader: reader mode enabled")
        } catch (e: Throwable) {
            android.util.Log.e("dpay", "enableReaderMode failed", e)
            // If a concurrent start already replaced this failed attempt, neither the error nor
            // teardown belongs to that replacement.
            val failed = attemptedSession
            if (failed != null) {
                readerErrorEvent(failed, "Couldn't start NFC (${e.javaClass.simpleName}) — try again")
                stopReaderIfCurrent(failed)
            }
        }
    }

    fun stopReader(activity: Activity?) {
        synchronized(readerLock) {
            stopCurrentReaderLocked(activity)
        }
    }

    /** Stop only [session]; a stale onTag callback must never disable or clear its replacement. */
    private fun stopReaderIfCurrent(session: ReaderSession): Boolean = synchronized(readerLock) {
        if (!isCurrentReaderLocked(session)) return@synchronized false
        stopCurrentReaderLocked(session.activity)
        true
    }

    /** readerLock must be held. Invalidates the current identity before touching Android reader mode. */
    private fun stopCurrentReaderLocked(fallbackActivity: Activity?) {
        val current = readerSession
        val target = current?.activity ?: fallbackActivity
        readerSession = null
        readerGeneration += 1
        if (target == null) {
            android.util.Log.w("dpay", "stopReader: no activity reference — reader mode may stay on")
        } else {
            try {
                NfcAdapter.getDefaultAdapter(target)?.disableReaderMode(target)
            } catch (e: Throwable) {
                android.util.Log.w("dpay", "disableReaderMode failed", e)
            }
        }
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
    private fun onTag(tag: Tag, session: ReaderSession) {
        if (!isCurrentReader(session)) return
        val r = session.conductor
        android.util.Log.i("dpay", "onTag: techs=${tag.techList.joinToString(",")}")
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            // A non-IsoDep tag (bank card, headphones, passport…) answered the poll — not a dpay
            // phone, but ALSO not a reason to kill the merchant session: log it and keep scanning.
            android.util.Log.w("dpay", "onTag: no IsoDep tech on this tag — ignoring, still listening")
            return
        }
        var wireInHand = false
        var resultWaitStart = 0L
        try {
            isoDep.connect()
            isoDep.timeout = 5000
            readerPhaseEvent(session, "linking")
            var recoveryStart = 0L // 0 = not in a recovery window (unarmed card / failing exchange)
            var sawNotReady = false // a 6210 was seen at SELECT — the card IS a routed dpay phone
            while (true) {
                if (!isCurrentReader(session)) break
                val cmd = r.nextCommand()
                if (cmd == null) {
                    if (wireInHand && System.currentTimeMillis() - resultWaitStart < RESULT_WAIT_MS) {
                        Thread.sleep(RESULT_POLL_MS)
                        continue
                    }
                    break
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
                    // margin, cold-starting HCE…). Recover while the field holds — the approach may
                    // simply be sloppy; expire into a terminal, classified error.
                    //
                    // 6A82 at SELECT (NfcNotDpay) is EITHER a genuine non-dpay card OR a dpay phone
                    // whose OS isn't routing the AID to our HCE service right now (payer app killed
                    // by aggressive battery management, screen off) — indistinguishable on the wire.
                    // It therefore gets the SAME bounded recovery window as every other early
                    // failure: a payer waking their phone mid-tap resumes seamlessly, and only a
                    // card held uselessly for the full window terminates (with the precise copy).
                    // A failed response can leave the conductor midway through request push,
                    // bundle pull, or result push. Explicitly abandon that RF link so every retry
                    // starts with SELECT and both peers restart framing from zero.
                    r.resetLink()
                    if (wireInHand) {
                        android.util.Log.w("dpay", "onTag: protocol error after wire delivered (${classify(e)})")
                        break
                    }
                    val now = System.currentTimeMillis()
                    if (recoveryStart == 0L) {
                        recoveryStart = now
                        android.util.Log.w("dpay", "onTag: exchange failed (${classify(e)}) — recovering while the field holds")
                        readerPhaseEvent(session, "linking")
                    } else if (now - recoveryStart > PAYER_ARM_WAIT_MS) {
                        android.util.Log.w("dpay", "onTag: no useful answer after ${PAYER_ARM_WAIT_MS}ms (${classify(e)})")
                        if (sawNotReady) {
                            // The card identified itself as dpay (6210) but the payer never armed.
                            readerErrorEvent(session, "The payer’s dpay app isn’t open — ask them to open Pay, then try again")
                        } else if (e is DpayException.NfcNotDpay) {
                            // 6A82-only is EITHER a genuine non-dpay card OR a dpay phone whose OS
                            // isn't routing (stale table on an old build, payer app killed). Copy
                            // must stay honest + actionable for the routing case — it is the common
                            // one among dpay users.
                            readerErrorEvent(session, "Couldn’t reach a dpay wallet — ask them to open dpay (or toggle NFC off and on), then try again")
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
                        readerPhaseEvent(session, uiPhase(r.phase()))
                    }
                    NfcStep.PENDING -> {
                        recoveryStart = 0L
                        readerPhaseEvent(session, "awaitingApproval")
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
                            readerPhaseEvent(session, "linking")
                        } else if (System.currentTimeMillis() - recoveryStart > PAYER_ARM_WAIT_MS) {
                            android.util.Log.w("dpay", "onTag: payer never armed after ${PAYER_ARM_WAIT_MS}ms")
                            readerErrorEvent(session, "The payer’s dpay app isn’t open — ask them to open Pay, then try again")
                            break
                        }
                        Thread.sleep(PAYER_ARM_POLL_MS)
                    }
                    NfcStep.DONE -> {
                        recoveryStart = 0L
                        wireInHand = true
                        readerPhaseEvent(session, "settling")
                        emitDone(session, r.wire())
                        resultWaitStart = System.currentTimeMillis()
                    }
                    NfcStep.AWAITING_RESULT -> {
                        wireInHand = true
                        resultWaitStart = System.currentTimeMillis()
                        readerPhaseEvent(session, "settling")
                    }
                    NfcStep.CONFIRMED -> {
                        readerPhaseEvent(session, "success")
                        emitConfirmed(session)
                        // Keep reader mode through the terminal view. Disabling it while the phones
                        // are coupled lets Android rediscover the payer as an unrelated generic tag.
                        android.util.Log.i("dpay", "onTag: confirmed; retaining reader mode until UI teardown")
                        break
                    }
                    NfcStep.DECLINED -> {
                        readerPhaseEvent(session, "declined")
                        break
                    }
                }
            }
        } catch (e: TagLostException) {
            // The field broke — expected during a physical approach. Before the wire is in hand this
            // is pure physics: go back to listening (reader mode stays enabled; the next coupling
            // fires a fresh onTag). After the wire is in hand JS already owns the outcome.
            r.resetLink()
            if (wireInHand) {
                android.util.Log.w("dpay", "onTag: tag lost after wire delivered")
            } else {
                android.util.Log.w("dpay", "onTag: tag lost mid-exchange — back to listening", e)
                readerPhaseEvent(session, "listening")
            }
        } catch (e: DpayException) {
            r.resetLink()
            android.util.Log.w("dpay", "onTag: core protocol error (${classify(e)})", e)
            readerErrorEvent(session, "Communication error — try again")
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "onTag: unexpected failure (${e.javaClass.simpleName})", e)
            readerErrorEvent(session, "Tap failed — try again")
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

    private fun emitDone(session: ReaderSession, wire: ByteArray?) {
        if (wire == null) {
            readerErrorEvent(session, "No authorization received")
            return
        }
        try {
            val bundle = nfcDecodeBundle(wire)
            val m = Arguments.createMap()
            m.putString("type", "done")
            m.putString("role", "reader")
            m.putString("envelopeHex", hex(bundle.update))
            m.putString("readStateEnvelopeHex", hex(bundle.readState))
            m.putString("requestIdHex", hex(bundle.requestId))
            synchronized(readerLock) {
                if (isCurrentReaderLocked(session)) emit(m)
            }
        } catch (e: Throwable) {
            readerErrorEvent(session, "Received a malformed payment bundle")
        }
    }

    private fun emitConfirmed(session: ReaderSession) {
        val m = Arguments.createMap()
        m.putString("type", "confirmed")
        m.putString("role", "reader")
        synchronized(readerLock) {
            if (isCurrentReaderLocked(session)) emit(m)
        }
    }

}
