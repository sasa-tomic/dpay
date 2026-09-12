// Flow 172 — the transaction log NAMES its rows from device-saved notes (txNotes, 2026-09-11).
//
// The rails carry no counterparty name and no human message: on IC the memo slot IS the frozen
// 16-byte nonce (the reconciliation key — extending it was REJECTED), on Solana the message is
// write-only (parsing memos back on every history tick is flow 160's forbidden path). So the only
// place a friendly row can come from is the device's own record of the moment it paid or requested
// (app/services/txNotes.ts), written at the seams: PayMode approve/approveOcp, NfcTap approve,
// ReceiveMode makeRequest, SolPayMode approveSpay/sendSolForOcp + the offline solreq:v2 sign
// (approve), SolNfcTap approve (card-side auto-sign), Practice approve, the SOL pay-link send
// (SolanaWithdrawSheet confirm), and the convert legs (executeConvert, venue-named).
//
// This flow drives six of them through the real UI and asserts what the USER sees:
//   (a) payer pays a request QR carrying to_name="Bob" + memo="coffee" → Home feed and the
//       Transactions ledger read "to Bob" + "coffee"; the receipt carries Peer="Bob",
//       Note="coffee", the FULL payee principal, the hex nonce as reference, and the honest
//       footer that says the name and note were saved on this device;
//   (b) payee makes a request with a typed message, a harness payer settles it → the incoming
//       row keeps the payer's SHORT PRINCIPAL (payers are unnamed by design — nothing is
//       invented) while the typed message annotates the memo line; its receipt has NO Peer line;
//   (c) a Solana-Pay URI with label + message → the SOL row is named and carries the message,
//       keyed by the signature the send itself returned (the stub echoes it into history);
//   (e) an OFFLINE solreq:v2 merchant QR (name + memo) auto-signs → the note is keyed by the
//       signature the SIGN itself produced (extracted from the solpay:v2 QR) — the merchant's
//       later broadcast is simulated by pinning the stub's history to that signature;
//   (f) the same sign-time note through the NFC card (flow-47 event seam; the radio hop stays
//       a physical-device gate) → the tap's solpay signature names the row;
//   (d) a plain un-annotated harness transfer stays EXACTLY as before: short principal + hex
//       nonce on the row, no Peer/Note lines, the plain "read from the ledger" footer.
//
// Not drivable here: the practice payment (F3) and the convert legs (F6) — the practice screen
// needs a first-run identity and the convert legs need a venue-pool fixture; both seams are
// pinned in jest (Practice.test.tsx / convert.test.ts) instead.
import { setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount, railTransfer,
  railPrincipalText, armPayScan, armNfcCard, openBalances } from '../harness/lib.mjs';
import { generateKeypair, randNonceHex, buildRequestQR } from '../harness/wire.mjs';

const SOL_MERCHANT = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';
const SOL_REFERENCE = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SPAY_LABEL = 'Coffee Bar';
const SPAY_MESSAGE = 'Order 42';
const REQ_MESSAGE = 'bike parts';
const SOL_REQ_NAME = 'Market Stall'; // ≤32 code units — the qr codec's MAX_NAME_LEN cap
const SOL_REQ_MEMO = 'Farm veg box';
const SOL_NFC_NAME = 'Bakery Van';
const SOL_NFC_MEMO = 'Sourdough';
const SOL_BH = 'FzFAtwLSSzxhug4sEvUeusLxFdjAS3ByYqgseUYkFpkN'; // flow-46/47 fixture blockhash
const SOL_LAMPORTS = '1000000'; // 0.001 SOL — matches the stub's fabricated getTransaction delta

// Minimal base58 encoder (avoids a bs58 dependency in the e2e node_modules — flow-47 precedent).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58Encode(bytes) {
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  let out = '';
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break; }
  return out;
}

// Extract the first 64-byte signature from a v2 solpay URI (base64url tx → compact-u16 || sig64 || msg).
function extractSig(solpayUri) {
  const payload = solpayUri.split('solpay:v2?')[1];
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const tx = Buffer.from(obj.tx, 'base64url');
  // tx layout: compact-u16 sigCount (1 byte for count 1) || sigCount*64 bytes || message
  return bs58Encode(new Uint8Array(tx.slice(1, 65)));
}

