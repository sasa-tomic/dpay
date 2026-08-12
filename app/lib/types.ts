// NFC tap transport (see android/com/dpay/DpayNfc*). Pay mode = HCE card (payer is tapped);
// Receive mode = reader (merchant reads the tap). Lifecycle arrives as `DpayNfcEvent`s.
export type DpayNfcApi = {
  armCard(): Promise<void>;
  disarmCard(): Promise<void>;
  approveCard(wireHex: string): Promise<void>;
  declineCard(): Promise<void>;
  buildRequest(toHex: string, amount: string, nonceHex: string, expiry: number, currency: number, toName: string, memo: string): Promise<string>;
  startReader(requestHex: string): Promise<void>;
  stopReader(): Promise<void>;
  // Merchant: after settling online, hand the outcome back to the payer. `status` is the receipt
  // code (0 settled, 1 rejected, 2 unreachable); `nonceHex` is the authoritative payment nonce so
  // the payer can confirm the receipt answers the exact payment it signed.
  confirmReceipt(status: number, nonceHex: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type NfcEvent =
  | {type: 'phase'; role: 'card' | 'reader'; phase: NfcPhaseName}
  | {type: 'request'; role: 'card'; toHex: string; amount: string; nonceHex: string; expiry: number; currency: number}
  | {type: 'done'; role: 'reader'; wireHex: string}
  | {type: 'receipt'; role: 'card'; settled: boolean; status: number; nonceHex: string}
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
  // `status` is the receipt code (0 settled, 1 rejected, 2 unreachable); `nextNonce` is the advanced
  // durable nonce value (the receipt-nonce-relay the payer adopts — empty when unreachable); `sig`
  // is the on-chain tx signature (empty when not settled); `npub` binds the receipt to the payer's
  // nonce account (a mismatch → the payer ignores it — defense against a cross-tap receipt).
  confirmSolReceipt(status: number, nextNonce: string, sig: string, npub: string): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type SolNfcEvent =
  | {type: 'phase'; role: 'card' | 'reader'; phase: SolNfcPhaseName}
  | {type: 'request'; role: 'card'; solreqUri: string}
  | {type: 'payment'; role: 'reader'; solpayUri: string}
  | {type: 'receipt'; role: 'card'; status: number; npub: string; nextNonce: string; sig: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

export type SolNfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

// MC1 units 2-4: every protocol-u64 amount travels as a decimal-digit STRING (never `number`) so the
// full u64 range round-trips without precision loss above 2^53. `expiry`/`currency`/time fields stay
// `number` (they are small bounded values, not money).
export type Req = {toHex: string; amount: string; nonceHex: string; expiry: number; currency: number; toName: string; memo: string};
export type Identity = {secretHex: string; publicHex: string; username: string};
export type Txn = {nonce: string; amount: string; who: string; memo: string; time: string; dir: 'out' | 'in'; currency: number};
// One row of the relay's GET /api/v1/transactions/{hex} response (from/to are lowercase hex). The
// relay returns from_name/to_name/memo as JSON STRINGS (NUL-trimmed, lossy; may be ""). `amount` is
// a decimal-digit string (MC1 units 2-4: protocol u64 amounts cross the JSON boundary as strings).
export type TransactionsRow = {from: string; to: string; amount: string; nonce: string; currency: number; timestamp: number; from_name: string; to_name: string; memo: string};
export type DpayCoreApi = {
  generateKeypair(): Promise<{secretHex: string; publicHex: string}>;
  // Derive the Ed25519 keypair from a 32-byte recovery seed (64 hex chars — the value Backup
  // reveals). Restores BOTH rails (IC Ed25519 + Solana SLIP-10 derivation) from one seed.
  keypairFromSecret(secretHex: string): Promise<{secretHex: string; publicHex: string}>;
  // Wire-format byte lengths, single-sourced from the FFI (dpay_core consts). The App.tsx self-check
  // derives the expected hex length from `wireLen()` so no magic literal can rot on a wire resize.
  wireLen(): Promise<number>;
  signingLen(): Promise<number>;
  requestLen(): Promise<number>;
  // `fromName` is the payer's own display name; `toName`/`memo` are copied from the scanned request
  // (merchant-defined). All three are REQUIRED (empty = all-zero name bytes on the wire) so a call
  // site that drops one is a compile error, not a silent native arity crash (device-bridge plan L1).
  // `amount` is a decimal-digit STRING (raw u64 units) — MC1 units 2-4: protocol u64 amounts never
  // travel as `number` (lossy above 2^53). `expiry`/`currency` stay `number` (small bounded values).
  signAuthorization(secretHex: string, toHex: string, amount: string, nonceHex: string, expiry: number, currency: number, fromName: string, toName: string, memo: string): Promise<string>;
  encodeRequest(toHex: string, amount: string, nonceHex: string, expiry: number, currency: number, toName: string, memo: string): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  // Policy gate mirroring the canister: resolves null when the payment is acceptable, else the reason
  // string ('expired', 'over_cap', 'insufficient_funds', 'nonce_reused', 'bad_signature', 'zero_amount').
  // amount/cap/balance are decimal-digit STRINGS (raw u64); now/expiry stay `number` (time).
  validate(amount: string, now: number, expiry: number, cap: string, balance: string, nonceSeen: boolean, sigOk: boolean): Promise<string | null>;
  // Sign a withdrawal authorization (ckBTC → native BTC out). Returns the 64-byte Ed25519 sig as hex
  // over the canonical WithdrawAuth signing bytes. The facade verifies this under from_pubkey (== the
  // debit subaccount) before moving funds — the non-custodial withdrawal gate. `amount` is a raw-u64
  // decimal string (MC1 units 2-4); `expiry`/`currency` stay `number`.
  signWithdrawal(secretHex: string, btcAddress: string, amount: string, nonceHex: string, expiry: number, currency: number): Promise<string>;
  // Verify a canister/ledger-signed receipt signature (R2). Returns true iff `receiptSig` (hex) is a
  // valid Ed25519 signature over the canonical ReceiptClaim built from the claim fields, under
  // `pubkey` (hex). The app gates "Paid ✓" on this so the outcome is canister/ledger-authenticated.
  // amount/blockIndex/settleTs are raw-u64 decimal strings (the claim carries them as u64 LE; exact
  // transport closes the >2^53 loss surface). currency stays `number` (a small u32).
  verifyReceiptSig(
    nonceHex: string, fromHex: string, toHex: string, amount: string, currency: number,
    blockIndex: string, settleTs: string, receiptSigHex: string, pubkeyHex: string,
  ): Promise<boolean>;
  // Device NFC radio state for the status chip: 'ready' | 'off' | 'unsupported' | 'unknown'.
  // Optional so an app built before the native method exists degrades to 'unknown' (chip hidden).
  nfcStatus?(): Promise<string>;
};

// MC4 U5: the signed authorization the payer holds, used to bind a relay-returned receipt to the
// EXACT payment (defense-in-depth against a stale/malicious relay returning a different settled
// payment's receipt). Every field is the canonical signed value: `from`/`to` are pubkey hex strings;
// `amount` is a raw-u64 decimal STRING (MC1 units 2-4 — never `number`, lossy above 2^53); `currency`
// is the small u32; `nonce` is hex. `verifyOutcomeReceipt` compares each receipt field against these.
export type ReceiptAuth = {
  from: string;
  to: string;
  amount: string;
  currency: number;
  nonce: string;
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
