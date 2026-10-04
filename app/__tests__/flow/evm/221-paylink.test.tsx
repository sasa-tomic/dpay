/**
 * Flow 221 evm-paylink — the jest twin of `e2e/tests/221-evm-paylink.mjs` (batch D port), the
 * achievable-subset port: the link grammar + the link's promise to the UI, no chain needed.
 *
 * Ported here: (1) the canonical `/wallet/pay/<0x…>?asset=ZCHF&network=<slug>&amount=<decimal>`
 * shape (recipient in the path, asset+network the routing pair, decimal display amount, NO ref —
 * there is no on-chain memo channel on ERC-20, the D18 fact); (2) the registry chain slugs
 * (42161→arbitrum, 1→ethereum, 421614→arbitrum-sepolia, 31337→anvil) with the lowercase-hyphen
 * no-aliasing rule; (3) the link's PROMISE to the app: delivered through the wallet's own link
 * pipeline (`__DPAY_TEST_DEEPLINK`), it resolves onto the evm asset and PREFILLS the send form —
 * full 0x destination + the link's amount, the route disclosed (the status line names the chain),
 * nothing ever signed; (4) the refusal: `?asset=ZCHF&network=solana` refuses wrong_network naming
 * BOTH the asset and the chain.
 *
 * NOT ported (needs the anvil chain — moves to the `just node-anvil` recipe): the staged
 * balance-verification of the link's promise through the relay pipe, and the anvil-network
 * prefill leg (the mainnet Arbitrum row stands in here — the resolution mechanics are identical).
 */
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';
import {it, expect} from '@jest/globals';
import {evmEnv} from './env';
import {deriveEvmKeypair} from '../../../evm/identity';
import {deadline as budgetDeadline} from '../harness/budget';

const g = globalThis as unknown as Record<string, unknown>;

/** The registry chain slugs (D7): the settlement-chain slug a shared link MUST spell. */
const CHAIN_SLUGS: Record<number, string> = {42161: 'arbitrum', 1: 'ethereum', 421614: 'arbitrum-sepolia', 31337: 'anvil'};

function payLink(opts: {origin: string; recipient: string; asset: string; network: string; amount?: string; label?: string}): string {
  const u = new URL(`${opts.origin}/wallet/pay/${opts.recipient}`);
  u.searchParams.set('asset', opts.asset);
  u.searchParams.set('network', opts.network);
  if (opts.amount != null) u.searchParams.set('amount', opts.amount);
  if (opts.label != null) u.searchParams.set('label', opts.label);
  return u.toString();
}

hermeticFlow();

hermeticDescribe('flow 221 — the EVM pay link: grammar, slugs, prefill promise, wrong-network refusal', () => {
  it('pins the canonical shape + slugs, prefills the send form (route disclosed, never signs), refuses ZCHF×Solana', async () => {
    // ---- 1+2. the canonical link shapes — one per settlement chain, slugs from the registry. --
    const merchant = deriveEvmKeypair('11'.repeat(32));
    const local = 'http://127.0.0.1:8787';
    const link = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: CHAIN_SLUGS[31337], amount: '12.50'});
    const parsed = new URL(link);
    expect(parsed.pathname).toBe(`/wallet/pay/${merchant.address}`); // the recipient IS the resource
    expect(parsed.searchParams.get('asset')).toBe('ZCHF');
    expect(parsed.searchParams.get('network')).toBe('anvil');
    expect(parsed.searchParams.get('amount')).toBe('12.50');
    expect(parsed.searchParams.get('ref')).toBeNull(); // no ref on EVM: the request path carries rid in evmreq:v1 (D18)
    for (const slug of Object.values(CHAIN_SLUGS)) {
      const u = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: slug});
      expect(new URL(u).searchParams.get('network')).toBe(slug);
      // The slug is also a REFUSAL gate: lowercase+hyphenated, so a hand-typed alias can never match.
      expect(slug).toBe(slug.toLowerCase().replace(/\s+/g, '-'));
    }

    // Size/shape bounds a shared link must survive: a label at the 32-byte cap stays a URL.
    const longLabel = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: 'anvil', amount: '1', label: 'x'.repeat(32)});
    expect(longLabel.length).toBeLessThanOrEqual(2000);

    // ---- 3+4. the app legs: the link PREFILLS the send form on the evm asset, never signs. ----
    const {accountOf, onboardWallet, waitForWallet} = await evmEnv();
    const m = await onboardWallet('jest-evm-221');
    const id = await accountOf(m);
    const payer = deriveEvmKeypair(id!.secretHex); // the sender address this wallet will send from
    expect(payer.address.startsWith('0x')).toBe(true);

    await waitForWallet(m);
    // The link — delivered through the app's own link pipeline (the OS-intent seam).
    const linkUrl = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: CHAIN_SLUGS[42161], amount: '12.50'});
    const deadline = budgetDeadline(15000); // positive transition (deep-link prefill landing) — budget-scaled
    (g.__DPAY_TEST_DEEPLINK as ((u: string) => void) | undefined)?.(linkUrl);
    await m.driver.findByTestID('evm-send-amount-input', {timeoutMs: 10000});
    for (;;) {
      const addr = m.driver.readInputValue('evm-send-address-input');
      const amt = m.driver.readInputValue('evm-send-amount-input');
      if (addr === merchant.address && amt === '12.50') break;
      if (Date.now() > deadline) throw new Error(`prefill never landed: address "${addr}" amount "${amt}"`);
      await new Promise((r) => setTimeout(r, 100));
    }
    // The ROUTE is disclosed before the amount commits: the status line names the settlement chain.
    await m.driver.findByTestID('evm-send-status', {timeoutMs: 5000});
    expect(m.driver.readText('evm-send-status')).toMatch(/Arbitrum/);
    // NEVER auto-signed: no send is in flight and no terminal exists.
    expect(m.driver.isPresent('evm-send-hash')).toBe(false);

    // The My-address chip (2026-10-04): the filled field hides it; clearing the field brings
    // it back and one tap fills THIS wallet's own EVM address for the EVM send.
    expect(m.driver.isPresent('evm-send-own-address')).toBe(false);
    await m.driver.type('evm-send-address-input', '', {timeoutMs: 5000});
    await m.driver.findByTestID('evm-send-own-address', {timeoutMs: 5000});
    await m.driver.click('evm-send-own-address', {timeoutMs: 5000});
    const chipDeadline = budgetDeadline(8000);
    for (;;) {
      if (m.driver.readInputValue('evm-send-address-input').toLowerCase() === payer.address.toLowerCase()) break;
      if (Date.now() > chipDeadline) throw new Error('the own-address chip never filled the EVM address');
      await new Promise((r) => setTimeout(r, 100));
    }

    // The refusal leg: ZCHF does not live on Solana — wrong_network names BOTH by name.
    const badLink = payLink({origin: local, recipient: merchant.address, asset: 'ZCHF', network: 'solana', amount: '12.50'});
    (g.__DPAY_TEST_DEEPLINK as (u: string) => void)(badLink);
    await m.driver.findByTestID('pay-link-error-body', {timeoutMs: 10000});
    const errTxt = m.driver.readText('pay-link-error-body');
    expect(errTxt).toMatch(/ZCHF/);
    expect(errTxt).toMatch(/Solana/);

    await m.unmount();
  }, 120_000);
});
