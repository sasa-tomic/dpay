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
    // How long the reader holds the field waiting for JS to broadcast + confirm the payer's solpay.
    private const val PAYMENT_WAIT_SECS = 8L
    // How long the reader holds the field waiting for JS to stamp + offer the receipt back.
    private const val RECEIPT_CONFIRM_WAIT_SECS = 12L

    // APDU protocol constants. PUT/GET carry a tag in P1 (REQUEST/PAYMENT/RECEIPT); the continuation
    // bit in P2 (1 = more frames follow for this tag) lets a variable-length string stream across.
    private val SOL_AID = byteArrayOf(0xF0.toByte(), 0x64, 0x70, 0x61, 0x79, 0x02)
    private val INS_PUT: Byte = 0xD0.toByte()
    private val INS_GET: Byte = 0xD1.toByte()
    private val TAG_REQUEST: Byte = 0x01
    private val TAG_PAYMENT: Byte = 0x02
    private val TAG_RECEIPT: Byte = 0x03

    private val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    private val SW_NOT_READY = byteArrayOf(0x62, 0x10)
    private val SW_WRONG_STATE = byteArrayOf(0x69, 0x86.toByte())
    private val SW_WRONG_LENGTH = byteArrayOf(0x67, 0x00)
    private val SELECT_HEADER = byteArrayOf(0x00, 0xA4.toByte(), 0x04, 0x00)

    private enum class CardPhase { IDLE, LINKING, AWAITING_PAYMENT, EXCHANGING, SETTLING, SUCCESS, DECLINED, PENDING }

    private var ctx: ReactApplicationContext? = null

    // ---- card (payer) state ----
    @Volatile private var cardArmed = false
    @Volatile private var cardPhase = CardPhase.IDLE
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
        } catch (_: Throwable) {
            // JS bridge not ready (e.g. a background tap before the app is up) — never fatal.
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

    private fun emitReceipt(status: Int, npub: String, nextNonce: String, sig: String) {
        val m = Arguments.createMap()
        m.putString("type", "receipt")
        m.putString("role", "card")
        m.putInt("status", status)
        m.putString("npub", npub)
        m.putString("nextNonce", nextNonce)
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
    }

    /** Called by [DpaySolHostApduService] for every command APDU. Total function — never throws. */
    fun onCardApdu(command: ByteArray): ByteArray {
        if (command.size < 4) return SW_WRONG_LENGTH
        return try {
            val cla = command[0]; val ins = command[1]; val p1 = command[2]; val p2 = command[3]
            if (cla == 0x00.toByte() && ins == 0xA4.toByte()) return handleSelect(command)
            if (!cardArmed) return SW_NOT_READY
            when (ins) {
                INS_PUT -> handlePut(p1, (p2.toInt() and 1) != 0, command.copyOfRange(4, command.size))
                INS_GET -> handleGet(p1)
                else -> SW_WRONG_LENGTH
            }
        } catch (_: Throwable) {
            // Never let an exception escape into the NFC stack.
            SW_WRONG_LENGTH
        }
    }

    private fun handleSelect(command: ByteArray): ByteArray {
        if (!cardArmed) return SW_NOT_READY
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
                    phaseEvent("card", "exchanging")
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
                        val npub = o.optString("npub", "")
                        val nextNonce = o.optString("nextNonce", "")
                        val sig = o.optString("sig", "")
                        when (status) {
                            0 -> { cardPhase = CardPhase.SUCCESS; phaseEvent("card", "success") }
                            1 -> { cardPhase = CardPhase.DECLINED; phaseEvent("card", "declined") }
                            else -> { cardPhase = CardPhase.PENDING; phaseEvent("card", "pending") }
                        }
                        emitReceipt(status, npub, nextNonce, sig)
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
            adapter == null -> { errorEvent("reader", "This phone has no NFC"); return }
            !adapter.isEnabled -> { errorEvent("reader", "NFC is off — turn it on in Settings"); return }
        }
        receiptSignal = ArrayBlockingQueue(1)
        pendingReceipt = null
        phaseEvent("reader", "listening")
        adapter!!.enableReaderMode(
            activity,
            { tag -> runReader(tag, solreqUri) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK,
            null,
        )
    }

    /** JS calls this after broadcasting online: stamp the receipt + wake the reader thread to send it. */
    fun confirmSolReceipt(status: Int, nextNonce: String, sig: String, npub: String) {
        val o = JSONObject()
        o.put("status", status)
        o.put("npub", npub)
        o.put("nextNonce", nextNonce)
        o.put("sig", sig)
        val json = o.toString()
        pendingReceipt = json
        receiptSignal?.offer(json)
    }

    fun stopReader(activity: Activity) {
        try {
            NfcAdapter.getDefaultAdapter(activity)?.disableReaderMode(activity)
        } catch (_: Throwable) {
        }
        readerIsoDep = null
        receiptSignal = null
        pendingReceipt = null
    }

    /**
     * Runs on a dedicated NFC binder thread (blocking `transceive` is fine here). Sends the chunked
     * solreq:, polls for the chunked solpay:, then waits for JS to broadcast + confirm, and sends the
     * receipt back. Mirrors DpayNfc.onTag's structure but over the pure-Kotlin PUT/GET protocol.
     */
    private fun runReader(tag: Tag, solreqUri: String) {
        val isoDep = IsoDep.get(tag)
        if (isoDep == null) {
            errorEvent("reader", "Not a dpay phone")
            return
        }
        readerIsoDep = isoDep
        try {
            isoDep.connect()
            isoDep.timeout = 5000
            phaseEvent("reader", "linking")
            // SELECT the SOL AID.
            val selectResp = isoDep.transceive(byteArrayOf(*SELECT_HEADER, SOL_AID.size.toByte(), *SOL_AID))
            if (!isOk(selectResp)) {
                errorEvent("reader", "Not a dpay phone")
                return
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
        } catch (e: TagLostException) {
            errorEvent("reader", "Phones moved apart — try again")
        } catch (e: Throwable) {
            errorEvent("reader", "Tap failed — try again")
        } finally {
            try { isoDep.close() } catch (_: Throwable) {}
            readerIsoDep = null
        }
    }

    private fun isOk(resp: ByteArray): Boolean = resp.size >= 2 && resp[resp.size - 2] == 0x90.toByte() && resp[resp.size - 1] == 0x00.toByte()

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
                // A bare status word — SW_WRONG_STATE = the payer is still signing; retry.
                if (resp[0] == SW_WRONG_STATE[0] && resp[1] == SW_WRONG_STATE[1]) {
                    if (++attempts > maxAttempts) return null // the payer didn't sign in time
                    Thread.sleep(120)
                    continue
                }
                throw TagLostException("get failed")
            }
            val more = resp[0].toInt() and 0xff
            val chunk = resp.copyOfRange(1, resp.size - 2) // strip the leading more-flag + trailing SW
            sb.append(String(chunk, Charsets.UTF_8))
            if (more == 0) return sb.toString()
        }
    }
}
