// Flow 105 — Every way a send destination can be WRONG, and the instruction each one gives.
//
// The founder's hard rule (2026-08-29): a user must be given useful practical instructions on every
// step, ESPECIALLY the error path — a state that only describes itself is a bug. So this flow does
// not merely assert "the send button is disabled"; it asserts that each refusal NAMES what the
// pasted address actually is and what to do instead, and that the app refuses to arm the send.
//
// Four refusals, all on VCHF (a no-minter direct-ICRC asset that settles only on the IC):
//   1. a real Bitcoin address        → named as Bitcoin, told VCHF settles on the Internet Computer
//   2. a real Ethereum address       → named as Ethereum, same instruction
//   3. a 64-hex account identifier  → named as an ICP account identifier; told only ICP itself can
//                                      be sent to one, and to ask for the principal instead
//   4. a truncated IC principal      → the CRC catches it; told it is incomplete or mistyped
//
// (3) is the interesting one: the address form is entirely REAL and reachable — but only on the ICP
// ledger, which is the one ledger exposing a legacy `transfer`. VCHF's ledger has no such method,
// so the honest answer names the limitation rather than pretending the address is malformed.
// (4) proves the destination is parsed by the REAL base32+CRC core parser, not a shape regex: the
// truncated string still LOOKS like a principal and is rejected only because the checksum fails.
//
// Selector contract: `balance`, `asset-vchf-select`, `btn-pay-send`, `send-address-input`,
// `send-status`, `btn-send-confirm`.
import {
  setup, assert, assertIncludes, onboardWallet, accountOf, faucetAccount,
  openBalances, selectCurrency, openPaySend, isDisabled,
} from '../harness/lib.mjs';

const CURRENCY = 7;
const ASSET_KEY = 'vchf';
const SEED = 500_000_000;

// Real addresses of each kind — the point is that they are VALID somewhere, just not here.
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const ETH_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
// The account identifier of the ICRC-1 spec's k2t6j-…-6ae principal (CRC-valid).
const ACCOUNT_ID = '051b05839339f89053454a4b9865ea0452a4bffe2b1cd41f4982bad10c1e637c';
// A real principal with its last character changed — shape-valid, checksum-invalid.
const TRUNCATED_PRINCIPAL = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6af';

export const meta = {
  id: '105',
  name: 'send-refusals',
  journey: 'withdraw',
  covers: ['send-to-address', 'wrong-chain', 'account-identifier', 'crc', 'fail-closed', 'instructions'],
  verifies: 'Send-to-address refusals are specific and actionable: a Bitcoin / Ethereum address is named as such and pointed at the right network, a 64-hex ICP account identifier is named and the principal asked for instead, and a checksum-broken principal is called incomplete — each with the send button left disabled.',
  // 45s, not 30s: measured 23.8s ALONE on an idle host, which left under 6s of headroom for a flow
  // that types into eleven fields and waits on a refusal for each. Any contention — another flow,
  // another process on the box — pushed it past even the harness's load-scaled budget, so it went
  // red on a tree where nothing was wrong. A budget that only passes on an idle machine is a
  // flake generator, not a gate.
  timeoutMs: 90000,
};

export async function run() {
  const start = Date.now();
  console.log('[105-send-refusals] setup (relay + web + browser)…');
  const env = await setup();
  try {
    const { driver, relayBaseURL } = env;

    await onboardWallet(driver, 'e2e-refuse');
    const identity = await accountOf(driver);
    const accountHex = identity?.publicHex;
    assert(typeof accountHex === 'string' && accountHex.length === 64, 'wallet account must be a 32-byte hex pubkey');

    // Fund VCHF so the fund-first gate does not stand in for the refusal under test — a zero
    // balance would hide the send form entirely and make this flow prove nothing.
    const fund = await faucetAccount(relayBaseURL, accountHex, SEED, { currency: CURRENCY });
    assert(fund.ok, `faucet funding must succeed, got HTTP ${fund.status}`);

    await openBalances(driver);
    await driver.waitForText('5.00 VCHF', { timeoutMs: 8_000 });
    await selectCurrency(driver, ASSET_KEY);
    await openPaySend(driver);
    await driver.findByTestID('send-address-input', { timeoutMs: 5_000 });

    // Each case: type the address, read the status line, assert it names the thing and instructs,
    // and assert the send button never becomes pressable.
    const cases = [
      {
        name: 'Bitcoin address',
        text: BTC_ADDR,
        expect: ['Bitcoin', 'Internet Computer'],
        why: 'names the pasted chain AND the chain VCHF actually settles on',
      },
      {
        name: 'Ethereum address',
        text: ETH_ADDR,
        expect: ['Ethereum', 'Internet Computer'],
        why: 'names the pasted chain AND the chain VCHF actually settles on',
      },
      {
        name: '64-hex ICP account identifier',
        text: ACCOUNT_ID,
        expect: ['ICP account identifier', 'principal'],
        why: 'names the address form and asks for the principal instead',
      },
      {
        name: 'checksum-broken principal',
        text: TRUNCATED_PRINCIPAL,
        expect: ['incomplete or mistyped'],
        why: 'the REAL base32+CRC parser rejected it — a shape regex would have accepted it',
      },
    ];

    for (const c of cases) {
      await driver.type('send-address-input', c.text, { timeoutMs: 4_000 });
      await driver.findByTestID('send-status', { timeoutMs: 5_000 });
      // The status resolves asynchronously (the core parser is async), so poll for the expected
      // wording rather than reading once and racing it.
      const found = await driver.waitForText(c.expect[0], { timeoutMs: 6_000 });
      const line = await driver.readText('send-status');
      assert(found, `[${c.name}] status line should mention "${c.expect[0]}", got: "${line}"`);
      for (const needle of c.expect) {
        assertIncludes(line, needle, `[${c.name}] refusal ${c.why}`);
      }
      const disabled = await isDisabled(driver, 'btn-send-confirm');
      assert(disabled, `[${c.name}] the send button must stay disabled while the destination is refused`);
      console.log(`[105-send-refusals] ✓ ${c.name}: "${line}"`);
      // Clear the field for the next case.
      await driver.type('send-address-input', '', { timeoutMs: 4_000 });
    }

    await driver.screenshot('105-send-refusals');
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`[105-send-refusals] GREEN in ${elapsed}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(async (e) => { console.error(`\n[105-send-refusals] RED: ${e.stack || e.message || e}\n`); process.exit(1); });
}
