// NFC tap transport (see android/com/dpay/DpayNfc*). Pay mode = HCE card (payer is tapped);
// Receive mode = reader (merchant reads the tap). Lifecycle arrives as `DpayNfcEvent`s.
export type DpayNfcApi = {
  armCard(): Promise<void>;
  disarmCard(): Promise<void>;
  approveCard(wireHex: string): Promise<void>;
  declineCard(): Promise<void>;
  buildRequest(toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
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
  | {type: 'request'; role: 'card'; toHex: string; amount: number; nonceHex: string; expiry: number; currency: number}
  | {type: 'done'; role: 'reader'; wireHex: string}
  | {type: 'receipt'; role: 'card'; settled: boolean; status: number; nonceHex: string}
  | {type: 'confirmed'; role: 'reader'}
  | {type: 'error'; role: 'card' | 'reader'; reason: string};

export type NfcPhaseName = 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling' | 'success' | 'declined' | 'pending';

export type Req = {toHex: string; amount: number; nonceHex: string; expiry: number; currency: number};
export type Identity = {secretHex: string; publicHex: string; username: string};
export type Txn = {nonce: string; amount: number; who: string; time: string; dir: 'out' | 'in'};
// One row of the relay's GET /api/v1/transactions/{hex} response (from/to are lowercase hex).
export type TransactionsRow = {from: string; to: string; amount: number; nonce: string; currency: number; timestamp: number};
export type DpayCoreApi = {
  generateKeypair(): Promise<{secretHex: string; publicHex: string}>;
  signAuthorization(secretHex: string, toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
  encodeRequest(toHex: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
  decodeRequest(qr: string): Promise<Req>;
  encodeQr(wireHex: string): Promise<string>;
  verifyWire(wireHex: string): Promise<boolean>;
  // Sign a withdrawal authorization (ckBTC → native BTC out). Returns the 64-byte Ed25519 sig as hex
  // over the canonical WithdrawAuth signing bytes. The facade verifies this under from_pubkey (== the
  // debit subaccount) before moving funds — the non-custodial withdrawal gate.
  signWithdrawal(secretHex: string, btcAddress: string, amount: number, nonceHex: string, expiry: number, currency: number): Promise<string>;
  // Verify a canister/ledger-signed receipt signature (R2). Returns true iff `receiptSig` (hex) is a
  // valid Ed25519 signature over the canonical ReceiptClaim built from the claim fields, under
  // `pubkey` (hex). The app gates "Paid ✓" on this so the outcome is canister/ledger-authenticated.
  verifyReceiptSig(
    nonceHex: string, fromHex: string, toHex: string, amount: number, currency: number,
    blockIndex: number, settleTs: number, receiptSigHex: string, pubkeyHex: string,
  ): Promise<boolean>;
  // Device NFC radio state for the status chip: 'ready' | 'off' | 'unsupported' | 'unknown'.
  // Optional so an app built before the native method exists degrades to 'unknown' (chip hidden).
  nfcStatus?(): Promise<string>;
};

export type NfcStatus = 'ready' | 'off' | 'unsupported' | 'unknown';
