import {describe, it, expect} from '@jest/globals';
import {detectAddressShape, routeForShape, isNativeIcpLedger, chainNameOfShape} from '../lib/destination';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';
import type {CurrencyDescriptor} from '../config/catalog';

// The send-to-address routing policy. `detectAddressShape` decides WHICH address namespace a
// pasted/scanned string belongs to; `routeForShape` decides which rail (if any) moves the selected
// asset there. Both are pure, so every branch is exercised here without the native core.
//
// Addresses below are REAL, not invented: the Oisy VCHF principal is the founder's own (the one
// that motivated this feature), the account identifier is the spec principal k2t6j-…-6ae's, and the
// BTC/ETH ones are the shapes the existing withdraw validator already accepts.

const OISY_VCHF = '3nrdb-dxqqw-mc4gr-fbwxc-ynsdh-2e72e-urieh-mx52v-moiye-hff4l-4qe';
const K2 = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
const K2_ACCOUNT_ID = '051b05839339f89053454a4b9865ea0452a4bffe2b1cd41f4982bad10c1e637c';
const ETH_ADDR = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BTC_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const BTC_LEGACY = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
const SOL_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

// Catalog v2: the flat IC catalog every consumer sees is derived from the network-first bundled
// fallback (same derivation the app itself uses), so these are the REAL shipped descriptors.
const BUNDLED_CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);
const byId = (id: number): CurrencyDescriptor => BUNDLED_CATALOG.find(c => c.currency === id)!;
const DEMO = byId(0), CKBTC = byId(1), CKUSDC = byId(2), CKETH = byId(6), VCHF = byId(7), ICP = byId(8);

describe('detectAddressShape', () => {
  it('recognises an IC account — bare principal and the ICRC-1 subaccount form', () => {
    expect(detectAddressShape(OISY_VCHF)).toBe('ic-account');
    expect(detectAddressShape(K2)).toBe('ic-account');
    expect(detectAddressShape(`${K2}-6cc627i.1`)).toBe('ic-account');
    // Short canister-style principals are the same namespace.
    expect(detectAddressShape('ryjl3-tyaaa-aaaaa-aaaba-cai')).toBe('ic-account');
    // Case-insensitive: an uppercased paste is still recognisably an IC account (the core
    // canonicalises it; shape detection must not send it down the "unknown" path first).
    expect(detectAddressShape(OISY_VCHF.toUpperCase())).toBe('ic-account');
  });

  it('recognises the 64-hex ICP account identifier, and not other hex lengths', () => {
    expect(detectAddressShape(K2_ACCOUNT_ID)).toBe('icp-account-id');
    expect(detectAddressShape(K2_ACCOUNT_ID.toUpperCase())).toBe('icp-account-id');
    // 63 or 65 hex chars is not the namespace — it must not be routed to the legacy path.
    expect(detectAddressShape(K2_ACCOUNT_ID.slice(0, 63))).not.toBe('icp-account-id');
    expect(detectAddressShape(`${K2_ACCOUNT_ID}a`)).not.toBe('icp-account-id');
  });

  it('recognises EVM, Bitcoin (bech32 + base58), and Solana addresses', () => {
    expect(detectAddressShape(ETH_ADDR)).toBe('evm');
    expect(detectAddressShape(BTC_BECH32)).toBe('btc');
    expect(detectAddressShape(BTC_LEGACY)).toBe('btc');
    expect(detectAddressShape(SOL_ADDR)).toBe('base58');
  });

  it('trims surrounding whitespace and reports empty/garbage as unknown', () => {
    expect(detectAddressShape(`  ${OISY_VCHF}\n`)).toBe('ic-account');
    expect(detectAddressShape('')).toBe('unknown');
    expect(detectAddressShape('   ')).toBe('unknown');
    expect(detectAddressShape('hello world')).toBe('unknown');
    expect(detectAddressShape('not an address!!')).toBe('unknown');
  });
});

describe('routeForShape — every IC asset can pay an IC account', () => {
  it.each([
    ['DEMO', DEMO], ['ckBTC', CKBTC], ['ckUSDC', CKUSDC], ['ckETH', CKETH], ['VCHF', VCHF], ['ICP', ICP],
  ])('%s routes an IC account to the icrc1_transfer rail', (_name, desc) => {
    expect(routeForShape('ic-account', desc)).toEqual({ok: true, route: {kind: 'icrc'}});
  });
});

