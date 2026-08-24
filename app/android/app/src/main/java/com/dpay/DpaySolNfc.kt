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
import org.json.JSONObject
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * SOL NFC tap rendezvous — a SECOND, fully-independent transport for the SOL durable-nonce rail.
 *
 * Unlike [DpayNfc] (a thin Kotlin loop over the shared Rust core carrying the frozen IC wire), this
 * is PURE KOTLIN with NO Rust core, NO UniFFI, NO dpay-core dependency. It carries opaque
 * `solreq:`/`solpay:` URI strings + a small JSON receipt between the two phones; every money/protocol
 * decision (decode, sign, broadcast) stays in jest-tested JS. The AID is `F0 64 70 61 79 02` ("dpay"
 * + v2/SOL) — distinct from the IC AID so both transports coexist.
 *
 * The payer (card) and merchant (reader) meet here on OS threads outside the Activity; this object
 * only marshals strings and forwards lifecycle phases / results to JS as `DpaySolNfcEvent`s.
 */
object DpaySolNfc {
    const val EVENT = "DpaySolNfcEvent"

    // Variable-length URI chunking. A solpay: URI can run ~600 bytes (base64url tx); the protocol
    // streams it in MAX_CHUNK frames with a continuation bit, reassembled on the other side.
    private const val MAX_CHUNK = 240
    // How long the reader holds the field waiting for the payer's APPROVE click + the JS offline
    // sign (approve-before-pay: the request parks on a review card until the payer clicks; the
    // card answers SW_WRONG_STATE while they decide). 30s still fits INSIDE the request's frozen
    // 90s blockhash window (SOL_PAYMENT_MAX_WINDOW_SECONDS — sign against an older-valid window
    // and the tx is unlandable), with headroom for one re-tap.
    private const val PAYMENT_WAIT_SECS = 30L
    // How long the reader holds the field waiting for JS to stamp + offer the receipt back.
    private const val RECEIPT_CONFIRM_WAIT_SECS = 12L
    // How long the SOL reader holds the field and retries while the tapped dpay card isn't answering
    // usefully yet — routed-but-unarmed (6210 at SELECT: payer hasn't opened Pay mode) or failing at
    // the RF margin during a sloppy approach. Mirrors the IC rail's PAYER_ARM_WAIT_MS.
    private const val SOL_PAYER_ARM_WAIT_MS = 10_000L
    private const val SOL_PAYER_ARM_POLL_MS = 250L

    // APDU protocol constants. PUT/GET carry a tag in P1 (REQUEST/PAYMENT/RECEIPT); the continuation
    // bit in P2 (1 = more frames follow for this tag) lets a variable-length string stream across.
    private val SOL_AID = byteArrayOf(0xF0.toByte(), 0x64, 0x70, 0x61, 0x79, 0x02)
    // The same AID as a hex string for the CardEmulation routing repair (see [DpayAidRouting]) —
    // parity-checked against solapduservice.xml by `just aid-parity`, like SOL_AID above.
    private const val SOL_AID_HEX = "F06470617902"
    private val INS_PUT: Byte = 0xD0.toByte()
    private val INS_GET: Byte = 0xD1.toByte()
    private val TAG_REQUEST: Byte = 0x01
    private val TAG_PAYMENT: Byte = 0x02
    private val TAG_RECEIPT: Byte = 0x03

