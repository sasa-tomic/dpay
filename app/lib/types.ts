// NFC tap transport (see android/com/dpay/DpayNfc*). Pay mode = HCE card (payer is tapped);
// Receive mode = reader (merchant reads the tap). Lifecycle arrives as `DpayNfcEvent`s.
export type DpayNfcApi = {
  armCard(): Promise<void>;
  disarmCard(): Promise<void>;
  // The payer serves these two signed envelopes as one core-framed DPN2 bundle.
  approveCard(envelopeHex: string, readStateEnvelopeHex: string, nonceHex: string): Promise<void>;
  declineCard(nonceHex: string): Promise<void>;
  buildRequest(toHex: string, amount: string, nonceHex: string, expiry: number, currency: number, toName: string, memo: string): Promise<string>;
  startReader(requestHex: string): Promise<void>;
  stopReader(): Promise<void>;
  confirmResult(status: number, nonceHex: string, requestIdHex: string, merchantSecretHex: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type NfcEvent =
  | {type: 'phase'; role: 'card' | 'reader'; phase: NfcPhaseName}
  | {type: 'request'; role: 'card'; toHex: string; amount: string; nonceHex: string; expiry: number; currency: number; toName?: string; memo?: string}
  | {type: 'done'; role: 'reader'; envelopeHex: string; readStateEnvelopeHex: string; requestIdHex: string}
  | {type: 'done'; role: 'card'}
  | {type: 'result'; role: 'card'; status: number; nonceHex: string; requestIdHex: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

export type NfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

// SOL NFC tap transport (see android/com/dpay/DpaySolNfc*). A SECOND, fully-independent transport
// (pure Kotlin — no Rust core, no UniFFI) carrying opaque `solreq:`/`solpay:` URI strings + a JSON
// receipt for the SOL durable-nonce rail. The money logic (decode/sign/broadcast) stays in JS; the
// Kotlin layer is PURE TRANSPORT. SolPayMode = HCE card (payer is tapped); SolReceiveMode = reader.
export type DpaySolNfcApi = {
  armCard(): Promise<void>;
  disarmCard(): Promise<void>;
  approveSolCard(solpayUri: string): Promise<void>;
  declineSolCard(): Promise<void>;
  startSolReader(solreqUri: string): Promise<void>;
  stopSolReader(): Promise<void>;
  // Merchant: after broadcasting + confirming online, hand the outcome back to the offline payer.
  // `status` is the receipt code (0 settled, 1 rejected, 2 unreachable); `rid` binds the receipt to
  // the request id (a mismatch → the payer ignores it — defense against a cross-tap receipt); `sig`
  // is the on-chain tx signature (empty when not settled).
  confirmSolReceipt(status: number, rid: string, sig: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type SolNfcEvent =
  | {type: 'phase'; role: 'card' | 'reader'; phase: SolNfcPhaseName}
  | {type: 'request'; role: 'card'; solreqUri: string}
  | {type: 'payment'; role: 'reader'; solpayUri: string}
  | {type: 'receipt'; role: 'card'; status: number; rid: string; sig: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

export type SolNfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

// MC1 units 2-4: every protocol-u64 amount travels as a decimal-digit STRING (never `number`) so the
// full u64 range round-trips without precision loss above 2^53. `expiry`/`currency`/time fields stay
// `number` (they are small bounded values, not money).
export type Req = {toHex: string; amount: string; nonceHex: string; expiry: number; currency: number; toName: string; memo: string};
// A payment the payer is about to review — the ONE shape both entries produce, so there is a single
// review/sign path no matter how the payment arrived:
//   • 'wire' — a scanned/tapped 132-byte request. It addresses the payee by raw Ed25519 pubkey, so
//     `toPrincipal` is derived (self_authenticating(pubkey)) and `expiry` is the request's own.
//   • 'link' — a shared payment link. It addresses the payee by ICRC-1 principal directly (so it
//     can pay ANY IC account, not only a dpay user) and has NO request expiry: a link is durable,
//     and the signed envelope's IC ingress expiry is what bounds the signature.
//   • 'ocp' — an OpenCryptoPay merchant till. Also principal-addressed and also expiry-less HERE,
//     but its live quote has its own short deadline, held with the rest of the provider context
//     next to the intent (`components/PayMode.tsx`) because nothing else in the app has one. It
//     settles through the provider rather than an offline hand-off: the transfer is reported once,
//     after it confirms (`services/opencryptopay.ts`).
// The distinction drives exactly two things: whether the review auto-signs (the camera's "Pay Now"
// tap was already the deliberate press; a link and a till are both reviewed, never auto-signed —
// their amount and destination came from someone the wallet has no relationship with) and how the
// destination is rendered.
export type PayIntent = {
  toPrincipal: string;      // the ICRC-1 account owner the transfer targets
  toName: string;           // the payee's CLAIMED display name ('' when the payment names none)
  toAccountText: string;    // the destination as shown to the payer (short pubkey for wire, full principal for a link)
  amount: string;           // raw units (decimal-digit string)
  currency: number;
  nonceHex: string;         // the ICRC memo — the reconciliation key the payee watches for
  memo: string;             // display-only note (the on-chain memo is the nonce, never this)
  expiry: number | null;    // request expiry in seconds; null for a link and a till (none by design)
  source: 'wire' | 'link' | 'ocp';
};
export type Identity = {secretHex: string; publicHex: string; username: string};
// One row of the Transactions list, RAIL-AGNOSTIC. The list merges the IC rail
// (`hooks/useTransactionHistory.ts`) with the Solana device-key rail (`hooks/useSolanaHistory.ts`),
// and `AssetId` is the only asset domain that spans both — an IC currency u32 cannot name `SOL`.
//
// `ts` is the SORT key and is deliberately separate from `time`: `time` is already a formatted,
// locale-relative STRING ("Today, 1:19 PM"), which cannot be ordered, so merging two independently
// sorted lists needs the raw unix SECONDS that produced it. It is `NaN` when the source has no time
// (a Solana block whose `blockTime` the node does not have) — never `now`: `fmtTime` renders a
// non-finite `ts` as '—' and `lib/ledger.ts#mergeHistoryByTime` sorts those rows last.
export type Txn = {nonce: string; amount: string; who: string; memo: string; time: string; ts: number; dir: 'out' | 'in'; assetId: AssetId};
// One row of the relay's GET /api/v1/transactions/{hex} response (from/to are lowercase hex). The
// relay returns from_name/to_name/memo as JSON STRINGS (NUL-trimmed, lossy; may be ""). `amount` is
// a decimal-digit string (MC1 units 2-4: protocol u64 amounts cross the JSON boundary as strings).
export type TransactionsRow = {from: string; to: string; amount: string; nonce: string; currency: number; timestamp: number; from_name: string; to_name: string; memo: string};
export type DpayCoreApi = {
  generateKeypair(): Promise<{secretHex: string; publicHex: string}>;
  // Derive the Ed25519 keypair from a 32-byte recovery seed (64 hex chars — the value Backup
  // reveals). Restores BOTH rails (IC Ed25519 + Solana SLIP-10 derivation) from one seed.
  keypairFromSecret(secretHex: string): Promise<{secretHex: string; publicHex: string}>;
  encodeRequest(toHex: string, amount: string, nonceHex: string, expiry: number, currency: number, toName: string, memo: string): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  // Device NFC radio state for the status chip: 'ready' | 'off' | 'unsupported' | 'unknown'.
  // Optional so an app built before the native method exists degrades to 'unknown' (chip hidden).
  nfcStatus?(): Promise<string>;
  // --- IC user-principal rail (dpay-icp via UniFFI). Funds live at
  // Account{owner: self_authenticating(device pubkey)} on the external ICRC ledgers; the app
  // signs full /api/v2 envelopes locally and POSTs them (payer online) or hands them to the
  // merchant (offline NFC/QR). ns-timestamps + amounts cross as decimal STRINGS (exact); bytes
  // as lowercase hex; "" for an absent subaccount/memo. Retry = identical-byte resubmit ONLY.
  icpSelfPrincipal(secretHex: string): Promise<string>;
  icpPrincipalFromPubkey(pubkeyHex: string): Promise<string>;
  // Base32-CRC parse of an ICRC-1 owner principal TEXT → its canonical spelling. Rejects a
  // mistyped/truncated principal (the failure mode of a payment link forwarded through chat)
  // before the payer is shown a destination.
  icpValidatePrincipal(text: string): Promise<string>;
  // Send-to-address destination parsing. `icpValidateIcrcAccount` is the superset of
  // `icpValidatePrincipal`: it also accepts the ICRC-1 `principal-checksum.subaccount` textual
  // form (spec-canonical only), resolving `{owner, subaccountHex}` where subaccountHex is "" for
  // the default subaccount — so the common case feeds straight into icpTransferArg.
  icpValidateIcrcAccount(text: string): Promise<IcpAccountParts>;
  // The 64-hex ICP account-identifier namespace (what exchanges hand out). Disjoint from
  // principals — a one-way hash of the owner, so it is reachable ONLY via the ICP ledger's legacy
  // `transfer`, never via icrc1_transfer. CRC-checked; canonical lowercase out.
  icpValidateAccountId(text: string): Promise<string>;
  icpAccountIdFromPrincipal(ownerText: string, subaccountHex: string): Promise<string>;
  icpLegacyTransferArg(toAccountIdHex: string, fromSubaccountHex: string, amountE8s: string, feeE8s: string, memo: string): Promise<string>;
  icpDecodeLegacyTransferResult(argHex: string): Promise<IcpTransferOutcome>;
  icpIngressExpiry(nowNs: string, aheadS: number): Promise<string>;
  icpTransferArg(toOwnerText: string, toSubaccountHex: string, fromSubaccountHex: string, amount: string, fee: string, memoHex: string): Promise<string>;
  icpApproveArg(spenderOwnerText: string, spenderSubaccountHex: string, fromSubaccountHex: string, amount: string, expectedAllowance: string, expiresAtNs: string, memoHex: string, fee: string): Promise<string>;
  icpBalanceOfArg(ownerText: string, subaccountHex: string): Promise<string>;
  icpMinterAccountArg(ownerText: string, subaccountHex: string): Promise<string>;
  icpRetrieveBtcArg(address: string, amountSats: string, fromSubaccountHex: string): Promise<string>;
  icpWithdrawEthArg(recipient: string, amountWei: string, fromSubaccountHex: string): Promise<string>;
  icpWithdrawErc20Arg(amount: string, ckerc20LedgerText: string, recipient: string, fromCkethSubaccountHex: string, fromCkerc20SubaccountHex: string): Promise<string>;
  icpEip1559PriceArg(ckerc20LedgerText: string): Promise<string>;
  icpDecodeText(argHex: string): Promise<string>;
  icpDecodeEip1559Price(argHex: string): Promise<IcpEip1559PriceOut>;
  icpSignUpdate(secretHex: string, canisterText: string, methodName: string, argHex: string, ingressExpiryNs: string): Promise<IcpSignedUpdate>;
  icpSignQuery(secretHex: string, canisterText: string, methodName: string, argHex: string, ingressExpiryNs: string): Promise<string>;
  icpSignReadState(secretHex: string, requestIdsHex: string[], wantTime: boolean, ingressExpiryNs: string): Promise<string>;
  icpEnvelopeRequestId(envelopeHex: string): Promise<string>;
  icpDecodeQuery(bodyHex: string): Promise<IcpQueryReply>;
  icpDecodeReadState(bodyHex: string, requestIdsHex: string[]): Promise<IcpStateRead>;
  icpDecodeTransferResult(argHex: string): Promise<IcpTransferOutcome>;
  /** Minter retrieve/withdraw Ok({block_index}) reply — same shape as icpDecodeTransferResult. */
  icpDecodeMinterOk(argHex: string): Promise<IcpTransferOutcome>;
  icpDecodeInt(argHex: string): Promise<string>;
};

/** icpSignUpdate result: the POSTable /call envelope + its request_id (read_state poll key). */
export type IcpSignedUpdate = { envelopeHex: string; requestIdHex: string };

/** icpDecodeQuery result over a /query response body. */
export type IcpQueryReply = {
  replied: boolean;
  argHex?: string;
  rejectCode?: string;
  rejectMessage?: string;
  errorCode?: string;
};

/** One request_status entry in a decoded read_state certificate (state strings mirror the IC
 *  spec; 'unknown' = keep polling). Certificate is DECODED not BLS-verified (W6 follow-up). */
export type IcpRequestStatusOut = {
  requestIdHex: string;
  state: 'unknown' | 'received' | 'processing' | 'replied' | 'rejected' | 'done';
  replyArgHex?: string;
  rejectCode?: string;
  rejectMessage?: string;
  errorCode?: string;
};

/** icpDecodeReadState result: certified time (clock sync) + per-rid statuses. */
export type IcpStateRead = { timeNs?: string; statuses: IcpRequestStatusOut[] };

/** icpDecodeTransferResult outcome: ok carries the block index; err carries variant + detail. */
export type IcpTransferOutcome = { ok: boolean; blockIndex?: string; errVariant?: string; errDetail?: string };

/** A parsed ICRC-1 textual account. `subaccountHex` is "" for the default (all-zero) subaccount,
 *  so it passes straight into `icpTransferArg`'s `toSubaccountHex` with no branching. */
export type IcpAccountParts = { owner: string; subaccountHex: string };

export type IcpEip1559PriceOut = {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  maxTransactionFee: string;
  timestampNs?: string;
};


export type NfcStatus = 'ready' | 'off' | 'unsupported' | 'unknown';

// Phase 1 — the unified asset domain (2026-08-12 unified asset selection rewrite).
// Stable, human-readable asset identifiers that are independent of any catalog object reference.
// The wallet's idle selection state is ONE `AssetId` (Wallet-owned); it never stores a descriptor.
//
// `ic:${number}` carries the relay/canister currency u32 directly in the id — the SAME value the
// IC wire format, request QRs, NFC requests, and ledger use — so resolving from id → currency id
// is a pure parse, never a catalog lookup. Solana ids are the literal device-key-rail tokens; they
// NEVER enter the relay/canister catalog, the ICRC polling, or the IC wire currency-id space (SOL
// is a device-key rail, not an ICRC catalog asset — CLAUDE.md non-negotiable).
export type AssetId = `ic:${number}` | 'solana:SOL' | 'solana:USDC';

// A reference into the asset domain: either an IC currency u32 or a Solana token. This is the
// discriminated payload a `SelectableAsset` carries alongside its display fields, so a consumer
// narrowing on `protocol: 'ic'` recovers a typed `currency: number` and a consumer narrowing on
// `protocol: 'solana'` recovers a typed `token: 'SOL' | 'USDC'` — no `any`, no `!`, no cast.
export type AssetRef =
  | {id: `ic:${number}`; protocol: 'ic'; currency: number}
  | {id: 'solana:SOL' | 'solana:USDC'; protocol: 'solana'; token: 'SOL' | 'USDC'};
