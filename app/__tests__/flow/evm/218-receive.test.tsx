/**
 * Flow 218 evm-receive — the jest twin of `e2e/tests/218-evm-receive.mjs` (batch D port), the
 * achievable-subset port over the fake-relay catalog. The device-derived EVM address (D28/D14):
 * the SAME Identity.secretHex that derives the IC + Solana keys derives the EVM key at
 * m/44'/60'/0'/0/0, and the wallet renders that EIP-55-checksummed address everywhere.
 *
 * Ported here: the onboard identity's secretHex derives EXACTLY the address the UI renders —
 * Receive ▸ My address renders it, the QR payload is the BARE checksummed address (D14), the copy
 * affordance exists, the explorer link reflects the chain registry (Arbitrum One → arbiscan), and
 * the address surface renders with the connectivity oracle pinned OFFLINE (pure derivation, zero
 * RPC in the render path — D14's discipline).
 *
 * NOT ported (needs the anvil chain — they move to the `just node-anvil` recipe with flows
 * 219/220/222): the fund-through-pipe staging leg and the Anvil explorer-null row; the SLIP-10
 * official vectors stay pinned in `app/__tests__/evm-identity.test.ts` + `eip55.test.ts` and are
 * cross-checked here through the app's own derivation only.
 */
import {describe, it, expect} from '@jest/globals';
import {evmEnv} from './env';
import {deriveEvmKeypair} from '../../../evm/identity';
import {toChecksumAddress} from '../../../evm/identity';

const g = globalThis as unknown as Record<string, unknown>;

describe('flow 218 — the onboard identity derives the EIP-55 address the wallet renders', () => {
  it('Balances row → Receive ▸ My address: rendered == derived, bare-address QR, copy, explorer per registry', async () => {
    const {accountOf, onboardWallet, selectEvmAsset, waitForWallet} = await evmEnv();
    const m = await onboardWallet('jest-evm-218');
    const id = await accountOf(m);
    expect(id?.secretHex ?? '').toHaveLength(64); // the app identity carries a 64-hex seed

    // The device EVM key: m/44'/60'/0'/0/0 over the identity's own seed (the app's own derivation).
    const device = deriveEvmKeypair(id!.secretHex);
    // The identity returns the lowercase form; the UI renders it EIP-55-checksummed.
    const checksummed = toChecksumAddress(device.address);
    expect(checksummed.toLowerCase()).toBe(device.address);

    // The EVM rail: select the catalog's ZCHF-on-Arbitrum row (a MAINNET section the relay always
    // serves — no testnet toggle, no RPC; the balance row degrades honestly with the rail off).
    await waitForWallet(m);
    await selectEvmAsset(m, 'evm-zchf-arbitrum');

    // Receive ▸ My address: the rendered address IS the derivation, EIP-55 spelled.
    await m.driver.click('tab-receive', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('evm-recv-address', {timeoutMs: 5000});
    const rendered = m.driver.readText('evm-recv-address').trim();
    expect(rendered).toBe(checksummed);

    // The QR payload is the BARE checksummed address (no URI scheme, no EIP-681).
    expect(g.__DPAY_QR_LAST).toBe(checksummed);

    // Copy affordance exists; the explorer link reflects the chain registry (Arbitrum One).
    await m.driver.findByTestID('btn-evm-recv-copy', {timeoutMs: 3000});
    await m.driver.findByTestID('evm-recv-explorer', {timeoutMs: 3000});
    expect(m.driver.readText('evm-recv-explorer')).toContain('Arbitrum');

    // Zero-RPC-at-render: pin the connectivity oracle OFFLINE, flip the sub-mode away and back —
    // the address surface re-renders identically (pure derivation).
    g.__DPAY_TEST_EVM_CONNECTIVITY = 'offline';
    await m.driver.click('btn-receive-request', {timeoutMs: 5000});
    await m.driver.click('btn-receive-address', {timeoutMs: 5000});
    await m.driver.findByTestID('evm-recv-address', {timeoutMs: 5000});
    expect(m.driver.readText('evm-recv-address').trim()).toBe(checksummed);
    delete g.__DPAY_TEST_EVM_CONNECTIVITY;

    await m.unmount();
  }, 120_000);
});