// Canonical-order solreq:v2 URI (decode re-serializes and compares — field order is load-bearing).
function buildSolReqUri(rid, name, memo) {
  const iat = Math.floor(Date.now() / 1000);
  const obj = {
    v: 2, rid, net: 'mainnet-beta',
    bh: SOL_BH, lvh: 300_000_000, slot: 250_000_000,
    iat, exp: iat + 90,
    to: SOL_MERCHANT, amt: SOL_LAMPORTS, cur: 'SOL',
    mint: null, toAta: null, name, memo,
  };
  return 'solreq:v2?' + Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** Flow metadata — read by `e2e/harness/meta.mjs` (filter + coverage matrix + per-test timeout)
  * and by `e2e/gen-flows-md.mjs` (FLOWS.md generation). The filename is the source of truth for
  * id/name; journey/covers/verifies/timeoutMs are the authored intent. */
export const meta = {
  id: '172',
  name: 'log-names-messages',
  journey: 'system',
  covers: ['history', 'names', 'memo', 'txnotes', 'receipt', 'activity-feed', 'solana-pay', 'sol-offline', 'sol-nfc', 'honest-copy'],
  verifies: 'Device-saved notes name the transaction log: a paid request shows to_name + human memo on the row and Peer/Note on the receipt beside the full principal and hex reference; a payee-side request shows the typed message but never invents a payer name; a labelled Solana-Pay, an offline solreq:v2 QR, and an NFC tap all name their SOL rows by the signature the sign/send itself produced; an un-annotated transfer keeps principal + hex with no Peer/Note lines.',
  timeoutMs: 120_000,
};

export async function run() {
  const start = Date.now();
  console.log('[172-log-names-messages] setup (relay + web + browser + sol stub)…');
  const env = await setup({ solStub: true });
  try {
    const { driver, relayBaseURL } = env;

    console.log('[172-log-names-messages] onboarding…');
    // NFC must read 'ready' BEFORE the Wallet mounts (the status is read once at mount + on
    // AppState changes — a mid-session flip is invisible in the browser). Arming the card from
    // the start is inert until (f): nothing dispatches tap events until then.
    await driver.eval(() => { globalThis.__DPAY_TEST_NFC_STATUS = 'ready'; });

    await onboardWallet(driver, 'e2e-lognames');
    const me = await accountOf(driver);

    // The in-page SOL RPC stub (flow-119 pattern, extended with a history half): sendTransaction
    // captures the signature it echoes; getSignaturesForAddress returns it — but ONLY for the
    // wallet's own address (captured on first query, before the ATA fan-out) — and getTransaction
    // fabricates a balance-delta detail the reader will accept (owner index 0 moves amount+fee to
    // the merchant at index 1). Until a send happens, history is empty.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getMultipleAccounts: (p) => globalThis.__DPAY_SOL_ACCOUNTS(p, { lamports: 5000000000, token: { amount: '2000000', decimals: 6 } }),
        getGenesisHash: () => '4uhcVJyU9pJkvQyS29u4DelQEvShkTXUQHJypwSFVmFc',
        getLatestBlockhash: () => { globalThis.__DPAY_TEST_SOL_BH = (globalThis.__DPAY_TEST_SOL_BH ?? 0) + 1; return { context: { slot: 250000000 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 + globalThis.__DPAY_TEST_SOL_BH } }; },
        isBlockhashValid: () => ({ context: { slot: 250000001 }, value: true }),
        getBlockHeight: () => 250000001,
        getSignatureStatuses: () => ({ context: { slot: 250000002 }, value: [{ confirmationStatus: 'confirmed' }] }),
        getBalance: () => ({ value: 5000000000 }),
        getTokenAccountBalance: () => ({ value: { amount: '2000000', decimals: 6, uiAmount: 2, uiAmountString: '2' } }),
        getAccountInfo: () => null,
        sendTransaction: () => { const sig = 'sig_' + Math.random().toString(36).slice(2, 12); globalThis.__DPAY_LAST_SOL_SIG = sig; return sig; },
        getSignaturesForAddress: (p) => {
          const owner = p?.[0];
          if (owner && !globalThis.__DPAY_SOL_OWNER) globalThis.__DPAY_SOL_OWNER = owner; // first query = the wallet
          const sig = globalThis.__DPAY_LAST_SOL_SIG;
          if (!sig || owner !== globalThis.__DPAY_SOL_OWNER) return [];
          return [{ signature: sig, slot: 900, blockTime: Math.floor(Date.now() / 1000), err: null }];
        },
        getTransaction: (p) => {
          const sig = p?.[0];
          const owner = globalThis.__DPAY_SOL_OWNER;
          if (!sig || sig !== globalThis.__DPAY_LAST_SOL_SIG || !owner) return null;
          const pre = 5000000000, amount = 1000000, fee = 5000; // 0.001 SOL + fee, index 0 = owner
          return {
            slot: 900, blockTime: Math.floor(Date.now() / 1000),
            meta: { err: null, fee, preBalances: [pre, 0], postBalances: [pre - amount - fee, amount],
              preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [] },
            transaction: { signatures: [sig], message: {
              accountKeys: [owner, 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r'],
              header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
              instructions: [], recentBlockhash: '11111111111111111111111111111111' } },
          };
        },
      };
    });

    // ── (a) the payer pays a NAMED request with a human memo ─────────────────────────────────
    const bob = await generateKeypair();
    const bobPrincipal = await railPrincipalText(bob.publicHex);
    const nonceA = randNonceHex();
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const requestQR = buildRequestQR(bob.publicHex, 2500, nonceA, expiry, 0, 'Bob', 'coffee');
    await armPayScan(driver);
    await driver.eval((qr) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(qr); }, requestQR);
    assert(await driver.waitForText('Paid', { timeoutMs: 10_000 }), '(a) the named request should auto-sign to Paid');

    // Home activity feed first — the same resolver feeds both lists.
    await driver.click('tab-home', { timeoutMs: 4_000 });
    await driver.findByTestID('home-activity', { timeoutMs: 5_000 });
    assert(await driver.waitForText('coffee', { timeoutMs: 12_000 }), '(a) the Home feed should show the note message');
    const homeBody = await driver.bodyText();
    assertIncludes(homeBody, 'to Bob', '(a) Home row shows the payee NAME (device-saved note)');
    assertIncludes(homeBody, 'coffee', '(a) Home row shows the human message');
    assert(!homeBody.includes(bobPrincipal), '(a) Home must NOT dump the full principal');
    assert(!homeBody.includes(bob.publicHex), '(a) Home must NOT dump the raw pubkey');

    // Then the full ledger + the receipt (the dispute surface keeps ledger truth checkable).
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    await driver.findByTestID('ledger-view', { timeoutMs: 5_000 });
    assert(await driver.waitForText('coffee', { timeoutMs: 12_000 }), '(a) the ledger row should show the note message');
    const histBody = await driver.bodyText();
    assertIncludes(histBody, 'to Bob', '(a) ledger row shows the payee NAME');
    assertIncludes(histBody, 'coffee', '(a) ledger row shows the human message');
    assert(!histBody.includes(nonceA.slice(0, 8)), '(a) the hex nonce prefix is off the row — the message replaced it');
    assert(!histBody.includes(bobPrincipal), '(a) the ledger must NOT dump the full principal');

    await driver.click('hist-row-0', { timeoutMs: 5_000 });
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertEqText(await driver.readText('txn-receipt-peer'), 'Bob', '(a) receipt Peer is the saved name');
    assertEqText(await driver.readText('txn-receipt-note'), 'coffee', '(a) receipt Note is the saved message');
    assertEqText(await driver.readText('txn-receipt-account'), bobPrincipal, '(a) receipt account stays the FULL payee principal');
    assertEqText(await driver.readText('txn-receipt-ref'), nonceA, '(a) receipt reference stays the hex nonce');
    assertIncludes(await driver.bodyText(), 'saved on this device', '(a) the annotated receipt foots with the honest variant');
    await driver.screenshot('172-log-names-messages-a');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (a) payer side: to Bob + coffee; receipt Peer/Note + full principal + hex ref');

    // ── (b) the payee's own request: typed message, payer stays UNNAMED ──────────────────────
    await driver.click('tab-receive', { timeoutMs: 4_000 });
    await driver.type('amount-input', '18.00', { timeoutMs: 4_000 });
    await driver.type('memo-input', REQ_MESSAGE, { timeoutMs: 4_000 });
    await driver.click('btn-request', { timeoutMs: 4_000 });
    await driver.findByTestID('request-qr', { timeoutMs: 5_000 });
    const requestQRB = await driver.eval(() => window.__DPAY_QR_LAST);
    // Founder 2026-09-12: the QR is the payment LINK — the `ref` param IS the request nonce.
    const req = await driver.eval((qr) => {
      const nonceHex = new URL(qr, 'https://dpay.invalid').searchParams.get('ref') ?? '';
      return { nonceHex };
    }, requestQRB);
    console.log(`[172-log-names-messages] (b) request nonce=${req.nonceHex.slice(0, 12)}… memo="${REQ_MESSAGE}"`);

    const payer2 = await generateKeypair();
    const payer2Principal = await railPrincipalText(payer2.publicHex);
    const fund2 = await faucetAccount(relayBaseURL, payer2.publicHex, 10000);
    assert(fund2.ok, `(b) payer faucet should succeed, got ${fund2.status}`);
    const paid2 = await railTransfer(relayBaseURL, payer2.secretHex, me.publicHex, 1800n, { memoHex: req.nonceHex });
    assert(paid2.ok === true && paid2.status === 202, `(b) the rail payment must be accepted (202), got ${JSON.stringify(paid2)}`);

    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    assert(await driver.waitForText(REQ_MESSAGE, { timeoutMs: 15_000 }), '(b) the incoming row should show the typed message');
    const histBodyB = await driver.bodyText();
    assertIncludes(histBodyB, payer2Principal.slice(0, 8), '(b) the incoming row keeps the payer short principal (payers are unnamed)');
    assert(!histBodyB.includes(payer2Principal), '(b) the ledger must NOT dump the full payer principal');
    assert(!histBodyB.includes(payer2.publicHex), '(b) the ledger must NOT dump the raw payer pubkey');

    await driver.click('hist-row-0', { timeoutMs: 5_000 }); // newest row = the (b) settlement
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    const bNoPeer = await driver.eval(() => document.querySelector('[data-testid="txn-receipt-peer"]') === null);
    assert(bNoPeer, '(b) NO Peer line — the payee never invents a payer name');
    assertEqText(await driver.readText('txn-receipt-note'), REQ_MESSAGE, '(b) receipt Note is the payee\'s own typed message');
    assertEqText(await driver.readText('txn-receipt-account'), payer2Principal, '(b) receipt account is the payer\'s FULL principal');
    assertEqText(await driver.readText('txn-receipt-ref'), req.nonceHex, '(b) receipt reference is the request nonce');
    await driver.screenshot('172-log-names-messages-b');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (b) payee side: payer stays principal, the typed message annotates');

    // ── (c) Solana-Pay with label + message → the SOL row is named by its signature ─────────
    await openBalances(driver);
    await driver.click('asset-sol-select', { timeoutMs: 5_000 });
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await driver.findByTestID('sol-pay-scan', { timeoutMs: 5_000 });
    await armPayScan(driver); // funnels btn-sol-start-scan on the SOL rail
    const spayUri = `solana:${SOL_MERCHANT}?amount=0.001&reference=${SOL_REFERENCE}&label=${encodeURIComponent(SPAY_LABEL)}&message=${encodeURIComponent(SPAY_MESSAGE)}`;
    await driver.eval((uri) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(uri); }, spayUri);
    assert(await driver.waitForText(SPAY_LABEL, { timeoutMs: 8_000 }), '(c) the spay review should show the label');
    assert(await driver.waitForText(SPAY_MESSAGE, { timeoutMs: 5_000 }), '(c) the spay review should show the message');
    await driver.click('btn-approve', { timeoutMs: 5_000 });
    assert(await driver.waitForText('sig_', { timeoutMs: 15_000 }), '(c) the spay should complete with a signature');
    await driver.screenshot('172-log-names-messages-c-pay');
    await driver.click('btn-sol-pay-done', { timeoutMs: 5_000 });

    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    assert(await driver.waitForText(SPAY_MESSAGE, { timeoutMs: 15_000 }), '(c) the SOL history row should show the message');
    const histBodyC = await driver.bodyText();
    assertIncludes(histBodyC, `to ${SPAY_LABEL}`, '(c) the SOL row is named by the URI label (note keyed by signature)');
    assert(!histBodyC.includes(SOL_MERCHANT), '(c) the full merchant pubkey stays off the ledger rows');

    await driver.click('hist-row-0', { timeoutMs: 5_000 }); // newest row = the SOL payment
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertEqText(await driver.readText('txn-receipt-peer'), SPAY_LABEL, '(c) receipt Peer is the spay label');
    assertEqText(await driver.readText('txn-receipt-note'), SPAY_MESSAGE, '(c) receipt Note is the spay message');
    assertEqText(await driver.readText('txn-receipt-account'), SOL_MERCHANT, '(c) receipt account is the FULL merchant pubkey');
    assertIncludes(await driver.bodyText(), 'saved on this device', '(c) the annotated receipt foots with the honest variant');
    await driver.screenshot('172-log-names-messages-c');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (c) SOL spay: named row + message, keyed by the send\'s own signature');

    // ── (e) OFFLINE solreq:v2 merchant QR: the note is keyed by the SIGN's own signature ────
    // The offline QR path never touches the network, so the only key the note can carry is the
    // signature signSolPayment just produced — extracted here from the solpay:v2 the QR shows
    // (the harness twin of what the merchant's reader will broadcast; flow 51 minus the radio).
    // The stub's history half returns only __DPAY_LAST_SOL_SIG, so pinning that global to the
    // extracted signature IS the simulated broadcast + settlement.
    const ridE = 'e'.repeat(32);
    await driver.click('tab-pay', { timeoutMs: 4_000 }); // (c) left the ledger tab open
    await driver.findByTestID('sol-pay-scan', { timeoutMs: 5_000 });
    await armPayScan(driver);
    await driver.eval((uri) => { if (typeof window.__DPAY_TEST_SCAN === 'function') window.__DPAY_TEST_SCAN(uri); }, buildSolReqUri(ridE, SOL_REQ_NAME, SOL_REQ_MEMO));
    await driver.findByTestID('sol-pay-qr', { timeoutMs: 8_000 });
    assert(await driver.waitForText(SOL_REQ_NAME, { timeoutMs: 5_000 }), '(e) the signed QR shows the claimed merchant name');
    const solpayUriE = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(typeof solpayUriE === 'string' && solpayUriE.startsWith('solpay:v2?'), `(e) the offline sign should render a solpay:v2 QR, got ${JSON.stringify(solpayUriE)?.slice(0, 60)}`);
    const sigE = extractSig(solpayUriE);
    await driver.screenshot('172-log-names-messages-e-qr');
    await driver.click('btn-sol-pay-handed', { timeoutMs: 5_000 });
    await driver.click('btn-sol-pay-done', { timeoutMs: 5_000 });

    await driver.eval((sig) => { globalThis.__DPAY_LAST_SOL_SIG = sig; }, sigE); // merchant broadcast it
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    assert(await driver.waitForText(SOL_REQ_MEMO, { timeoutMs: 15_000 }), '(e) the offline SOL row should show the memo');
    const histBodyE = await driver.bodyText();
    assertIncludes(histBodyE, `to ${SOL_REQ_NAME}`, '(e) the offline SOL row is named by the sign-time note (keyed by the sign\'s own signature)');
    assert(!histBodyE.includes(SOL_MERCHANT), '(e) the full merchant pubkey stays off the ledger rows');
    await driver.click('hist-row-0', { timeoutMs: 5_000 }); // newest row = the offline payment
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertEqText(await driver.readText('txn-receipt-peer'), SOL_REQ_NAME, '(e) receipt Peer is the solreq claimed name');
    assertEqText(await driver.readText('txn-receipt-note'), SOL_REQ_MEMO, '(e) receipt Note is the solreq memo');
    assertEqText(await driver.readText('txn-receipt-account'), SOL_MERCHANT, '(e) receipt account is the FULL merchant pubkey');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (e) offline solreq:v2: named row + memo, keyed by the sign\'s own signature');

    // ── (f) the NFC card: the same sign-time note through the tap's radio twin ────────────────
    // The radio hop is a physical-device gate; this drives the JS event plumbing the real Kotlin
    // DpaySolNfc module emits (flow-47 seam) through the REAL SolNfcTap state machine: request
    // arrival AUTO-SIGNS (one-press rule), the signed solpay is stashed by the shim, and a settled
    // receipt matching rid+sig lands the paid phase.
    const ridF = 'f'.repeat(32);
    await driver.click('tab-pay', { timeoutMs: 4_000 });
    await armPayScan(driver); // the (e) scan cycle closed the gate — the card only mounts armed
    const dispatch = async (event) => { await armNfcCard(driver, 'sol', { timeoutMs: 10_000 }); return driver.eval((e) => window.__DPAY_TEST_SOL_NFC_SESSION(e), event); };
    await dispatch({ type: 'request', role: 'card', solreqUri: buildSolReqUri(ridF, SOL_NFC_NAME, SOL_NFC_MEMO) });
    assert(await driver.waitForText('Communicating', { timeoutMs: 8_000 }), '(f) the tap request should auto-sign → exchanging (no review park)');
    const solpayUriF = await driver.eval(() => window.__DPAY_SOL_NFC_LAST);
    assert(typeof solpayUriF === 'string' && solpayUriF.startsWith('solpay:v2?'), `(f) the tap auto-sign should produce a solpay:v2 URI, got ${JSON.stringify(solpayUriF)?.slice(0, 60)}`);
    const sigF = extractSig(solpayUriF);
    await dispatch({ type: 'receipt', role: 'card', status: 0, rid: ridF, sig: sigF });
    assert(await driver.waitForText('Sent', { timeoutMs: 6_000 }), '(f) the settled receipt should land the honest pending ("Sent · awaiting")');
    await driver.screenshot('172-log-names-messages-f-paid');
    await driver.click('btn-sol-pay-done', { timeoutMs: 5_000 });

    await driver.eval((sig) => { globalThis.__DPAY_LAST_SOL_SIG = sig; }, sigF); // merchant broadcast it
    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    assert(await driver.waitForText(SOL_NFC_MEMO, { timeoutMs: 15_000 }), '(f) the NFC-paid SOL row should show the memo');
    const histBodyF = await driver.bodyText();
    assertIncludes(histBodyF, `to ${SOL_NFC_NAME}`, '(f) the NFC-paid SOL row is named by the tap\'s sign-time note');
    await driver.click('hist-row-0', { timeoutMs: 5_000 }); // newest row = the NFC payment
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    assertEqText(await driver.readText('txn-receipt-peer'), SOL_NFC_NAME, '(f) receipt Peer is the tap request\'s claimed name');
    assertEqText(await driver.readText('txn-receipt-note'), SOL_NFC_MEMO, '(f) receipt Note is the tap request\'s memo');
    assertEqText(await driver.readText('txn-receipt-account'), SOL_MERCHANT, '(f) receipt account is the FULL merchant pubkey');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (f) NFC tap: named row + memo, keyed by the tap signature');

    // ── (d) a plain un-annotated transfer stays EXACTLY as the ledger said it ────────────────
    const payer4 = await generateKeypair();
    const payer4Principal = await railPrincipalText(payer4.publicHex);
    const fund4 = await faucetAccount(relayBaseURL, payer4.publicHex, 10000);
    assert(fund4.ok, `(d) payer faucet should succeed, got ${fund4.status}`);
    const nonceD = randNonceHex();
    const paid4 = await railTransfer(relayBaseURL, payer4.secretHex, me.publicHex, 700n, { memoHex: nonceD });
    assert(paid4.ok === true && paid4.status === 202, `(d) the rail payment must be accepted (202), got ${JSON.stringify(paid4)}`);

    await driver.click('tab-transactions', { timeoutMs: 4_000 });
    assert(await driver.waitForText('∂7.00', { timeoutMs: 15_000 }), '(d) the plain transfer should land in the ledger');
    const histBodyD = await driver.bodyText();
    assertIncludes(histBodyD, payer4Principal.slice(0, 8), '(d) the un-annotated row keeps the short principal');
    assertIncludes(histBodyD, nonceD.slice(0, 8), '(d) the un-annotated row keeps the hex nonce prefix (reconciliation key)');

    await driver.click('hist-row-0', { timeoutMs: 5_000 }); // newest row = the (d) transfer
    await driver.findByTestID('txn-receipt', { timeoutMs: 5_000 });
    const dPlain = await driver.eval(() => ({
      peer: document.querySelector('[data-testid="txn-receipt-peer"]') !== null,
      note: document.querySelector('[data-testid="txn-receipt-note"]') !== null,
    }));
    assert(!dPlain.peer, '(d) NO Peer line on an un-annotated receipt');
    assert(!dPlain.note, '(d) NO Note line on an un-annotated receipt');
    assertEqText(await driver.readText('txn-receipt-account'), payer4Principal, '(d) receipt account is the FULL payer principal');
    assertEqText(await driver.readText('txn-receipt-ref'), nonceD, '(d) receipt reference is the hex nonce');
    assertIncludes(await driver.bodyText(), 'read from the ledger', '(d) the plain receipt keeps the plain footer');
    await driver.screenshot('172-log-names-messages-d');
    await driver.click('btn-txn-receipt-close', { timeoutMs: 4_000 });
    await driver.waitGone('txn-receipt', { timeoutMs: 4_000 });
    console.log('[172-log-names-messages] ✓ (d) un-annotated: principal + hex, no invented lines');

    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[172-log-names-messages] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

function assertEqText(actual, expected, label) {
  assert(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((e) => { console.error(`\n[172-log-names-messages] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
