import {describe, it, expect} from '@jest/globals';
import {
  resolveNfcDisclosure,
  BUNDLED_NETWORKS,
  icpCatalogOf,
  type CurrencyDescriptor,
} from '../config/catalog';

// Catalog v2: the bundled fallback is network-first; derive the flat IC catalog through the same
// `icpCatalogOf` the app uses (one shape, one derivation).
const BUNDLED_CATALOG = icpCatalogOf(BUNDLED_NETWORKS);

// --- MC8 U1 — NFC asset disclosure resolver ---------------------------------------------------
// The blind-tap bug: NfcTap.autoSign fired `await signAuthorization` and only set the amount
// disclosure AFTER the await, so during signing the payer saw a generic "Communicating…" with NO
// asset name / amount / network. Worse, the post-sign amount line rendered `usd(amt)` (the DEMO
// formatter) even for ckBTC → a misleading "$0.00050000". The fix is a PURE resolver that returns
// the honest asset name + network + asset-correct amount BEFORE the first await, so React renders
// "Paying 0.00050000 BTC on Bitcoin" during the exchanging/awaitingApproval/settling window.
//
// `null` is the defense-in-depth decline: if a payable asset somehow can't resolve an honest
// name+network+amount, the caller (autoSign) declines the card and never signs.

// Shared fixture helper — fills the authoritative per-currency field set with null defaults.
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null, min_fraction_digits: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', liquidity: null, ramp_partner: null, testnet: false, ...d,
});
const CKBTC_DESC: CurrencyDescriptor = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKUSDC_DESC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, min_fraction_digits: null, fee: '10000', chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Unavailable'});
const KNOWN_CATALOG: CurrencyDescriptor[] = [CKBTC_DESC, CKUSDC_DESC];

describe('resolveNfcDisclosure — ckBTC (currency 1) honest disclosure', () => {
  it('returns {BTC, Bitcoin, "0.00050000 BTC"} for a 50000-sat request', () => {
    const d = resolveNfcDisclosure(KNOWN_CATALOG, {currency: 1, amount: '50000'});
    expect(d).not.toBeNull();
    expect(d!.assetName).toBe('BTC');
    expect(d!.networkLabel).toBe('Bitcoin');
    expect(d!.formattedAmount).toBe('0.00050000 BTC');
  });

  it('NEVER returns a DEMO/∂ formatted amount for ckBTC (the blind-tap bug)', () => {
    const d = resolveNfcDisclosure(KNOWN_CATALOG, {currency: 1, amount: '50000'});
    expect(d!.formattedAmount).not.toMatch(/^∂/);
    expect(d!.formattedAmount).not.toMatch(/^\$/);
  });
});

describe('resolveNfcDisclosure — ckUSDC (currency 2) honest disclosure', () => {
  it('returns {USDC, Ethereum, "1.000000 USDC"} for a 1000000-raw request', () => {
    const d = resolveNfcDisclosure(KNOWN_CATALOG, {currency: 2, amount: '1000000'});
    expect(d).not.toBeNull();
    expect(d!.assetName).toBe('USDC');
    expect(d!.networkLabel).toBe('Ethereum');
    expect(d!.formattedAmount).toBe('1.000000 USDC');
  });
});

describe('resolveNfcDisclosure — DEMO (currency 0) internal play money', () => {
  it('returns {DEMO, null network, "∂50.00"} — DEMO has no external network to disclose', () => {
    const d = resolveNfcDisclosure(KNOWN_CATALOG, {currency: 0, amount: '5000'});
    expect(d).not.toBeNull();
    expect(d!.assetName).toBe('DEMO');
    expect(d!.networkLabel).toBeNull();
    expect(d!.formattedAmount).toBe('∂50.00');
  });

  it('DEMO resolves even against an empty catalog (always payable, amount always formattable)', () => {
    const d = resolveNfcDisclosure([], {currency: 0, amount: '10000'});
    expect(d).not.toBeNull();
    expect(d!.assetName).toBe('DEMO');
    expect(d!.formattedAmount).toBe('∂100.00');
  });
});

