/**
 * trustwallet.ts — golden deep links + eligibility (2026-08-17 "Trust Wallet fund button").
 *
 * Pins, byte-exact, the ONLY thing that leaves the app on this path: the send URL Trust's
 * docs define (https://link.trustwallet.com/send?asset=<UAI>&address=<addr>). The UAIs come
 * from the wallet-core registry (research 2026-08-17 — no testnet ids exist), and the
 * SOL-USDC id embeds the app's single mainnet USDC mint source (spl.ts) — asserted here so a
 * mint change can't silently desync the deep link.
 *
 * Also pins the IC-rail eligibility predicate: mainnet CkBtcUtxo ONLY (testnet ckBTC and the
 * whole CkEthErc20 family stay off the Trust path — WC owns calldata; testnet has no UAI).
 */
import {describe, test, expect} from '@jest/globals';
import {trustWalletSendUrl, isTrustWalletFundableBtc} from '../trustwallet';
import {BUNDLED_NETWORKS, icpCatalogOf, type CurrencyDescriptor} from '../config/catalog';
import {USDC_MINT_ADDRESS} from '../solana/spl';

// Catalog v2: the bundled fallback is network-first; derive the flat IC catalog through the same
// `icpCatalogOf` the app uses.
const BUNDLED_CATALOG = icpCatalogOf(BUNDLED_NETWORKS);

const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const SOL_ADDR = 'Ecs89dz8NsNoSxyUtp54G2HPbmvJr8qZnxnWUqiLT92r';

describe('trustWalletSendUrl — golden URLs', () => {
  test('BTC → coin id c0 (mainnet Bitcoin)', () => {
    expect(trustWalletSendUrl('BTC', BTC_ADDR))
      .toBe(`https://link.trustwallet.com/send?asset=c0&address=${BTC_ADDR}`);
  });

  test('SOL → coin id c501 (mainnet Solana)', () => {
    expect(trustWalletSendUrl('SOL', SOL_ADDR))
      .toBe(`https://link.trustwallet.com/send?asset=c501&address=${SOL_ADDR}`);
  });

  test('SOL-USDC → SPL asset id c501_t<mint>, mint sourced from spl.ts (single source)', () => {
    expect(trustWalletSendUrl('SOL-USDC', SOL_ADDR))
      .toBe(`https://link.trustwallet.com/send?asset=c501_t${USDC_MINT_ADDRESS}&address=${SOL_ADDR}`);
  });

  test('address is encodeURIComponent-escaped (defensive — real base58/btc chars are unreserved)', () => {
    expect(trustWalletSendUrl('SOL', 'a b+c'))
      .toBe('https://link.trustwallet.com/send?asset=c501&address=a%20b%2Bc');
  });

  test('NO amount param — dpay never quotes or implies conversion (no-swap)', () => {
    const url = trustWalletSendUrl('BTC', BTC_ADDR);
    expect(url).not.toContain('amount=');
    expect(url).not.toContain('memo=');
    expect(url).not.toContain('data=');
  });

  test('https form, never the trust:// scheme (absent app must self-heal to a landing)', () => {
    expect(trustWalletSendUrl('SOL', SOL_ADDR).startsWith('https://link.trustwallet.com/')).toBe(true);
  });
});

describe('isTrustWalletFundableBtc — IC-rail eligibility (fail-closed)', () => {
  const mainnetBtc = BUNDLED_CATALOG.find(c => c.currency === 1)!;

  test('mainnet ckBTC (CkBtcUtxo, network Bitcoin) → eligible', () => {
    expect(isTrustWalletFundableBtc(mainnetBtc)).toBe(true);
  });

  test('testnet ckBTC (same family, non-mainnet network) → NOT eligible (no Trust UAI exists)', () => {
    // Catalog v2: testnet-ness is the server-declared `testnet` flag (was inferred from `network`).
    const testnet: CurrencyDescriptor = {...mainnetBtc, currency: 3, network: 'Bitcoin Testnet', testnet: true};
    expect(isTrustWalletFundableBtc(testnet)).toBe(false);
  });

  test('CkEthErc20 (ckUSDC) → NOT eligible (calldata needs the WalletConnect path)', () => {
    const ckusdc = BUNDLED_CATALOG.find(c => c.minter_family === 'CkEthErc20')!;
    expect(isTrustWalletFundableBtc(ckusdc)).toBe(false);
  });

  test('null descriptor (asset missing from catalog) → NOT eligible', () => {
    expect(isTrustWalletFundableBtc(null)).toBe(false);
  });
});
