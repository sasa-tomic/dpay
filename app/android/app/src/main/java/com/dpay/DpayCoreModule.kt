package com.dpay

import android.nfc.NfcAdapter
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.math.BigInteger

/**
 * React Native bridge to the shared money/protocol core.
 *
 * Every method here delegates to the UniFFI-generated Kotlin binding (`uniffi.dpay_ffi.*`), which
 * loads the NDK-built `libdpay_ffi.so` — i.e. the *exact* compiled `dpay-core` the canister, relay,
 * sim, and Claude's headless tests use. No money logic is reimplemented in Kotlin or JS; this class
 * only marshals hex strings across the bridge. Bytes are passed as lowercase hex (RN's bridge has no
 * byte-array type); **amounts are decimal-digit STRINGS** (MC1 units 2-4: raw u64 never travels as
 * `Double`, which is lossy above 2^53). Time/currency stay `Double` (small bounded values).
 */
class DpayCoreModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "DpayCore"

    private val HEX = "0123456789abcdef".toCharArray()

    /** Exclusive u64 upper bound (2^64) for [rawU64] range validation — shift form avoids a
     *  typo-prone decimal literal. */
    private val U64_LIMIT = BigInteger.valueOf(1).shiftLeft(64)

    /** The diagnostic log's filename and its per-generation size cap (see [appendLog]). */
    private val LOG_NAME = "dpay.log"
    private val LOG_MAX_BYTES = 2L * 1024 * 1024

    private fun hex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    private fun unhex(s: String): ByteArray =
        ByteArray(s.length / 2) {
            ((Character.digit(s[it * 2], 16) shl 4) + Character.digit(s[it * 2 + 1], 16)).toByte()
        }

    /** The ONE {ok, blockIndex?, errVariant?, errDetail?} marshal, shared by every reply decoder
     *  that resolves an IcpTransferOutcome (ICRC-1 transfer, minter Ok, legacy ICP transfer) — the
     *  JS side reads one shape, so it is built in one place. */
    private fun transferOutcomeMap(r: uniffi.dpay_ffi.IcpTransferOutcome) =
        Arguments.createMap().apply {
            putBoolean("ok", r.ok)
            if (r.blockIndex != null) putString("blockIndex", r.blockIndex)
            if (r.errVariant != null) putString("errVariant", r.errVariant)
            if (r.errDetail != null) putString("errDetail", r.errDetail)
        }

    /** The ICPSwap pool reply marshal — the SAME key names the wasm core's
     *  `w_icp_decode_swap_result` JSON uses, so the web shim and the phone hand the app one shape.
     *  Success carries `amountOutGross` only; a refusal carries the venue's own arm + words only. */
    private fun swapReplyMap(r: uniffi.dpay_ffi.IcpSwapReply) =
        Arguments.createMap().apply {
            putBoolean("ok", r.ok)
            r.amountOutGross?.let { putString("amountOutGross", it) }
            if (!r.ok) {
                putString("errVariant", r.errVariant)
                putString("errDetail", r.errDetail)
            }
        }

    /** ReadableArray.getString is @Nullable in Kotlin — the JS bridge always passes hex
     *  strings, but fail loud (not NPE) if a slot is ever missing. */
    private fun ridsFrom(arr: com.facebook.react.bridge.ReadableArray): List<ByteArray> =
        (0 until arr.size()).map { i ->
            unhex(arr.getString(i) ?: throw IllegalArgumentException("requestIdsHex[$i] must be a hex string"))
        }

    /**
     * Parse a raw-u64 decimal STRING (from the JS bridge) into a ULong for the UniFFI binding.
     * MC1 units 2-4: for any value in `[0, 2^64)`, `toLong().toULong()` reproduces the exact u64
     * bit-pattern — `toLong()` takes the low 64 bits (so values in `[2^63, 2^64)` wrap to a negative
     * long) and `.toULong()` reinterprets those same bits unsigned. A malformed amount rejects the
     * promise with a debuggable code+message (never silent).
     *
     * Defense-in-depth (PR2): a sign + range guard runs BEFORE the bit-truncating `toLong()`. A
     * negative string (`"-5"`) would otherwise reinterpret to a near-`u64::MAX` value, and an
     * overflow (`"18446744073709551616"` == 2^64) would silently truncate to `0`. Current callers
     * pre-parse, but a future caller threading an unvalidated string straight here must not silently
     * corrupt the amount.
     */
    private fun rawU64(amount: String, field: String, promise: Promise): ULong? {
        val bi = try {
            BigInteger(amount.trim())
        } catch (e: Throwable) {
            promise.reject("dpay_core", "invalid $field: ${e.message}", e)
            return null
        }
        if (bi.signum() < 0 || bi >= U64_LIMIT) {
            promise.reject("dpay_core", "out of u64 range for $field: $amount")
            return null
        }
        return bi.toLong().toULong()
    }

    /** Fresh on-device Ed25519 keypair (native CSPRNG, inside Rust). */
    @ReactMethod
    fun generateKeypair(promise: Promise) {
        try {
            val kp = uniffi.dpay_ffi.generateKeypair()
            val out = Arguments.createMap()
            out.putString("secretHex", hex(kp.secret))
            out.putString("publicHex", hex(kp.`public`)) // `public` is a Kotlin hard keyword
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Derive the Ed25519 keypair from a 32-byte recovery seed (hex in, keypair out). Restores a wallet
     *  from the Backup seed. Rejects a wrong-length seed via the UniFFI DpayError. */
    @ReactMethod
    fun keypairFromSecret(secretHex: String, promise: Promise) {
        try {
            val kp = uniffi.dpay_ffi.keypairFromSecret(unhex(secretHex))
            val out = Arguments.createMap()
            out.putString("secretHex", hex(kp.secret))
            out.putString("publicHex", hex(kp.`public`))
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    // (IC-rail cutover 2026-08-19: wireLen/signingLen/requestLen, signAuthorization, encodeQr,
    // verifyWire, validate, signWithdrawal, verifyReceiptSig RETIRED — the facade wire left the
    // value path; payments sign IC envelopes via the icp* methods above and outcomes ride read_state.)
    /**
     * Receiver side: encode a payment request {to, amount, nonce, expiry, currency, to_name, memo} to
     * a base64url string. `toName` is the merchant's own display name and `memo` an optional note;
     * both are copied verbatim by the payer into their signed authorization.
     */
    @ReactMethod
    fun encodeRequest(
        toHex: String,
        amount: String,
        nonceHex: String,
        expiry: Double,
        currency: Double,
        toName: String,
        memo: String,
        promise: Promise,
    ) {
        val amountU = rawU64(amount, "amount", promise) ?: return
        try {
            promise.resolve(
                uniffi.dpay_ffi.encodeRequest(
                    unhex(toHex),
                    amountU,
                    unhex(nonceHex),
                    expiry.toLong().toULong(),
                    currency.toInt().toUInt(),
                    toName,
                    memo,
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Payer side: decode a scanned merchant request QR into {toHex, amount, nonceHex, expiry,
     *  currency, toName, memo} — the map keys MUST match the TS `Req` type field-for-field (the
     *  bridge-parity guard asserts this; a dropped key surfaces as `undefined` in JS and, when
     *  re-passed to a non-null Kotlin param, the 2026-08-16 `signAuthorization toName` hard crash).
     *  MC1 units 2-4: `amount` is emitted as an UNSIGNED decimal STRING (the full u64 range, never a
     *  lossy Double). */
    @ReactMethod
    fun decodeRequest(qr: String, promise: Promise) {
        try {
            val r = uniffi.dpay_ffi.decodeRequest(qr)
            val out = Arguments.createMap()
            out.putString("toHex", hex(r.to))
            out.putString("amount", r.amount.toString())
            out.putString("nonceHex", hex(r.nonce))
            out.putDouble("expiry", r.expiry.toDouble())
            out.putInt("currency", r.currency.toInt())
            out.putString("toName", r.toName)
            out.putString("memo", r.memo)
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Merchant side: the detached signature proving this device holds the key its OpenCryptoPay
     *  till account is derived from, so the relay can refuse a ring-up for a key the caller does not
     *  own. The merchant pubkey is DERIVED from the seed inside Rust — never passed in, so there is
     *  no mismatch to get wrong. `cents` is a raw-u64 decimal STRING (MC1); `issuedAt` is unix
     *  seconds and must be inside the relay's skew window; `merchantName` is the CLAIMED display
     *  name and is bound by the signature; `note` is the one-line purpose the payer reads on
     *  review — an EMPTY string signs the note-less (v1) encoding, any non-empty note signs under
     *  `TILL_OPEN_DOMAIN_V2`. Resolves the 64-byte signature as hex. */
    @ReactMethod
    fun tillOpenSignature(
        secretHex: String,
        cents: String,
        nonceHex: String,
        issuedAt: Double,
        merchantName: String,
        note: String,
        promise: Promise,
    ) {
        val centsU = rawU64(cents, "cents", promise) ?: return
        try {
            promise.resolve(
                hex(
                    uniffi.dpay_ffi.tillOpenSignature(
                        unhex(secretHex),
                        centsU,
                        unhex(nonceHex),
                        issuedAt.toLong().toULong(),
                        merchantName,
                        note,
                    ),
                ),
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    // --- IC user-principal rail (dpay-icp via UniFFI) ------------------------------------------------
    //
    // The rail moves funds at Account{owner: self_authenticating(user Ed25519 pubkey)} directly on
    // the external ICRC ledgers: the app signs full IC update/query/read_state envelopes LOCALLY
    // (byte-identical to ic-agent) and the bytes are POSTed to /api/v2/canister/<id>/<kind>.
    // Bridge conventions: ns-timestamps and u128 amounts cross as decimal STRINGS (MC1-class
    // exactness); envelope/arg/reply bytes cross as lowercase hex; subaccounts/memos as hex with
    // "" == None. retry semantics: identical-byte resubmit ONLY (a re-sign = new request_id =
    // double-pay) — the JS layer owns the envelope bytes and MUST reuse them verbatim.

    /** The self-authenticating principal of the device key (SHA224(DER(pub)) | 0x02, base32-CRC
     *  text) — the account owner on every external ledger. */
    @ReactMethod
    fun icpSelfPrincipal(secretHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpSelfPrincipal(unhex(secretHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Payee principal text from the merchant's 32-byte Ed25519 public key (the payment-request
     *  `to` field) — SHA224(DER(pub)) | 0x02. Keeps the 132-byte request format frozen. */
    @ReactMethod
    fun icpPrincipalFromPubkey(pubkeyHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpPrincipalFromPubkey(unhex(pubkeyHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Validate an ICRC-1 owner principal in text form (base32-CRC) and return it canonicalised.
     *  The destination of a shared payment link goes through this before the payer sees it. */
    @ReactMethod
    fun icpValidatePrincipal(text: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpValidatePrincipal(text))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Parse a send-to-address destination as an ICRC-1 textual ACCOUNT — a bare principal (what
     *  every IC wallet's receive QR carries) or `principal-checksum.subaccount`. Resolves
     *  `{owner, subaccountHex}`; subaccountHex is "" for the default subaccount. */
    @ReactMethod
    fun icpValidateIcrcAccount(text: String, promise: Promise) {
        try {
            val parts = uniffi.dpay_ffi.icpValidateIcrcAccount(text)
            val map = Arguments.createMap()
            map.putString("owner", parts.owner)
            map.putString("subaccountHex", parts.subaccountHex)
            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Validate a 64-hex ICP account identifier (the form exchanges hand out), CRC-checked,
     *  returning canonical lowercase. A different address namespace from a principal. */
    @ReactMethod
    fun icpValidateAccountId(text: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpValidateAccountId(text))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Derive the account identifier for an owner+subaccount — the send screen's self-send
     *  guard (the hash cannot be inverted, so recognising our own address means deriving it). */
    @ReactMethod
    fun icpAccountIdFromPrincipal(ownerText: String, subaccountHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpAccountIdFromPrincipal(ownerText, subaccountHex))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** DIDL args for the ICP ledger's LEGACY `transfer` — the only method that reaches a 64-hex
     *  account identifier. Amounts/fee/memo cross as decimal strings. */
    @ReactMethod
    fun icpLegacyTransferArg(
        toAccountIdHex: String,
        fromSubaccountHex: String,
        amountE8s: String,
        feeE8s: String,
        memo: String,
        promise: Promise,
    ) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpLegacyTransferArg(toAccountIdHex, fromSubaccountHex, amountE8s, feeE8s, memo, null)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode the legacy `transfer` reply. Same outcome shape as icpDecodeTransferResult, carrying
     *  the LEGACY variant tags (TxDuplicate / TxTooOld / TxCreatedInFuture). */
    @ReactMethod
    fun icpDecodeLegacyTransferResult(argHex: String, promise: Promise) {
        try {
            val out = uniffi.dpay_ffi.icpDecodeLegacyTransferResult(unhex(argHex))
            promise.resolve(transferOutcomeMap(out))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** ingress expiry (ns) = now_ns + ahead_s * 1e9. The caller supplies `now_ns` from the
     *  certified IC clock (read_state `time` leaf) — REFUSE to sign on large skew. */
    @ReactMethod
    fun icpIngressExpiry(nowNs: String, aheadS: Double, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpIngressExpiry(nowNs, aheadS.toULong()))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** DIDL arg for icrc1_transfer. Amount/fee are raw-u128 decimal STRINGS. */
    @ReactMethod
    fun icpTransferArg(
        toOwnerText: String,
        toSubaccountHex: String,
        fromSubaccountHex: String,
        amount: String,
        fee: String,
        memoHex: String,
        promise: Promise,
    ) {
        try {
            val arg = uniffi.dpay_ffi.icpTransferArg(
                toOwnerText,
                toSubaccountHex,
                fromSubaccountHex,
                amount,
                fee,
                memoHex,
            )
            promise.resolve(hex(arg))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * DIDL arg for icrc2_transfer_from — the PULL: spend an allowance the payer granted this
     * wallet, moving THEIR money to `toOwnerText`. Amount/fee are raw-u128 decimal STRINGS.
     */
    @ReactMethod
    fun icpTransferFromArg(
        fromOwnerText: String,
        fromSubaccountHex: String,
        toOwnerText: String,
        toSubaccountHex: String,
        amount: String,
        memoHex: String,
        fee: String,
        promise: Promise,
    ) {
        try {
            val arg = uniffi.dpay_ffi.icpTransferFromArg(
                fromOwnerText,
                fromSubaccountHex,
                toOwnerText,
                toSubaccountHex,
                amount,
                memoHex,
                fee,
            )
            promise.resolve(hex(arg))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** DIDL arg for icrc2_approve (offramp leg 1). amount="" encodes revoke(0). */
    @ReactMethod
    fun icpApproveArg(
        spenderOwnerText: String,
        spenderSubaccountHex: String,
        fromSubaccountHex: String,
        amount: String,
        expectedAllowance: String,
        expiresAtNs: String,
        memoHex: String,
        fee: String,
        promise: Promise,
    ) {
        try {
            val arg = uniffi.dpay_ffi.icpApproveArg(
                spenderOwnerText,
                spenderSubaccountHex,
                fromSubaccountHex,
                amount,
                expectedAllowance,
                expiresAtNs,
                memoHex,
                fee,
            )
            promise.resolve(hex(arg))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** DIDL arg for the ICPSwap pool's depositFromAndSwap (delegated-conversion leg 2 — the user
     *  signs it AFTER icrc2_approve named this pool the spender). Amounts + both token fees are
     *  raw-u128 decimal STRINGS; zeroForOne is the pool's own token0→token1 direction, taken from
     *  the venue quote, never assumed from pair order. */
    @ReactMethod
    fun icpDepositAndSwapArg(
        amountIn: String,
        amountOutMinimum: String,
        tokenInFee: String,
        tokenOutFee: String,
        zeroForOne: Boolean,
        promise: Promise,
    ) {
        try {
            val arg = uniffi.dpay_ffi.icpDepositAndSwapArg(
                amountIn,
                amountOutMinimum,
                tokenInFee,
                tokenOutFee,
                zeroForOne,
            )
            promise.resolve(hex(arg))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Exact-floor minimum-out from a venue quote + slippage in basis points (saturates at 0 for
     *  bps >= 10000). The compiled core owns this arithmetic — the JS side never recomputes it.
     *
     *  A JS number arrives here as a Double. A fractional or out-of-u16 bps is REFUSED, never
     *  truncated: `0.5.toInt()` is 0, which would silently turn the user's slippage tolerance off
     *  and sign a min-out equal to the full quote. Fail loud, name the value. */
    @ReactMethod
    fun icpSwapMinOut(quotedOut: String, slippageBps: Double, promise: Promise) {
        try {
            if (!(slippageBps % 1.0 == 0.0 && slippageBps >= 0.0 && slippageBps <= 65535.0)) {
                throw IllegalArgumentException(
                    "slippageBps must be a whole number of basis points in 0..65535, got $slippageBps",
                )
            }
            promise.resolve(uniffi.dpay_ffi.icpSwapMinOut(quotedOut, slippageBps.toInt().toUShort()))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode the ICPSwap pool's own reply to depositFromAndSwap/quote/swap:
     *  {ok, amountOutGross?} or {ok:false, errVariant, errDetail} — the venue's Motoko
     *  `variant { ok : nat; err : Error }`. amountOutGross is the pool's GROSS figure; the wallet
     *  receives it minus the output ledger's fee, so it is never shown as the amount received. */
    @ReactMethod
    fun icpDecodeSwapResult(argHex: String, promise: Promise) {
        try {
            promise.resolve(swapReplyMap(uniffi.dpay_ffi.icpDecodeSwapResult(unhex(argHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode an icrc2_approve reply — the APPROVE's outcome in the shared IcpTransferOutcome
     *  shape. ApproveError carries variants the transfer decoder cannot read (AllowanceChanged,
     *  Expired); decoding an approve refusal transfer-shaped THREW on those labels and left a
     *  conversion spinning on Approving (the 2026-09-19 live defect). */
    @ReactMethod
    fun icpDecodeApproveResult(argHex: String, promise: Promise) {
        try {
            promise.resolve(transferOutcomeMap(uniffi.dpay_ffi.icpDecodeApproveResult(unhex(argHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** DIDL arg for icrc1_balance_of (signed-query balance rail). */
    @ReactMethod
    fun icpBalanceOfArg(ownerText: String, subaccountHex: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpBalanceOfArg(ownerText, subaccountHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    // --- minter calls (user-principal offramp + deposits) — golden-pinned arg builders ---

    /** ckBTC minter get_btc_address(MinterAccount) — ONE record arg (2-tuples trap IC0503). */
    @ReactMethod
    fun icpMinterAccountArg(ownerText: String, subaccountHex: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpMinterAccountArg(ownerText, subaccountHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** ckBTC minter retrieve_btc_with_approval arg (sats; after the user's icrc2_approve). */
    @ReactMethod
    fun icpRetrieveBtcArg(address: String, amountSats: String, fromSubaccountHex: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpRetrieveBtcArg(address, amountSats, fromSubaccountHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** ckETH minter withdraw_eth arg (Wei; after approve of amount + max_transaction_fee). */
    @ReactMethod
    fun icpWithdrawEthArg(recipient: String, amountWei: String, fromSubaccountHex: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpWithdrawEthArg(recipient, amountWei, fromSubaccountHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** ckETH minter withdraw_erc20 arg — dual-ledger path (gas approve on ckETH + amount approve
     *  on the ckERC20 ledger, both user-signed before this call). */
    @ReactMethod
    fun icpWithdrawErc20Arg(
        amount: String,
        ckerc20LedgerText: String,
        recipient: String,
        fromCkethSubaccountHex: String,
        fromCkerc20SubaccountHex: String,
        promise: Promise
    ) {
        try {
            promise.resolve(
                hex(
                    uniffi.dpay_ffi.icpWithdrawErc20Arg(
                        amount, ckerc20LedgerText, recipient, fromCkethSubaccountHex, fromCkerc20SubaccountHex
                    )
                )
            )
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** ckETH minter eip_1559_transaction_price QUERY arg — live gas estimate before approving. */
    @ReactMethod
    fun icpEip1559PriceArg(ckerc20LedgerText: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpEip1559PriceArg(ckerc20LedgerText)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode a bare text reply (get_btc_address / any single-text query). */
    @ReactMethod
    fun icpDecodeText(argHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpDecodeText(unhex(argHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode an eip_1559_transaction_price reply (ckETH minter gas estimate) — Wei strings. */
    @ReactMethod
    fun icpDecodeEip1559Price(argHex: String, promise: Promise) {
        try {
            val p = uniffi.dpay_ffi.icpDecodeEip1559Price(unhex(argHex))
            val map = Arguments.createMap()
            map.putString("gasLimit", p.gasLimit)
            map.putString("maxFeePerGas", p.maxFeePerGas)
            map.putString("maxPriorityFeePerGas", p.maxPriorityFeePerGas)
            map.putString("maxTransactionFee", p.maxTransactionFee)
            if (p.timestampNs != null) map.putString("timestampNs", p.timestampNs) else map.putNull("timestampNs")
            promise.resolve(map)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Sign a full /call envelope (POST /api/v2/canister/<canister>/call). Returns
     *  {envelopeHex, requestIdHex} — requestId is the read_state poll key; keep the envelope
     *  bytes verbatim for any retry. */
    @ReactMethod
    fun icpSignUpdate(
        secretHex: String,
        canisterText: String,
        methodName: String,
        argHex: String,
        ingressExpiryNs: String,
        promise: Promise,
    ) {
        try {
            val signed = uniffi.dpay_ffi.icpSignUpdate(
                unhex(secretHex),
                canisterText,
                methodName,
                unhex(argHex),
                ingressExpiryNs,
            )
            val out = Arguments.createMap()
            out.putString("envelopeHex", hex(signed.envelope))
            out.putString("requestIdHex", hex(signed.requestId))
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Sign a /query envelope (POST /api/v2/canister/<canister>/query). */
    @ReactMethod
    fun icpSignQuery(
        secretHex: String,
        canisterText: String,
        methodName: String,
        argHex: String,
        ingressExpiryNs: String,
        promise: Promise,
    ) {
        try {
            val env = uniffi.dpay_ffi.icpSignQuery(
                unhex(secretHex),
                canisterText,
                methodName,
                unhex(argHex),
                ingressExpiryNs,
            )
            promise.resolve(hex(env))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Sign a /read_state envelope (POST /api/v2/canister/<canister>/read_state) polling
     *  request_status of `requestIdsHex` (+ the certified `time` leaf for clock sync). */
    @ReactMethod
    fun icpSignReadState(
        secretHex: String,
        requestIdsHex: com.facebook.react.bridge.ReadableArray,
        wantTime: Boolean,
        ingressExpiryNs: String,
        promise: Promise,
    ) {
        try {
            val env = uniffi.dpay_ffi.icpSignReadState(unhex(secretHex), ridsFrom(requestIdsHex), wantTime, ingressExpiryNs)
            promise.resolve(hex(env))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** The request_id of an already-signed envelope (the merchant side: rid of a payer-carried
     *  envelope, for read_state polling after submission). */
    @ReactMethod
    fun icpEnvelopeRequestId(envelopeHex: String, promise: Promise) {
        try {
            promise.resolve(hex(uniffi.dpay_ffi.icpEnvelopeRequestId(unhex(envelopeHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode a /query response body: {replied, argHex?, rejectCode?, rejectMessage?, errorCode?}. */
    @ReactMethod
    fun icpDecodeQuery(bodyHex: String, promise: Promise) {
        try {
            val r = uniffi.dpay_ffi.icpDecodeQuery(unhex(bodyHex))
            val out = Arguments.createMap()
            out.putBoolean("replied", r.replied)
            r.arg?.let { out.putString("argHex", hex(it)) }
            // The Rust record keeps reject_code/reject_message non-optional (0/"" on replies);
            // marshal them only for actual rejections — byte-parity with the wasm bridge JSON.
            if (!r.replied) {
                out.putString("rejectCode", r.rejectCode.toString())
                out.putString("rejectMessage", r.rejectMessage)
            }
            r.errorCode?.let { out.putString("errorCode", it) }
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode a /read_state body for `requestIdsHex`: {timeNs?, statuses: [{requestIdHex, state,
     *  replyArgHex?, rejectCode?, rejectMessage?, errorCode?}]}. state ∈ unknown|received|
     *  processing|replied|rejected|done. Certificate is DECODED not BLS-verified (W6 follow-up). */
    @ReactMethod
    fun icpDecodeReadState(bodyHex: String, requestIdsHex: com.facebook.react.bridge.ReadableArray, promise: Promise) {
        try {
            val r = uniffi.dpay_ffi.icpDecodeReadState(unhex(bodyHex), ridsFrom(requestIdsHex))
            val out = Arguments.createMap()
            val t = r.timeNs
            if (t != null) out.putString("timeNs", t)
            val statuses = Arguments.createArray()
            for (s in r.statuses) {
                val m = Arguments.createMap()
                m.putString("requestIdHex", hex(s.requestId))
                m.putString("state", s.state)
                s.replyArg?.let { m.putString("replyArgHex", hex(it)) }
                s.rejectCode?.let { m.putString("rejectCode", it.toString()) }
                s.rejectMessage?.let { m.putString("rejectMessage", it) }
                s.errorCode?.let { m.putString("errorCode", it) }
                statuses.pushMap(m)
            }
            out.putArray("statuses", statuses)
            promise.resolve(out)
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode an icrc1_transfer reply: {ok, blockIndex?, errVariant?, errDetail?}. */
    @ReactMethod
    fun icpDecodeTransferResult(argHex: String, promise: Promise) {
        try {
            promise.resolve(transferOutcomeMap(uniffi.dpay_ffi.icpDecodeTransferResult(unhex(argHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode an icrc2_transfer_from reply. Same outcome shape, plus the one variant only a pull
     *  can have: `InsufficientAllowance`, whose detail is the allowance the ledger actually holds. */
    @ReactMethod
    fun icpDecodeTransferFromResult(argHex: String, promise: Promise) {
        try {
            promise.resolve(transferOutcomeMap(uniffi.dpay_ffi.icpDecodeTransferFromResult(unhex(argHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Decode a minter retrieve/withdraw Ok({block_index}) reply (same wire shape the e2e fake-IC
     * gateway emits): {ok, blockIndex?, errVariant?, errDetail?} — mirrors icpDecodeTransferResult;
     * the Err side reuses the transfer-error variant names.
     */
    @ReactMethod
    fun icpDecodeMinterOk(argHex: String, promise: Promise) {
        try {
            promise.resolve(transferOutcomeMap(uniffi.dpay_ffi.icpDecodeMinterOk(unhex(argHex))))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /** Decode a single-value integer reply (balance/fee/decimals class) to a decimal string. */
    @ReactMethod
    fun icpDecodeInt(argHex: String, promise: Promise) {
        try {
            promise.resolve(uniffi.dpay_ffi.icpDecodeInt(unhex(argHex)))
        } catch (e: Throwable) {
            promise.reject("dpay_core", e)
        }
    }

    /**
     * Report the device NFC radio state for the UI status chip: "ready" (adapter present + enabled),
     * "off" (present but disabled in system settings), or "unsupported" (no NFC hardware). This is
     * the *radio* status only — the tap-to-pay HCE transport (see `dpay_core::nfc`) is a separate,
     * physical-device-gated feature; QR always works regardless of this value. A probe failure
     * resolves "unknown" (the chip then hides) rather than rejecting.
     */
    /**
     * Append one already-formatted line to the app's on-device diagnostic log.
     *
     * WHY THIS EXISTS. Everything this app logs goes to `console.*` → logcat, which lives only in a
     * rolling in-memory buffer on the device and only while a cable is attached to read it. That is
     * fine at a desk and useless for the case it matters most: a real payment at a real till,
     * minutes or hours from any computer, where the ONE thing worth knowing is what the payment
     * provider actually answered after the money moved. A file survives the walk home.
     *
     * Written to the app's EXTERNAL files dir (`/sdcard/Android/data/<pkg>/files/dpay.log`) rather
     * than internal storage on purpose: a release build is not debuggable, so `adb shell run-as`
     * cannot reach internal storage, and the log would be unreadable exactly on the builds that go
     * out. This path is readable over `adb` without root and needs no runtime permission.
     *
     * Failures are SWALLOWED, and that is the one place in this codebase where that is correct: a
     * logger that can throw turns a diagnostic aid into a new crash on the money path. The log is
     * best-effort by construction, which is why nothing may ever depend on it having been written.
     */
    @ReactMethod
    fun appendLog(line: String, promise: Promise) {
        try {
            val dir = reactApplicationContext.getExternalFilesDir(null)
            if (dir == null) { promise.resolve(false); return }
            val f = File(dir, LOG_NAME)
            // Rotate rather than grow without bound: one previous generation is kept, so a session
            // that fills the cap cannot erase the session before it. Two files, hard ceiling 2×CAP.
            if (f.length() > LOG_MAX_BYTES) {
                val prev = File(dir, "$LOG_NAME.1")
                if (prev.exists()) prev.delete()
                f.renameTo(prev)
            }
            f.appendText(line + "\n")
            promise.resolve(true)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun nfcStatus(promise: Promise) {
        try {
            val adapter = NfcAdapter.getDefaultAdapter(reactApplicationContext)
            val status = when {
                adapter == null -> "unsupported"
                adapter.isEnabled -> "ready"
                else -> "off"
            }
            promise.resolve(status)
        } catch (e: Throwable) {
            promise.resolve("unknown")
        }
    }
}