describe('resolveNfcDisclosure — defense-in-depth: null when an honest disclosure is impossible', () => {
  it('returns null for a currency missing from the catalog (unknown id)', () => {
    expect(resolveNfcDisclosure(KNOWN_CATALOG, {currency: 999, amount: '50000'})).toBeNull();
  });

  it('returns null for a payable CkBtcUtxo whose decimals cannot be resolved (cannot format honestly)', () => {
    // A payable asset (familyDisplay non-null ⇒ isPayableAsset true) but with no decimals ⇒ the
    // amount cannot be formatted honestly → decline rather than blind-sign a garbage amount.
    const noDecimals: CurrencyDescriptor = mk({
      currency: 7, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿',
      // decimals/display_decimals intentionally null → fmtCurrencyAmount yields 'Unsupported'
    });
    expect(resolveNfcDisclosure([noDecimals], {currency: 7, amount: '50000'})).toBeNull();
  });

  it('returns null for a non-DEMO currency whose network cannot be resolved', () => {
    // A CkBtcUtxo descriptor with no backing_symbol AND a corrupted family config would still have
    // the family-default network, so construct the no-network edge directly: an unknown family with
    // no network + no usable name resolves neither name nor network → null.
    const unknown: CurrencyDescriptor = mk({currency: 8, minter: 'x', minter_family: 'CkSol', symbol: '?', decimals: 9});
    expect(resolveNfcDisclosure([unknown], {currency: 8, amount: '1000'})).toBeNull();
  });
});

describe('resolveNfcDisclosure — BUNDLED_CATALOG real values', () => {
  it('ckBTC in the bundled catalog resolves exactly', () => {
    const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 1, amount: '50000'});
    expect(d).toEqual({assetName: 'BTC', networkLabel: 'Bitcoin', formattedAmount: '0.00050000 BTC'});
  });
  it('ckUSDC in the bundled catalog resolves exactly', () => {
    const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 2, amount: '1000000'});
    expect(d).toEqual({assetName: 'USDC', networkLabel: 'Ethereum', formattedAmount: '1.000000 USDC'});
  });
  it('DEMO in the bundled catalog resolves exactly', () => {
    const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 0, amount: '5000'});
    expect(d).toEqual({assetName: 'DEMO', networkLabel: null, formattedAmount: '∂50.00'});
  });
  it('VCHF (7) in the bundled catalog resolves exactly', () => {
    // The no-minter direct-ICRC row: honest VCHF name, "Internet Computer" network, 8-dec amount.
    const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 7, amount: '50000'});
    expect(d).toEqual({assetName: 'VCHF', networkLabel: 'Internet Computer', formattedAmount: '0.00050000 VCHF'});
  });
  it('ICP (8) in the bundled catalog resolves exactly', () => {
    const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 8, amount: '10000'});
    expect(d).toEqual({assetName: 'ICP', networkLabel: 'Internet Computer', formattedAmount: '0.00010000 ICP'});
  });
});

// --- VCHF/ICP (2026-08-28): direct-ICRC disclosure honesty -------------------------------------
// The payer's tap window must read the EXACT asset + network + asset-correct amount — never a DEMO
// formatter, and never a Bitcoin/Ethereum network borrowed from a ck sibling. And a no-minter row
// that cannot disclose honestly is DECLINED (null), exactly like the family rows above.
describe('resolveNfcDisclosure — VCHF (7) / ICP (8) direct-ICRC honesty', () => {
  it('NEVER returns a DEMO/∂/$ formatted amount for VCHF or ICP', () => {
    for (const currency of [7, 8]) {
      const d = resolveNfcDisclosure(BUNDLED_CATALOG, {currency, amount: '50000'})!;
      expect(d.formattedAmount).not.toMatch(/^∂/);
      expect(d.formattedAmount).not.toMatch(/^\$/);
    }
  });
  it('the network label distinguishes the IC rows honestly (Internet Computer, not Bitcoin/Ethereum)', () => {
    const vchf = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 7, amount: '50000'})!;
    const btc = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 1, amount: '50000'})!;
    const usdc = resolveNfcDisclosure(BUNDLED_CATALOG, {currency: 2, amount: '1000000'})!;
    expect(vchf.networkLabel).toBe('Internet Computer');
    expect(vchf.networkLabel).not.toBe(btc.networkLabel);   // ≠ Bitcoin
    expect(vchf.networkLabel).not.toBe(usdc.networkLabel);  // ≠ Ethereum
  });
  it('returns null for an incomplete no-minter row whose amount cannot be formatted honestly', () => {
    // Same VCHF identity but NO decimals: displayName + network resolve, but fmtCurrencyAmount
    // yields 'Unsupported' → decline rather than blind-sign a garbage amount (defense-in-depth
    // extends to the direct-ICRC rows — payable-ness alone never licenses a blind tap).
    const noDecimals: CurrencyDescriptor = mk({
      currency: 7, minter_family: null, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', symbol: 'VCHF',
      wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer',
      // decimals intentionally null ⇒ fmtCurrencyAmount yields 'Unsupported'
    });
    expect(resolveNfcDisclosure([noDecimals], {currency: 7, amount: '50000'})).toBeNull();
  });
});
