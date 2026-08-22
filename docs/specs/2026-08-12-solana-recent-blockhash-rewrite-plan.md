# 2026-08-12 - Solana Recent-Blockhash Offline Payment Rewrite

> **Status: PLANNED.** This plan fully replaces the shipped durable-nonce payment protocol with
> merchant-supplied recent blockhashes. The normal Pay/Receive path will have no setup transaction,
> nonce account, nonce persistence, resync, or nonce receipt. The only retained legacy capability is
> an isolated, online account-reclaim tool for users who already funded the deterministic nonce
> account. No IC facade, relay, canister, Rust core, or IC wire change is in scope.

## Executive decision

The online merchant fetches a fresh Solana blockhash immediately before showing a payment request.
The request carries that blockhash and its last-valid block height. The offline payer scans or taps,
reviews the exact asset and amount, signs an ordinary SOL or SPL transaction locally, and hands the
signed transaction back. The merchant strictly verifies it against the open request before
broadcasting and confirming it.

The resulting payment window is intentionally short, commonly about 60-90 seconds but never
guaranteed by elapsed time. The UI caps wall-clock validity at 90 seconds, while the blockhash's
on-chain validity is authoritative and may end sooner. When a request expires authoritatively, the
merchant creates a new request with a new request ID and blockhash.

This is a replacement, not a second mode:

- Encoders emit only `solreq:v2` and `solpay:v2`.
- Decoders reject v1 and every unknown version explicitly.
- No v1 payment is ever signed or broadcast by the new app.
- The Solana Pay tab has no setup, stale, or resync phase.
- Durable-nonce code is removed from the payment engine, UI, NFC receipt, tests, and current docs.
- Legacy nonce derivation and account handling survive only inside the reclaim boundary.

The payer remains the transaction fee payer. Eliminating that per-transaction SOL fee would require
a separate merchant co-signing and fee-sponsorship protocol and is not part of this rewrite.

## Why replace the current design

The durable-nonce design makes delayed handoff possible, but it imposes costs the product does not
need:

- First use creates and funds an 80-byte account with about 1,447,680 lamports of rent reserve.
- The payer must persist a rotating nonce value and distinguish ready from stale state.
- Settlement receipts carry the advanced nonce back to prepare the next payment.
- Rejection and unknown outcomes require resync logic and user-facing recovery states.
- QR and NFC payment code are coupled to nonce-account identity rather than the payment itself.

A short, recent-blockhash-bounded handoff is acceptable. Solana's normal transaction model therefore
provides the simpler product: no setup reserve and no long-lived payment state on the payer.

## Hard invariants

1. The merchant is online when creating a request and when accepting a payment handoff. The payer may
   remain fully offline from request decode through transaction signing.
2. Normal payment code never derives, creates, reads, advances, persists, resyncs, or closes a durable
   nonce account.
3. The payer signs only after reviewing a valid v2 request. The request's asset, recipient, amount,
   network, blockhash, and request ID are immutable through signing and settlement.
4. The merchant broadcasts only a single-signer legacy transaction whose full signed message is
   byte-equal to the canonical message rebuilt from the open request and payer public key.
5. Signature or transaction parsing failure is blocking. The current warning-and-broadcast behavior
   is deleted.
6. The transaction contains exactly the expected transfer. No extra instruction, signer, recipient,
   transfer, compute-budget instruction, nonce instruction, arbitrary mint, or unknown program is
   accepted.
7. Solana USDC means the configured network/mint pair. Source and destination token accounts are the
   canonical ATAs for the payer and merchant, and token decimals are exactly the configured value.
8. Amounts remain decimal-digit strings at protocol and RPC boundaries and become `bigint` only for
   byte-exact transaction construction.
   Known balances must cover amount plus the frozen 5,000-lamport one-signature fee for SOL, or token
   amount plus 5,000 lamports for USDC. Known insufficiency blocks approval. A stale or unavailable
   balance warns explicitly but may proceed with user consent so signing remains network-free; merchant
   preflight reports insufficient-funds rejection honestly.