    private val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    private val SW_NOT_READY = byteArrayOf(0x62, 0x10)
    private val SW_WRONG_STATE = byteArrayOf(0x69, 0x86.toByte())
    private val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)
    // Terminal decline (same status word the IC rail uses): the payer pressed Decline on the
    // review card. Distinct from SW_WRONG_STATE ("still deciding") so the reader can stop polling
    // immediately instead of burning its whole wait window.
    private val SW_DECLINED = byteArrayOf(0x69, 0x85.toByte())
    private val SELECT_HEADER = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00)

    private enum class CardPhase { IDLE, LINKING, AWAITING_PAYMENT, EXCHANGING, SETTLING, SUCCESS, DECLINED, PENDING }

    private var ctx: ReactApplicationContext? = null

    // ---- card (payer) state ----
    @Volatile private var cardArmed = false
    @Volatile private var cardPhase = CardPhase.IDLE
    // The Activity bound as the preferred card service while armed (see [DpayAidRouting]); the OS
    // also drops the binding itself when it leaves the foreground.
    private var preferredOn: Activity? = null
    private var solpayUri: String? = null
    private var solpaySendCursor = 0
    // The 1-slot rendezvous JS offers the signed solpay: URI into (after autoSign) for the card to
    // serve on the next GET-payment. A fast JS sign that races ahead of the reader's poll is cached.
    private var paymentSignal: ArrayBlockingQueue<String>? = null
    @Volatile private var pendingPayment: String? = null
    // Reassembly buffer for an incoming chunked solreq: (the merchant's request to the payer).
    private var requestBuffer = StringBuilder()

    // ---- reader (merchant) state ----
    @Volatile private var readerIsoDep: IsoDep? = null
    // The activity reader mode was enabled on (see DpayNfc.readerActivity — same teardown rationale).
    private var readerActivity: Activity? = null
    // The 1-slot rendezvous JS offers the stamped receipt JSON into (after broadcasting online) for
    // the reader thread to deliver back to the payer. `pendingReceipt` caches it for the fast path.
    private var receiptSignal: ArrayBlockingQueue<String>? = null
    @Volatile private var pendingReceipt: String? = null

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

    private fun emitRequest(solreqUri: String) {
        val m = Arguments.createMap()
        m.putString("type", "request")
        m.putString("role", "card")
        m.putString("solreqUri", solreqUri)
        emit(m)
    }

    private fun emitPayment(solpayUri: String) {
        val m = Arguments.createMap()
        m.putString("type", "payment")
        m.putString("role", "reader")
        m.putString("solpayUri", solpayUri)
        emit(m)
    }

    private fun emitReceipt(status: Int, rid: String, sig: String) {
        val m = Arguments.createMap()
        m.putString("type", "receipt")
        m.putString("role", "card")
        m.putInt("status", status)
        m.putString("rid", rid)
        m.putString("sig", sig)
        emit(m)
    }

    private fun emitConfirmed() {
        val m = Arguments.createMap()
        m.putString("type", "confirmed")
        m.putString("role", "reader")
        emit(m)
    }

    private fun cardPhaseName(p: CardPhase): String = when (p) {
        CardPhase.IDLE -> "listening"
        CardPhase.LINKING -> "linking"
        CardPhase.AWAITING_PAYMENT -> "awaitingApproval"
        CardPhase.EXCHANGING -> "exchanging"
        CardPhase.SETTLING -> "settling"
        CardPhase.SUCCESS -> "success"
        CardPhase.DECLINED -> "declined"
        CardPhase.PENDING -> "pending"
    }

    // ============================================================ payer / HCE card
    /** Ready the phone to be tapped as a payment card (SolPay mode). */
    fun armCard() {
        cardArmed = true
        cardPhase = CardPhase.IDLE
        solpayUri = null
        solpaySendCursor = 0
        pendingPayment = null
        requestBuffer.setLength(0)
        paymentSignal = ArrayBlockingQueue(1)
        // Repair the OS AID routing if an app update left it stale (see [DpayAidRouting]).
        preferredOn = ctx?.let { DpayAidRouting.ensure(it, DpaySolHostApduService::class.java, SOL_AID_HEX) }
        phaseEvent("card", "listening")
    }

    fun disarmCard() {
        cardArmed = false
        cardPhase = CardPhase.IDLE
        solpayUri = null
        solpaySendCursor = 0
        pendingPayment = null
        requestBuffer.setLength(0)
        paymentSignal = null
        DpayAidRouting.clear(preferredOn)
        preferredOn = null
    }

    /** Called by [DpaySolHostApduService] for every command APDU. Total function — never throws. */
    fun onCardApdu(command: ByteArray): ByteArray {
        if (command.size < 4) return SW_WRONG_LENGTH
        return try {
            val cla = command[0]; val ins = command[1]; val p1 = command[2]; val p2 = command[3]
            if (cla == 0x00.toByte() && ins == 0xA4.toByte()) return handleSelect(command)
            if (!cardArmed) {
                android.util.Log.w("dpay", "sol card apdu while UNARMED (${command.size}B) → NOT_READY")
                return SW_NOT_READY
            }
            val resp = when (ins) {
                INS_PUT -> handlePut(p1, (p2.toInt() and 1) != 0, command.copyOfRange(4, command.size))
                INS_GET -> handleGet(p1)
                else -> SW_WRONG_LENGTH
            }
            android.util.Log.i("dpay", "sol card apdu: cmd=${hex(command)} resp=${hex(resp)}")
            resp
        } catch (_: Throwable) {
            // Never let an exception escape into the NFC stack.
            errorEvent("card", "Card error — try again")
            SW_WRONG_LENGTH
        }
    }

    private fun handleSelect(command: ByteArray): ByteArray {
        if (!cardArmed) {
            android.util.Log.w("dpay", "sol card SELECT while UNARMED → NOT_READY")
            return SW_NOT_READY
        }
        // The AID rides in the data field (after the 4-byte header + Lc). Match against SOL_AID.
        val lc = if (command.size > 4) command[4].toInt() and 0xff else 0
        val dataStart = 5
        if (dataStart + lc > command.size) return SW_WRONG_LENGTH
        val data = command.copyOfRange(dataStart, dataStart + lc)
        if (!data.contentEquals(SOL_AID)) return SW_NOT_READY
        cardPhase = CardPhase.LINKING
        phaseEvent("card", "linking")
        return SW_OK
    }

    private fun handlePut(tag: Byte, more: Boolean, chunk: ByteArray): ByteArray {
        // Append the UTF-8 chunk to the tag's reassembly buffer; on the final frame, dispatch.
        val text = String(chunk, Charsets.UTF_8)
        when (tag) {
            TAG_REQUEST -> {
                requestBuffer.append(text)
                if (!more) {
                    val uri = requestBuffer.toString()
                    requestBuffer.setLength(0)
                    cardPhase = CardPhase.AWAITING_PAYMENT
                    emitRequest(uri)
                    // The truthful card state while the payer reviews (JS parks the tap in
                    // 'review'; the old "exchanging" described auto-signing, which is gone).
                    phaseEvent("card", "awaitingApproval")
                }
            }
            TAG_RECEIPT -> {
                // A receipt from the merchant arrives only once the payer's solpay was served; we
                // parse it inline and emit it for the payer's JS to decide the outcome.
                requestBuffer.append(text)
                if (!more) {
                    val json = requestBuffer.toString()
                    requestBuffer.setLength(0)
                    try {
                        val o = JSONObject(json)
                        val status = o.optInt("status", 2)
                        val rid = o.optString("rid", "")
                        val sig = o.optString("sig", "")
                        when (status) {
                            0 -> { cardPhase = CardPhase.SUCCESS; phaseEvent("card", "success") }
                            1 -> { cardPhase = CardPhase.DECLINED; phaseEvent("card", "declined") }
                            else -> { cardPhase = CardPhase.PENDING; phaseEvent("card", "pending") }
                        }
                        emitReceipt(status, rid, sig)
                    } catch (_: Throwable) {
                        errorEvent("card", "Received a malformed receipt")
                        cardPhase = CardPhase.PENDING
                        phaseEvent("card", "pending")
                    }
                }
            }
            else -> return SW_WRONG_STATE
        }
        return SW_OK
    }

    private fun handleGet(tag: Byte): ByteArray {
        if (tag != TAG_PAYMENT) return SW_WRONG_STATE
        // The payer DECLINED on the review card — answer with the terminal status word so the
        // reader stops polling NOW instead of burning its whole PAYMENT_WAIT_SECS window and then
        // misreporting a generic failure.
        if (cardPhase == CardPhase.DECLINED) return SW_DECLINED
        // No signed solpay ready yet — peek for a fast JS sign that raced ahead, else the reader
        // backs off and retries (SW_WRONG_STATE). Once JS offers the URI it is cached in solpayUri.
        if (solpayUri == null) {
            val polled = pendingPayment ?: paymentSignal?.peek()
            if (polled == null) return SW_WRONG_STATE
            solpayUri = polled
            cardPhase = CardPhase.SETTLING
            phaseEvent("card", "settling")
        }
        return sliceSolpay(solpayUri!!)
    }

    /** Slice one MAX_CHUNK frame off solpayUri from the cursor. The response is `[more, ...chunk, SW]`
     *  — the reader strips the leading more-flag + trailing SW and appends until more == 0. */
    private fun sliceSolpay(uri: String): ByteArray {
        val bytes = uri.toByteArray(Charsets.UTF_8)
        val cursor = solpaySendCursor
        if (cursor >= bytes.size) {
            solpaySendCursor = 0
            return byteArrayOf(0x00, *SW_OK) // defensive empty final frame
        }
        val end = minOf(cursor + MAX_CHUNK, bytes.size)
        val chunk = bytes.copyOfRange(cursor, end)
        val more = if (end < bytes.size) 1 else 0
        solpaySendCursor = end
        return byteArrayOf(more.toByte(), *chunk, *SW_OK)
    }

    /** Field dropped between taps. */
    fun onCardDeactivated() {
        if (cardPhase == CardPhase.SUCCESS) phaseEvent("card", "success")
    }

    /** JS calls this after autoSign: hand the signed solpay: URI for the card to serve. */
    fun approveSolCard(uri: String) {
        pendingPayment = uri
        paymentSignal?.offer(uri)
    }

    fun declineSolCard() {
        cardPhase = CardPhase.DECLINED
        phaseEvent("card", "declined")
    }

    // ============================================================ merchant / reader
    /** Enter reader mode and drive the exchange when a payer's phone is tapped (SolReceive mode). */
    fun startReader(activity: Activity, solreqUri: String) {
        val adapter = NfcAdapter.getDefaultAdapter(activity)
        when {
            adapter == null -> { android.util.Log.w("dpay", "sol startReader: no NFC adapter"); errorEvent("reader", "This phone has no NFC"); return }
            !adapter.isEnabled -> { android.util.Log.w("dpay", "sol startReader: NFC disabled"); errorEvent("reader", "NFC is off — turn it on in Settings"); return }
        }
        // Restart hygiene: tear down any stale session before re-enabling (see DpayNfc.startReader).
        stopReader(activity)
        readerActivity = activity
        receiptSignal = ArrayBlockingQueue(1)
        pendingReceipt = null
        // OEM/older builds can throw from enableReaderMode — classify + log (see DpayNfc.startReader).
        try {
            adapter!!.enableReaderMode(
                activity,
                { tag -> runReader(tag, solreqUri) },
                NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
                null,
            )
            phaseEvent("reader", "listening")
            android.util.Log.i("dpay", "sol startReader: reader mode enabled")
        } catch (e: Throwable) {
            android.util.Log.e("dpay", "sol enableReaderMode failed", e)
            errorEvent("reader", "Couldn't start NFC (${e.javaClass.simpleName}) — try again")
            stopReader(activity)
        }
    }

    /** JS calls this after broadcasting online: stamp the receipt + wake the reader thread to send it. */
    fun confirmSolReceipt(status: Int, rid: String, sig: String) {
        val o = JSONObject()
        o.put("status", status)
        o.put("rid", rid)
        o.put("sig", sig)
        val json = o.toString()
        pendingReceipt = json
        receiptSignal?.offer(json)
    }

    fun stopReader(activity: Activity?) {
        // Prefer the activity reader mode was enabled on (see DpayNfc.stopReader).
        val target = readerActivity ?: activity
        if (target == null) {
            android.util.Log.w("dpay", "sol stopReader: no activity reference — reader mode may stay on")
        } else {
            try {
                NfcAdapter.getDefaultAdapter(target)?.disableReaderMode(target)
            } catch (e: Throwable) {
                android.util.Log.w("dpay", "sol disableReaderMode failed", e)
            }
        }
        readerActivity = null
        readerIsoDep = null
        receiptSignal = null
        pendingReceipt = null
    }

    /**
     * Runs on a dedicated NFC binder thread (blocking `transceive` is fine here). Sends the chunked
     * solreq:, polls for the chunked solpay:, then waits for JS to broadcast + confirm, and sends the
     * receipt back. Mirrors DpayNfc.onTag's structure but over the pure-Kotlin PUT/GET protocol.
     *
     * Error policy mirrors the IC rail: a tag discovered during a sloppy approach often fails its
     * first exchange at the RF margin — expected physics, so it returns to `listening` (reader mode
     * stays enabled; the next coupling fires a fresh onTag) instead of killing the merchant session
     * with a terminal error. Only hopeless cases terminate: bring-up failure, a SELECT that never
     * succeeded while the field held, or an unexpected throw.
     */
    private fun runReader(tag: Tag, solreqUri: String) {
        val isoDep = IsoDep.get(tag)
        android.util.Log.i("dpay", "sol onTag: techs=${tag.techList.joinToString(",")}")
        if (isoDep == null) {
            // A non-IsoDep tag (bank card, headphones…) answered the poll — not a dpay phone, but
            // not a reason to kill the merchant session either: log it and keep scanning.
            android.util.Log.w("dpay", "sol onTag: no IsoDep tech on this tag — ignoring, still listening")
            return
        }
        readerIsoDep = isoDep
        var gotPayment = false
        try {
            isoDep.connect()
            isoDep.timeout = 5000
            phaseEvent("reader", "linking")
            // SELECT the SOL AID. Retry a bounded time on ANY non-OK answer — 6210 means a routed
            // but unarmed dpay card (payer not in Pay mode: "the payer isn't ready", NOT "not a
            // dpay phone"); other statuses mean an HCE service still cold-starting or a non-dpay
            // tag, which the window also tolerates before giving up.
            var recoveryStart = 0L
            var sawNotReady = false
            var selectResp = isoDep.transceive(byteArrayOf(*SELECT_HEADER, SOL_AID.size.toByte(), *SOL_AID))
            android.util.Log.i("dpay", "sol onTag select: resp=${hex(selectResp)}")
            while (!isOk(selectResp)) {
                val notReady = selectResp.size >= 2 &&
                    selectResp[selectResp.size - 2] == SW_NOT_READY[0] &&
                    selectResp[selectResp.size - 1] == SW_NOT_READY[1]
                if (notReady) sawNotReady = true
                val now = System.currentTimeMillis()
                if (recoveryStart == 0L) {
                    recoveryStart = now
                    android.util.Log.w(
                        "dpay",
                        "sol onTag: SELECT not OK yet (${hex(selectResp)})" +
                            (if (notReady) " — dpay card routed but payer session not armed" else "") +
                            " — recovering while the field holds"
                    )
                    phaseEvent("reader", "linking")
                } else if (now - recoveryStart > SOL_PAYER_ARM_WAIT_MS) {
                    android.util.Log.w("dpay", "sol onTag: SELECT never OK after ${SOL_PAYER_ARM_WAIT_MS}ms (last=${hex(selectResp)})")
                    errorEvent(
                        "reader",
                        if (sawNotReady) "The payer’s dpay app isn’t open — ask them to open Pay, then try again"
                        // 6A82-only is EITHER a genuine non-dpay card OR a dpay phone whose OS
                        // isn't routing (stale table after an update, payer app killed) — the copy
                        // stays honest + actionable for the routing case.
                        else "Couldn’t reach a dpay wallet — ask them to open dpay (or toggle NFC off and on), then try again"
                    )
                    return
                }
                Thread.sleep(SOL_PAYER_ARM_POLL_MS)
                selectResp = isoDep.transceive(byteArrayOf(*SELECT_HEADER, SOL_AID.size.toByte(), *SOL_AID))
            }
            // PUSH the solreq: in MAX_CHUNK frames.
            chunkPut(isoDep, TAG_REQUEST, solreqUri)
            phaseEvent("reader", "awaitingApproval")
            // POLL for the signed solpay: (the payer signs offline; retry while SW_WRONG_STATE).
            val solpay = chunkGet(isoDep, TAG_PAYMENT)
            if (solpay == null) {
                errorEvent("reader", "The payer declined the payment")
                return
            }
            gotPayment = true
            emitPayment(solpay)
            phaseEvent("reader", "settling")
            // JS broadcasts + confirms; hold the field a bounded time for the receipt.
            val receipt = pendingReceipt ?: receiptSignal?.poll(RECEIPT_CONFIRM_WAIT_SECS, TimeUnit.SECONDS)
            if (receipt == null) {
                // The merchant's JS already decided its own outcome; a timeout is NOT a merchant
                // failure — the payer independently falls back to "couldn't confirm". Stop quietly.
                return
            }
            chunkPut(isoDep, TAG_RECEIPT, receipt)
            emitConfirmed()
            phaseEvent("reader", "success")
        } catch (e: DeclinedByPayer) {
            // The payer pressed Decline on the review card — the terminal, fast decline (the card
            // answered 0x6985; no window burned).
            android.util.Log.i("dpay", "sol onTag: payer declined")
            phaseEvent("reader", "declined")
        } catch (e: TagLostException) {
            // The field broke — expected during a physical approach. Before the payment is in hand
            // this is pure physics: back to listening (reader mode stays enabled; the next coupling
            // fires a fresh onTag). After the payment JS already owns the outcome.
            if (gotPayment) {
                android.util.Log.w("dpay", "sol onTag: tag lost after payment received — receipt push abandoned")
            } else {
                android.util.Log.w("dpay", "sol onTag: tag lost mid-exchange — back to listening", e)
                phaseEvent("reader", "listening")
            }
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "sol onTag: unexpected failure (${e.javaClass.simpleName})", e)
            errorEvent("reader", "Tap failed — try again")
        } finally {
            try { isoDep.close() } catch (_: Throwable) {}
            readerIsoDep = null
        }
    }

    private fun isOk(resp: ByteArray): Boolean = resp.size >= 2 && resp[resp.size - 2] == 0x90.toByte() && resp[resp.size - 1] == 0x00.toByte()

    private val HEXCH = "0123456789abcdef".toCharArray()
    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) {
            val v = x.toInt() and 0xff
            sb.append(HEXCH[v ushr 4]).append(HEXCH[v and 0x0f])
        }
        return sb.toString()
    }

    /** Send `data` as a series of PUT APDUs (P1=tag, P2 bit0 = continuation). */
    private fun chunkPut(isoDep: IsoDep, tag: Byte, data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        var off = 0
        if (bytes.size == 0) {
            // An empty payload is a single zero-length frame (more=0).
            val resp = isoDep.transceive(byteArrayOf(0x00, INS_PUT, tag, 0x00))
            if (!isOk(resp)) throw TagLostException("put rejected")
            return
        }
        while (off < bytes.size) {
            val end = minOf(off + MAX_CHUNK, bytes.size)
            val chunk = bytes.copyOfRange(off, end)
            val more = if (end < bytes.size) 1 else 0
            val resp = isoDep.transceive(byteArrayOf(0x00, INS_PUT, tag, more.toByte(), *chunk))
            if (!isOk(resp)) throw TagLostException("put rejected")
            off = end
        }
    }

    /** Reassemble a chunked payload from GET APDUs (P1=tag). Returns null if the card returns an
     *  error (the payer declined / has nothing) — distinguishing decline from a transport retry.
     *  Retries on SW_WRONG_STATE for up to [PAYMENT_WAIT_SECS] (the payer signs offline). */
    private fun chunkGet(isoDep: IsoDep, tag: Byte): String? {
        val sb = StringBuilder()
        val maxAttempts = (PAYMENT_WAIT_SECS * 1000L / 120L).toInt()
        var attempts = 0
        while (true) {
            val resp = isoDep.transceive(byteArrayOf(0x00, INS_GET, tag, 0x00))
            if (resp.size < 1) throw TagLostException("empty get response")
            if (resp.size == 2) {
                // A bare status word — SW_WRONG_STATE = the payer is still reviewing/signing; retry.
                if (resp[0] == SW_WRONG_STATE[0] && resp[1] == SW_WRONG_STATE[1]) {
                    if (++attempts > maxAttempts) return null // the payer didn't sign in time
                    Thread.sleep(120)
                    continue
                }
                // SW_DECLINED = the payer pressed Decline on the review card — terminal. Surfaced
                // as an immediate reader decline (a phase, not a burned-window error) via the
                // sentinel below; IC-rail parity (ReaderStep.Declined on 0x6985).
                if (resp[0] == SW_DECLINED[0] && resp[1] == SW_DECLINED[1]) throw DeclinedByPayer()
                throw TagLostException("get failed")
            }
            val more = resp[0].toInt() and 0xff
            val chunk = resp.copyOfRange(1, resp.size - 2) // strip the leading more-flag + trailing SW
            sb.append(String(chunk, Charsets.UTF_8))
            if (more == 0) return sb.toString()
        }
    }

    /** Sentinel: the card answered SW_DECLINED (the payer pressed Decline). Not an error — the
     *  reader's terminal decline path. */
    private class DeclinedByPayer : Exception()
}