describe('routeForShape — native-chain addresses route to their own minter only', () => {
  it('an EVM address routes to the ckETH/ckERC20 minter burn', () => {
    expect(routeForShape('evm', CKUSDC)).toEqual({ok: true, route: {kind: 'native', family: 'CkEthErc20'}});
    expect(routeForShape('evm', CKETH)).toEqual({ok: true, route: {kind: 'native', family: 'CkEthErc20'}});
  });

  it('a Bitcoin address routes to the ckBTC minter burn', () => {
    expect(routeForShape('btc', CKBTC)).toEqual({ok: true, route: {kind: 'native', family: 'CkBtcUtxo'}});
  });

  it('refuses a native address whose chain the selected asset does not settle on', () => {
    // The dangerous paste: a real Ethereum address while ckBTC is selected.
    expect(routeForShape('evm', CKBTC)).toEqual({ok: false, refusal: {reason: 'wrong-chain', shape: 'evm'}});
    expect(routeForShape('btc', CKUSDC)).toEqual({ok: false, refusal: {reason: 'wrong-chain', shape: 'btc'}});
    // VCHF/ICP have no native chain at all — every native address is wrong for them.
    expect(routeForShape('evm', VCHF)).toEqual({ok: false, refusal: {reason: 'wrong-chain', shape: 'evm'}});
    expect(routeForShape('btc', ICP)).toEqual({ok: false, refusal: {reason: 'wrong-chain', shape: 'btc'}});
    // A Solana address is always wrong on the IC rail — dpay never swaps across chains.
    expect(routeForShape('base58', ICP)).toEqual({ok: false, refusal: {reason: 'wrong-chain', shape: 'base58'}});
  });
});

describe('routeForShape — the legacy ICP account-identifier namespace', () => {
  it('routes a 64-hex destination to the legacy transfer for NATIVE ICP only', () => {
    expect(routeForShape('icp-account-id', ICP)).toEqual({ok: true, route: {kind: 'icp-legacy'}});
  });

  it('refuses a 64-hex destination for every other asset — only the ICP ledger has that method', () => {
    // This is the honest half of the founder-approved legacy support: the address form is real, but
    // a VCHF or ckBTC ledger has no `transfer` method to reach it with.
    for (const desc of [VCHF, CKBTC, CKUSDC, CKETH, DEMO]) {
      expect(routeForShape('icp-account-id', desc)).toEqual({ok: false, refusal: {reason: 'legacy-not-icp'}});
    }
  });
});

describe('routeForShape — fail-closed cases', () => {
  it('refuses an unrecognised string', () => {
    expect(routeForShape('unknown', ICP)).toEqual({ok: false, refusal: {reason: 'unrecognised'}});
  });

  it('refuses everything when no asset is selected (null/undefined descriptor)', () => {
    // Fail closed rather than assume a rail — a route chosen without an asset would sign against
    // the wrong ledger.
    expect(routeForShape('ic-account', null)).toEqual({ok: false, refusal: {reason: 'unrecognised'}});
    expect(routeForShape('icp-account-id', undefined)).toEqual({ok: false, refusal: {reason: 'unrecognised'}});
    expect(routeForShape('evm', null)).toEqual({ok: false, refusal: {reason: 'unrecognised'}});
  });
});

describe('isNativeIcpLedger', () => {
  it('is true for the ICP row alone, across the whole bundled catalog', () => {
    expect(isNativeIcpLedger(ICP)).toBe(true);
    for (const desc of [DEMO, CKBTC, CKUSDC, CKETH, VCHF]) {
      expect(isNativeIcpLedger(desc)).toBe(false);
    }
    expect(isNativeIcpLedger(null)).toBe(false);
    expect(isNativeIcpLedger(undefined)).toBe(false);
  });
});

describe('chainNameOfShape', () => {
  it('names the chain a shape belongs to, for the refusal copy', () => {
    expect(chainNameOfShape('evm')).toBe('Ethereum');
    expect(chainNameOfShape('btc')).toBe('Bitcoin');
    expect(chainNameOfShape('base58')).toBe('Solana');
    expect(chainNameOfShape('ic-account')).toBe('Internet Computer');
    expect(chainNameOfShape('icp-account-id')).toBe('Internet Computer');
    expect(chainNameOfShape('unknown')).toBeNull();
  });
});

describe('end-to-end shape→route for the addresses that motivated this feature', () => {
  it("the founder's Oisy VCHF address sends VCHF over the ICRC-1 rail", () => {
    expect(routeForShape(detectAddressShape(OISY_VCHF), VCHF)).toEqual({ok: true, route: {kind: 'icrc'}});
  });

  it('the same Oisy address also sends ckBTC — an IC account is reachable from every IC asset', () => {
    // The point of the auto-routing: ckBTC to an IC wallet no longer requires a Bitcoin round trip.
    expect(routeForShape(detectAddressShape(OISY_VCHF), CKBTC)).toEqual({ok: true, route: {kind: 'icrc'}});
  });

  it('a Bitcoin address still sends ckBTC to the Bitcoin chain from the same field', () => {
    expect(routeForShape(detectAddressShape(BTC_BECH32), CKBTC)).toEqual({ok: true, route: {kind: 'native', family: 'CkBtcUtxo'}});
  });

  it('an exchange-style ICP address sends ICP over the legacy rail but refuses for VCHF', () => {
    expect(routeForShape(detectAddressShape(K2_ACCOUNT_ID), ICP)).toEqual({ok: true, route: {kind: 'icp-legacy'}});
    expect(routeForShape(detectAddressShape(K2_ACCOUNT_ID), VCHF)).toEqual({ok: false, refusal: {reason: 'legacy-not-icp'}});
  });
});