9. Request IDs are random 128-bit values and are compared exactly. Base58 values are case-sensitive.
10. The same signed bytes can be scanned or broadcast repeatedly without creating a new payment; the
    resulting transaction signature is stable and rebroadcast is idempotent.
11. One displayed request accepts at most one transaction signature. Once a merchant reserves the
    first valid signature for a request ID, a different signature for that request is rejected.
12. A timeout is honest-unknown. The app reconciles the original signature before offering a fresh
    request, including after an app restart; it never labels a timeout as declined or silently creates
    a second payment opportunity.
13. A payer receipt is believed only when both request ID and expected transaction signature match.
14. NFC remains opaque string transport under the existing SOL AID `F06470617902`; protocol and money
    decisions remain in TypeScript.
15. Reclaim is not a payment fallback. It is online, isolated in Settings, derives the shipped legacy
    account from the recovery seed, verifies it fail-closed, and removes the account permanently.
16. The Solana rail remains app-only. No Solana type or payload enters the relay, IC catalog, facade,
    canister, Rust core, or frozen IC wire.

## Protocol v2

The exact abbreviated JSON keys should be frozen by golden tests before implementation. The target
semantic model is:

```ts
type SolReqV2 = {
  v: 2;
  rid: string;       // 32 lowercase hex chars from 16 random bytes
  net: 'mainnet-beta'; // frozen configured cluster, not merchant-controlled routing
  bh: string;        // base58 recent blockhash
  lvh: number;       // lastValidBlockHeight from the same RPC response
  slot: number;      // context slot from the same RPC response
  iat: number;       // unix seconds
  exp: number;       // unix seconds; iat < exp <= iat + 90
  to: string;        // merchant wallet address
  amt: string;       // smallest-unit decimal string
  cur: 'SOL' | 'USDC';
  mint: string | null;
  toAta: string | null;
  name: string;
  memo: string;
};

type SolPayV2 = {
  v: 2;
  rid: string;
  tx: Uint8Array;
};

type SolReceiptV2 = {
  status: 0 | 1 | 2; // settled, rejected/expired, unknown
  rid: string;
  sig: string;
};
```

`solpay:v2` deliberately does not echo `to`, `amt`, `cur`, mint, or ATA. Those fields would be
untrusted claims. The merchant retains the decoded `SolReqV2` snapshot and validates the transaction
against it.

The request is bound into the transaction with the Memo Program at
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`, with no instruction accounts. Its exact UTF-8 data is
`dpay-solreq-v2:` followed by lowercase hex SHA-256 of the canonical `solreq:v2` URI bytes. JSON key
order is the `SolReqV2` order above; encoding uses compact JSON and canonical unpadded base64url.
Decoding does not trim or normalize, and accepts only payloads for which
`encodeSolReq(decodeSolReq(raw)) === raw`. Signing and verification receive the immutable canonical URI,
not a reconstructed object. The canonical instruction order is:

- SOL: Memo, then one System Program transfer.
- USDC: Memo, then one Token Program `TransferChecked`.

`TransferChecked` is required for v2 so the signed instruction also commits to the configured mint
and decimals. The payer is the only signer and transaction fee payer. The request ID plus memo digest
binds consent to one request; the transaction's first signature supplies the stable payment identity
used for reconciliation and receipts.

## Freshness and outcome rules

- `getLatestBlockhash` returns `{contextSlot,blockhash,lastValidBlockHeight}`. The context slot is
  carried as `slot`. Freeze `SOL_PAYMENT_COMMITMENT = 'confirmed'` for `getLatestBlockhash`,
  `isBlockhashValid`, `getBlockHeight`, `getFeeForMessage`, and preflight; pass `minContextSlot` only
  where that RPC method supports it.
- `getGenesisHash` must equal mainnet-beta
  `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` before request creation or reclaim inspection. Cache
  success only for the immutable RPC URL during the app session; mismatch or inability to establish
  cluster identity fails closed.
- The merchant sets `iat` when the RPC result arrives and `exp` to no more than 90 seconds later.
- The payer rejects an expired wall-clock request and rejects requests whose lifetime exceeds the
  protocol maximum. This is an advisory local check because an offline device clock can be wrong.
- Before broadcast, the merchant checks `isBlockhashValid` and `getBlockHeight` with the request's
  `slot` as `minContextSlot`, requires the blockhash valid and current height at most `lvh`, and passes
  the same `minContextSlot` plus preflight commitment to `sendTransaction`. The production RPC must
  support these calls; failure to establish freshness fails closed before first broadcast.
- `confirmTransaction` becomes block-height- and history-aware. It uses
  `getSignatureStatuses(...,{searchTransactionHistory:true})`, and may use `getTransaction` as a
  second source. A non-null status with `err` is rejected; confirmed/finalized without error is
  success. Absence is authoritatively expired only when committed height exceeds `lvh`, the blockhash
  is invalid at a context no older than `slot`, and history-aware signature lookup remains absent.
  Inconsistent or unavailable evidence remains unknown.
- Record the context slot returned by the authoritative `isBlockhashValid = false` observation. A null
  history-aware status proves absence only when `getSignatureStatuses` returns
  `context.slot >= invalidityContextSlot`. A null `getTransaction` does not strengthen absence because
  it has no comparable response context; a non-null result may prove an outcome.
- The signature returned by `sendTransaction` must exactly equal the locally extracted first
  signature.
- After an unknown outcome, keep the request and signature reserved. Query that signature before
  rebroadcasting or allowing a replacement request. Never infer failure solely from elapsed time.
- In QR handoff, the merchant screen shows settlement only after confirmation. The payer remains
  Pending because QR has no reverse receipt channel; adding one is outside this rewrite.
- NFC does not hold phones together for the full validity window. The merchant broadcasts, waits at
  most 8 seconds within the native 12-second receipt deadline, and returns settled/rejected if
  known or `{status: unknown,rid,sig}` otherwise. Merchant reconciliation continues after disconnect;
  no later payer receipt is possible without another tap/channel. Unknown, missing receipt, and tag
  loss are Pending, never Paid.

## Merchant request state

Merchant state is persisted so a process kill cannot erase an in-flight or unknown transaction and
permit an accidental second request. The state shape is explicit and pure-testable:

```ts
type SolMerchantRequestState = {
  req: SolReqV2;
  uri: string;
  acceptedSignature: string | null;
  acceptedTx: Uint8Array | null;
  outcome: 'open' | 'broadcasting' | 'settled' | 'rejected' | 'unknown';
};
```

Validate a payment completely, then atomically reserve its signature and raw transaction before the
first network send. QR and NFC callbacks share a reducer/ref or mutex so they cannot race acceptance.
Persist before send and restore/reconcile on app launch. The same bytes may retry/reconcile; a
different signature for the same `rid` is rejected. Clear only after settlement, authoritative
rejection/expiry, or explicit risk-acknowledged abandonment.

Persistence is a schema-versioned, merchant-identity-scoped AsyncStorage record. `acceptedTx` is
canonical unpadded base64url. Persist and await the open request before exposing its QR/NFC URI;
failure blocks display. Persist and await the accepted transaction reservation before broadcast;
failure blocks send. Restore decodes and revalidates URI, transaction, request ID, and signature
before reconciliation. Corruption fails closed and requires explicit risk-acknowledged abandonment
rather than silent clear.

## Implementation order

Each phase starts with focused failing tests and lands without deprecated adapters or dual protocol
paths. Do not add v2 beside active v1 code and defer deletion; the phase that replaces a surface also
deletes the old surface.

### Phase 1 - Freeze the v2 codec and freshness model

**Primary files**

- `app/solana/qr.ts`
- `app/solana/payments.ts`
- `app/lib/format.ts` or the existing random-byte helper boundary
- `app/__tests__/solana-qr.test.ts`
- `app/__tests__/solana-payments.test.ts`

**RED tests first**

- v2 SOL and USDC golden strings round-trip byte-exactly.
- v1 and unknown request/payment versions are explicitly rejected.
- Request ID is exactly 16 bytes of lowercase hex; malformed IDs fail closed.
- Blockhash and addresses decode to 32 bytes; amount is canonical, greater than zero, and at most
  `2^64-1`; block heights, context slot, and times are safe bounded integers.
- `iat < exp <= iat + 90`; expired requests are rejected at the documented second boundary.
- Network is exactly `mainnet-beta`; USDC mint must equal the local mainnet mint. Production config
  validates the RPC cluster against the expected mainnet genesis hash rather than URL substrings.
- SOL requires null mint/ATA; USDC requires the configured mint and canonical merchant ATA.
- Payment contains only `rid` and non-empty signed transaction bytes.
- Name, memo, URI, and transaction sizes have explicit caps; transaction bytes do not exceed Solana's
  packet limit.
- Non-canonical JSON key order, whitespace, padded base64url, trailing bytes, or URI trimming fail.
- Receipt outcome matching requires exact request ID and expected transaction signature.

**Implementation**

- Replace `SOL_QR_VERSION = 1` and the v1 types with v2-only types and prefixes.
- Generate `rid` through the existing RN-proven secure random source; never `Math.random`.
- Add one pure request-lifetime decision helper and replace nonce-specific payer outcome logic.
- Delete `solpayMatchesReq`; strict transaction verification becomes the binding mechanism.

**Exit criteria**

- No v1 encoder, decoder, type, or compatibility branch remains.
- Protocol validation is pure, total where practical, and covered at malformed boundaries.

### Phase 2 - Canonical recent-blockhash transaction construction and verification

**Primary files**

- `app/solana/tx.ts`
- `app/solana/spl.ts`
- `app/solana/nonce.ts` (source to dismantle)
- `app/__tests__/solana-tx.test.ts`
- `app/__tests__/solana-spl.test.ts`
- `app/__tests__/solana-nonce.test.ts` (delete after replacement coverage lands)

**RED tests first**

- Golden SOL and USDC v2 messages match committed fixtures generated out-of-band with
  `@solana/web3.js` and `@solana/spl-token`; those packages are not runtime dependencies.
- The request URI digest and Memo bytes are stable under Hermes/Node/browser-compatible primitives.
- The verifier accepts only the canonical message and valid payer signature.
- Mutation cases reject changed recipient, amount, blockhash, memo, request ID, mint, decimals, source
  ATA, destination ATA, fee payer, signer count, account flags, program, instruction order, and any
  added instruction.
- Truncated/malformed/versioned transaction inputs fail closed and never throw across the UI boundary.
- Non-canonical compact-u16, malformed account indexes, trailing bytes, multi-signature headers, and
  packet-limit violations fail closed.

**Implementation**

- Move `AccountMeta`, `Instruction`, and `assembleMessage` from `nonce.ts` into `tx.ts`.
- Add the Memo instruction builder and domain-separated request digest.
- Build canonical SOL `{Memo,System.transfer}` messages.
- Replace raw SPL `Transfer` with canonical `TransferChecked` and build
  `{Memo,Token.transferChecked}` messages.
- Implement strict verification by extracting payer/signature/message, rebuilding the expected message
  from the open request and payer public key, requiring byte equality, then verifying Ed25519.
- Return the payer address and first signature only after all checks pass.

**Delete in this phase**

- `buildCreateNonceAccountMessage`
- `buildAdvanceAndTransferMessage`
- `buildAdvanceAndSplTransferMessage`
- nonce sysvar and rent constants from transaction code
- warning-only merchant signature verification
- `app/solana/nonce.ts` only after generic assembly moves to `tx.ts` and deterministic nonce derivation,
  strict parsing, and withdrawal construction move directly to the new reclaim-only module in this
  phase; no temporary payment-facing nonce module lands

**Exit criteria**

- Payment construction has no nonce instruction or nonce-account dependency.
- Merchant validation proves exact signed semantics before any RPC send.

### Phase 3 - Replace the Solana lifecycle seam and RPC freshness logic

**Primary files**

- `app/solana.ts`
- `app/solana/rpc.ts`
- `app/config/constants.ts`
- `app/__tests__/solana-seam.test.ts`
- `app/__tests__/solana-rpc.test.ts`

**RED tests first**

- Request creation fetches one fresh blockhash result including context slot and produces v2 only.
- SOL and USDC signing perform no network calls.
- Approval uses a known SOL balance to require amount plus exactly 5,000 lamports for SOL, or at least
  5,000 lamports plus sufficient token balance for USDC. V2 has one signature and no priority-fee
  instruction, so this expected fee is frozen and tested. Known insufficiency blocks; stale/unavailable
  balances warn and require consent but do not add a payer network call.
- Broadcast refuses invalid semantics, mismatched request IDs, stale wall-clock requests, invalid
  blockhashes, and block heights beyond `lvh` before `sendTransaction`.
- Identical signed bytes reconcile/rebroadcast safely; a conflicting signature for a reserved `rid`
  is rejected.
- Confirmation distinguishes confirmed, chain rejection, authoritative expiry, and honest unknown.
- Existing direct `sendSol`, `sendSpl`, balances, ATA checks, and RPC availability remain unchanged.

**Implementation**

- Add an online `createSolPaymentRequest` seam that fetches freshness data and returns request + URI.
- Replace durable-nonce `signOfflineSolPayment`/`signOfflineSplPayment` with v2 recent-blockhash signers.
- Replace `broadcastSolPayment(solpay)` with
  `broadcastSolPayment(request, canonicalRequestUri, payment, ...)`, running strict verification over
  the persisted URI and freshness checks before send.
- Extend RPC with `getGenesisHash`, context slot, `getBlockHeight`, required `isBlockhashValid`,
  history-aware signature status, `getFeeForMessage`, and block-height-aware confirm. Thread the
  request `slot` as `minContextSlot` only through compatible calls; validate the context returned by
  `getSignatureStatuses` separately.

**Delete in this phase**

- `createNonceAccount`
- `resyncNonce`
- normal-payment `getNonceAccount` and rent-exemption calls
- post-confirm nonce reads/retries and `nextNonce` receipt fields
- nonce-specific timeout and error copy

**Exit criteria**

- The exported normal payment seam has no nonce vocabulary or state.
- Every merchant broadcast path passes through one strict verifier and freshness decision.

### Phase 4 - Remove setup and nonce state from QR payment UI

**Primary files**

- `app/components/SolPayMode.tsx`
- `app/components/SolReceiveMode.tsx`
- `app/services/solNoncePersist.ts`
- new `app/services/solMerchantPersist.ts`
- `app/hooks/useNfcTapState.ts` comments/types where SOL semantics are described
- related component Jest/e2e seams

**RED tests first**

- A payer with no prior setup can scan, review, and sign a valid v2 request while offline.
- The Pay UI has no setup payment, nonce status, stale state, or resync action.
- Receive request creation is online/asynchronous, reports RPC failure honestly, and displays a short
  countdown based on v2 expiry.
- The open request is durably persisted before its QR or NFC URI becomes visible.
- Request refresh uses a new request ID and blockhash only after the prior outcome permits it.
- Unknown settlement preserves the signature and offers reconciliation, not immediate replacement.
- Killing/restarting after reservation restores the raw transaction and reconciles before allowing a
  new request; simultaneous QR/NFC handoffs cannot reserve conflicting signatures.
- SOL and USDC immutable asset-lock behavior remains intact.

**Implementation**

- Start `SolPayMode` in scan phase and delete nonce load/save effects and callbacks.
- Sign directly from `SolReqV2`; preserve review, balance, expiry, asset, and selection-lock checks.
- Make `SolReceiveMode.makeRequest()` asynchronous and fetch freshness immediately before displaying
  QR/NFC.
- Persist the merchant request state before first broadcast, restore it on mount, and drive QR scan
  outcomes from one race-safe reducer.
- Gate request creation on Solana RPC availability, not the IC relay `online` prop.
- Keep direct Send-to-address unchanged.

**Delete in this phase**

- `SolNonceState` from payment component props/state
- setup UI and `btn-sol-pay-setup`
- stale/resync UI and handlers
- normal payment imports from `app/services/solNoncePersist.ts`
- e2e setup-error behavior that no longer exists

**Exit criteria**

- A fresh install can make an offline SOL/USDC payment without any setup transaction or reserve.
- Searching Pay/Receive code for nonce setup, persistence, stale, or resync returns no payment hits.

### Phase 5 - Replace NFC receipt and bridge contracts

**Primary files**

- `app/components/SolNfcTap.tsx`
- `app/lib/types.ts`
- `app/services/native.ts`
- `app/android/app/src/main/java/com/dpay/DpaySolNfc.kt`
- `app/android/app/src/main/java/com/dpay/DpaySolNfcModule.kt`
- `app/android/app/src/main/java/com/dpay/DpaySolHostApduService.kt`
- `e2e/web/dpay-sol-nfc.ts`
- `e2e/web/shims.ts`
- NFC Jest/e2e/on-device tests

**RED tests first**

- NFC carries v2 request and payment strings without truncation.
- The payer signs with no nonce state prop.
- Merchant applies the same strict verifier and freshness rules as QR.
- Receipt matching requires exact `rid` and expected transaction signature.
- Cross-tap request ID, wrong signature, v1 payload, malformed transaction, and expired request fail
  closed.
- Unknown confirmation is pending, never success; a confirmed transaction is success.
- Confirmation exceeding 8 seconds returns an unknown receipt before the native 12-second deadline;
  tag loss or no receipt leaves the payer pending while merchant reconciliation continues.

**Implementation**

- Change `confirmSolReceipt` to `(status, rid, sig)` throughout TS, Kotlin, and the e2e shim.
- Change `SolNfcEvent.receipt` to `{status,rid,sig}` and remove `npub`/`nextNonce`.
- Capture expected request ID and signed transaction signature on the payer before serving payment.
- Reuse the exact QR signing, validation, broadcast, and outcome helpers; NFC remains transport only.
- Keep SOL AID and chunk framing unchanged unless a focused byte-limit test proves a real issue.
- Keep the existing 12-second native receipt bound and use a hard maximum 8-second JS settlement
  budget, leaving bridge scheduling and receipt APDU transfer headroom. Do not extend NFC proximity to
  the blockhash window. Test both timeout constants together.

**Delete in this phase**

- nonce-state props and callbacks from `SolNfcTap`
- `npubRef`, nonce adoption, and stale callbacks
- Kotlin `nextNonce` and `npub` receipt fields
- stale comments in `useNfcTapState` and native files

**Exit criteria**

- `just bridge-parity` reports the intentional new arity consistently.
- `just aid-parity` still proves IC and SOL AIDs independently.
- QR and NFC call the same money-critical functions.

### Phase 6 - Ship the isolated legacy nonce reclaim

The nonce account was already shipped and funded by users. Removing payment support must not strand
its reserve. Reclaim therefore remains indefinitely discoverable from a restored seed until RPC
proves the deterministic account is absent. It must not depend solely on AsyncStorage, because an app
reinstall or seed restore loses that marker.

**Primary files**

- new `app/solana/reclaim.ts`
- new `app/components/SolNonceReclaim.tsx` or a focused Settings section
- `app/components/SettingsSheet.tsx`
- `app/services/solNoncePersist.ts`
- legacy `deriveNonceAccountKeypair` currently private in `app/solana.ts`
- `app/solana/rpc.ts`
- focused reclaim Jest and e2e tests

**RED tests first**

- Reclaim derives the shipped nonce key at `m/44'/501'/0'/1'` from the same recovery seed even when
  no AsyncStorage record exists.
- Inspection distinguishes absent, initialized-and-owned, malformed, wrong owner, and wrong authority.
- Only a non-executable, exactly 80-byte System Program nonce account with `(version,state)` exactly
  `(0,1)` legacy-initialized or `(1,1)` current-initialized, exact device authority, and safely parsed
  lamports is reclaimable. Current version 1 must have a shipped-account fixture; all other tags fail.
- Reclaim builds reference-byte-equal nonce withdrawal/closure instructions and signs with required
  device-controlled keys.
- Closure is confirmed on-chain before the old storage key is cleared or success shown.
- A restored wallet can rediscover a still-open account; a confirmed absent account hides the action.
- `getFeeForMessage` proves the main wallet can pay the fee; insufficient fee balance and unknown
  broadcast outcomes are surfaced honestly.

**Implementation**

- Move only the minimum legacy derivation, account parser, and withdraw/close builder into
  `reclaim.ts`; do not import it from payment code.
- Query the deterministic address online when the user opens the reclaim section or explicitly checks.
- Show the exact recoverable lamports and explain that reclaim invalidates any old offline-signed
  durable-nonce payment.
- Build `WithdrawNonceAccount` for the exact full nonce balance to the main SOL address. The main
  wallet is both nonce authority signer and fee payer; the nonce account is a writable nonsigner and
  its creation key is not needed. Quote the fee with `getFeeForMessage` and require the main wallet to
  hold it. Confirm account absence, then clear `dpay.sol.nonce.v1.<pubkey>` best-effort. Closing the
  account invalidates every outstanding v1 signed payment.

**Exit criteria**

- Existing users can recover the reserve without retaining any legacy payment path.
- Reclaim code has no imports from `SolPayMode`, `SolReceiveMode`, `SolNfcTap`, or v2 protocol code.
- `app/services/solNoncePersist.ts` contains only migration-key lookup/clear if still needed; legacy
  load/save/hydration lifecycle code and its old test are deleted.

### Phase 7 - Delete legacy evidence and prove production readiness

**Primary files**

- `app/App.tsx`
- `app/__tests__/**`
- `e2e/tests/45-sol-receive.mjs`
- `e2e/tests/46-sol-offline-handoff.mjs`
- `e2e/tests/47-sol-nfc.mjs`
- `e2e/tests/51-sol-merchant-broadcast.mjs`
- `e2e/tests/53-sol-merchant-error.mjs`
- `e2e/tests/66-sol-nfc-error.mjs`
- `e2e/tests/67-sol-setup-error.mjs` (replace with reclaim coverage or delete)
- `FLOWS.md`
- `CLAUDE.md`
- `CODEBASE_ANALYSIS.md`
- `OPEN_ISSUES.md`
- current Solana architecture docs

**Implementation**

- Replace `DPAY_SOL_SELFCHECK`'s nonce message with pure v2 canonical SOL/USDC construction, strict
  verification, and signature extraction that runs under Hermes without network access.
- Replace old unit/e2e expectations rather than preserving compatibility fixtures in active suites.
- Add e2e coverage for fresh SOL and USDC requests, offline payer signing, v1 rejection, wall-clock
  expiry, block-height expiry, every semantic-tamper class, duplicate rebroadcast, conflicting
  signature, unknown reconciliation, NFC receipt binding, and legacy reclaim.
- Update `FLOWS.md` counts and coverage slugs.
- Update living docs so durable nonce is not described as the active payment architecture. Keep dated
  historical documents intact but mark them superseded at the top rather than rewriting history.
- Resolve or rewrite documented nonce risks and add the v2 short-validity/unknown-outcome invariants to
  `CODEBASE_ANALYSIS.md`.

**Required gates**

- Focused Jest suites during each phase.
- `just verify` after the complete replacement.
- `node scripts/check-prod-sol.mjs` against the production mainnet configuration.
- Production catalog reconciliation to ensure Solana remains app-only and network-qualified.
- `just app`, with both `DPAY_SELFCHECK PASS` and `DPAY_SOL_SELFCHECK PASS` in logcat.
- `just ondevice` for its existing standalone UniFFI/IC NFC coverage, plus a new app-native SOL NFC
  instrumentation gate wired into `just` for `DpaySolNfc.kt` framing, timeout, and receipt tests.
- Physical two-phone QR and NFC proof on mainnet with a low-value SOL payment and a low-value USDC
  payment. Exercise success, deliberate expiry, and interrupted/unknown handoff.
- On-chain reclaim proof for a funded legacy nonce account before calling the migration production
  ready.
- `check-prod-sol.mjs` proves baked configuration only; add a live production RPC genesis-hash and v2
  capability probe as an outer-loop gate. Catalog reconciliation checks visible asset/network labels;
  a source/import boundary check proves no Solana code entered relay/IC/Rust/canister surfaces.

**Exit criteria**

- `rg -n "createNonceAccount|resyncNonce|signOffline.*nonce|nextNonce|npub|solreq:v1|solpay:v1" app`
  returns only explicit v1-rejection fixtures or isolated reclaim/history references.
- `rg -n "solNoncePersist|SolNonceState|buildAdvance|NONCE_ACCOUNT_LENGTH" app/components app/solana.ts`
  returns no normal payment path.
- No v1 transaction can reach `sendTransaction`.
- All automated and device gates pass, and physical two-phone evidence is recorded in
  `OPEN_ISSUES.md` or the completion header of this plan.

## Deletion matrix

| Legacy surface | Replacement | Deletion point |
|---|---|---|
| `solreq:v1` / `solpay:v1` codecs | v2 codec | Phase 1 |
| echoed payment `to/amt/cur` matching | canonical signed-message equality | Phase 2 |
| warning-only signature check | blocking signature + semantic verifier | Phase 2 |
| nonce create/advance transaction builders | Memo + recent-blockhash transfer builders | Phase 2 |
| create/read/resync lifecycle in `app/solana.ts` | request creation + freshness validation | Phase 3 |
| setup/stale/resync Pay UI | direct scan/review/sign | Phase 4 |
| normal nonce AsyncStorage lifecycle | no payer payment persistence | Phase 4/6 |
| `npub`/`nextNonce` NFC receipt | `rid`/transaction signature receipt | Phase 5 |
| nonce self-check | v2 canonical transaction self-check | Phase 7 |
| nonce setup e2e flow | no-setup and reclaim flows | Phase 7 |

## Explicit non-goals

- Merchant-sponsored fees or multi-party signing.
- Delayed payment handoff beyond the recent-blockhash validity window.
- A relay-backed Solana request/session service.
- Versioned Solana transactions; v2 uses the existing hand-rolled legacy transaction format.
- Automatic USDC ATA creation.
- Accepting old v1 requests or payments for convenience.
- Any change to IC settlement, NFC AID, canister topology, or catalog ownership.

## Production-ready definition

The rewrite is ready for production only when a fresh install can complete offline-payer SOL and USDC
payments without setup; the merchant rejects every transaction mutation before broadcast; expiry and
unknown outcomes cannot create accidental double payment; QR and NFC share the same strict protocol;
existing deterministic nonce accounts can be safely reclaimed; living docs describe v2 as current;
all inner-loop, Android, and physical two-phone gates are green; and the shipped build contains no
normal durable-nonce payment code.
