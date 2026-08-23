import {describe, it, expect} from '@jest/globals';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  isValidDestinationAddress,
  familyDisplay,
  displayName,
  currencySymbol,
  fmtCurrencyAmount,
  assetTestKey,
  isPayableAsset,
  isTestnetCurrency,
  testnetDisplayName,
  catalogCacheKey,
  BUNDLED_CATALOG,
  type CurrencyDescriptor,
} from '../config/catalog';
import {MINT_HEX} from '../lib/format';

// --- shared fixtures --------------------------------------------------------------------------
// MC1 unit 5: fixtures carry the full authoritative per-currency field set. `mk` fills the new
// fields with null defaults so each test only spells out what it asserts.
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', ...d,
});
const CKBTC_DESC: CurrencyDescriptor = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKUSDC_DESC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, fee: '10000', chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', gas_ledger: 'ss2fx-dyaaa-aaaar-qacoq-cai', onramp: 'Direct', offramp: 'Direct'});
const CKSOL_DESC: CurrencyDescriptor = mk({currency: 99, minter: 'x', minter_family: 'CkSol', symbol: 'SOL', decimals: 9});
const DEMO_DESC: CurrencyDescriptor = mk({currency: 0, mintable: true, minter_family: null, symbol: '$', decimals: 2, onramp: 'Direct', offramp: 'Unavailable'});
const KNOWN_CATALOG: CurrencyDescriptor[] = [DEMO_DESC, CKBTC_DESC, CKUSDC_DESC];
const UNKNOWN_CATALOG: CurrencyDescriptor[] = [CKSOL_DESC];

describe('isValidDestinationAddress', () => {
  describe('CkBtcUtxo (Bitcoin)', () => {
    const family = 'CkBtcUtxo';
    it('accepts a bech32 SegWit address', () => {
      expect(isValidDestinationAddress(family, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true);
    });
    it('accepts a bech32m Taproot address', () => {
      expect(isValidDestinationAddress(family, 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwud3qrvyhzg')).toBe(true);
    });
    it('accepts a P2PKH address', () => {
      expect(isValidDestinationAddress(family, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(true);
    });
    it('accepts a P2SH address', () => {
      expect(isValidDestinationAddress(family, '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe(true);
    });
    it('rejects an Ethereum address (wrong chain)', () => {
      expect(isValidDestinationAddress(family, '0x1234567890abcdef1234567890abcdef12345678')).toBe(false);
    });
    it('rejects garbage', () => {
      expect(isValidDestinationAddress(family, 'not-an-address')).toBe(false);
    });
    it('rejects empty', () => {
      expect(isValidDestinationAddress(family, '')).toBe(false);
    });
    it('rejects whitespace', () => {
      expect(isValidDestinationAddress(family, '   ')).toBe(false);
    });
  });

  describe('CkEthErc20 (Ethereum)', () => {
    const family = 'CkEthErc20';
    it('accepts a valid 0x hex address', () => {
      expect(isValidDestinationAddress(family, '0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
    });
    it('rejects a Bitcoin address (wrong chain)', () => {
      expect(isValidDestinationAddress(family, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false);
    });
    it('rejects too short', () => {
      expect(isValidDestinationAddress(family, '0x1234')).toBe(false);
    });
    it('rejects without 0x prefix', () => {
      expect(isValidDestinationAddress(family, '1234567890abcdef1234567890abcdef12345678')).toBe(false);
    });
  });
});

// --- MC1 unit 6: fail-closed for unknown asset families (no Bitcoin fallback) -----------------
// The most dangerous silent bug in the multi-currency path: an unknown `MinterFamily` (e.g. CkSol)
// or a no-minter ICRC currency silently rendered with the Bitcoin (CkBtcUtxo) display config — so a
// SOL/unknown asset looked like BTC. Per CLAUDE.md dpay NEVER swaps, so a wrong-currency render is a
// non-custodial-trust violation, not a cosmetic glitch. The fix: familyDisplay returns null for an
// unknown family, and every display helper returns an explicit "Unsupported"/"?" sentinel. Known
// families (CkBtcUtxo, CkEthErc20) and the DEMO currency (0) keep their EXACT labels.
describe('familyDisplay — fail-closed for unknown families', () => {
  it('returns the ckBTC config for a CkBtcUtxo currency (unchanged)', () => {
    const d = familyDisplay(KNOWN_CATALOG, 1);
    expect(d).not.toBeNull();
    expect(d?.nativeAsset).toBe('BTC');
    expect(d?.networkLabel).toBe('Bitcoin');
  });
  it('returns the ckERC20 config for a CkEthErc20 currency (unchanged)', () => {
    const d = familyDisplay(KNOWN_CATALOG, 2);
    expect(d).not.toBeNull();
    expect(d?.nativeAsset).toBe('USDC');
    expect(d?.networkLabel).toBe('Ethereum');
  });
  it('returns NULL for a CkSol (unknown) family — never the Bitcoin config', () => {
    expect(familyDisplay(UNKNOWN_CATALOG, 99)).toBeNull();
  });
  it('returns NULL for a currency missing from the catalog (never the Bitcoin config)', () => {
    expect(familyDisplay(KNOWN_CATALOG, 999)).toBeNull();
  });
  it('returns NULL for a non-DEMO currency with minter_family null (unknown ICRC)', () => {
    const noMinter: CurrencyDescriptor[] = [
      mk({currency: 7, minter_family: null}),
    ];
    expect(familyDisplay(noMinter, 7)).toBeNull();
  });
});

// CRITICAL regression guard: the DEMO currency (0) has minter_family null, so familyDisplay returns
// null for it too — BUT its display never depended on familyDisplay's BTC fallback. These prove the
// DEMO display path is independent of the family config (early-returns in each helper).
describe('DEMO (currency 0) display never depended on the Bitcoin fallback', () => {
  it('familyDisplay(DEMO) is null (no family) — but DEMO is NOT unsupported', () => {
    expect(familyDisplay(KNOWN_CATALOG, 0)).toBeNull();
  });
  it('displayName(DEMO) === "DEMO"', () => {
    expect(displayName(DEMO_DESC)).toBe('DEMO');
  });
  it('currencySymbol(DEMO) === "∂"', () => {
    expect(currencySymbol(KNOWN_CATALOG, 0)).toBe('∂');
  });
  it('fmtCurrencyAmount(DEMO, 5000) === "Đ50.00" (not BTC, not $)', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 0, '5000')).toBe('Đ50.00');
  });
});

describe('fmtCurrencyAmount — explicit "Unsupported" sentinel for unknown families', () => {
  it('returns "Unsupported" for a CkSol amount (never "0.000001000 BTC")', () => {
    const s = fmtCurrencyAmount(UNKNOWN_CATALOG, 99, '1000');
    expect(s).toBe('Unsupported');
    expect(s).not.toMatch(/BTC/);
    expect(s).not.toMatch(/^\$/);
  });
  it('returns "Unsupported" even when a decimals value is present (family is the gate, not decimals)', () => {
    // CkSol carries decimals:9 in the catalog, but it's still an unknown FAMILY → fail closed.
    expect(fmtCurrencyAmount(UNKNOWN_CATALOG, 99, '123456789')).toBe('Unsupported');
  });
  it('formats ckBTC exactly (unchanged): 50000 sats → "0.00050000 BTC"', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 1, '50000')).toBe('0.00050000 BTC');
  });
  it('formats ckUSDC exactly (unchanged): 1000000 → "1.000000 USDC"', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 2, '1000000')).toBe('1.000000 USDC');
  });
});

describe('displayName — no BTC fallback for unknown families', () => {
  it('returns "BTC" for CkBtcUtxo (unchanged)', () => {
    expect(displayName(CKBTC_DESC)).toBe('BTC');
  });
  it('returns "USDC" for CkEthErc20 (unchanged)', () => {
    expect(displayName(CKUSDC_DESC)).toBe('USDC');
  });
  it('returns the name-like symbol for an unknown family that carries one', () => {
    expect(displayName(CKSOL_DESC)).toBe('SOL');
  });
  it('returns "Unsupported" for an unknown family with no usable symbol (never "BTC")', () => {
    const noSym: CurrencyDescriptor = {...CKSOL_DESC, symbol: null};
    expect(displayName(noSym)).toBe('Unsupported');
  });
});

describe('currencySymbol — no BTC glyph fallback for unknown families', () => {
  it('returns "₿" for CkBtcUtxo (unchanged)', () => {
    expect(currencySymbol(KNOWN_CATALOG, 1)).toBe('₿');
  });
  it('returns "$" for CkEthErc20 (unchanged)', () => {
    expect(currencySymbol(KNOWN_CATALOG, 2)).toBe('$');
  });
  it('returns "?" for an unknown family whose symbol is too long for a glyph (never "₿")', () => {
    // SOL is length 3 (> 2), so it is not a usable prefix glyph → explicit "?"
    expect(currencySymbol(UNKNOWN_CATALOG, 99)).toBe('?');
  });
  it('returns the short symbol when an unknown family carries a single-char glyph', () => {
    const sol: CurrencyDescriptor = {...CKSOL_DESC, symbol: '◎'};
    expect(currencySymbol([sol], 99)).toBe('◎');
  });
});

describe('assetTestKey — no BTC fallback for unknown families', () => {
  it('returns "ckbtc" for a CkBtcUtxo asset (unchanged, honors the e2e testID contract)', () => {
    expect(assetTestKey(CKBTC_DESC)).toBe('ckbtc');
  });
  it('returns "ckusdc" for a CkEthErc20 asset (unchanged)', () => {
    expect(assetTestKey(CKUSDC_DESC)).toBe('ckusdc');
  });
  it('returns a non-BTC key for an unknown family that carries a symbol', () => {
    expect(assetTestKey(CKSOL_DESC)).toBe('sol');
    expect(assetTestKey(CKSOL_DESC)).not.toBe('btc');
  });
  it('returns "asset" for an unknown family with no symbol (never "btc")', () => {
    const noSym: CurrencyDescriptor = {...CKSOL_DESC, symbol: null};
    expect(assetTestKey(noSym)).toBe('asset');
  });
});

// --- testnet detection + labelling (single source of truth) -----------------------------------
// The production relay serves mainnet AND testnet chain-key currencies side-by-side: mainnet ckBTC
// (network "Bitcoin") next to ckTESTBTC (network "Bitcoin Testnet"), mainnet ckUSDC (network
// "Ethereum") next to ckSepoliaUSDC (network "Sepolia"). `displayName` returns the backing_symbol
// first, so WITHOUT testnet-aware labelling the two BTC rows render as indistinguishable "BTC"
// duplicates. These pin the three load-bearing invariants:
//   1. isTestnetCurrency: a currency is testnet iff it has a network NOT in {Bitcoin, Ethereum}.
//      DEMO (network null) + SOL (not in catalog) are unaffected.
//   2. testnetDisplayName: "<backing_symbol> testnet" → "BTC testnet" / "USDC testnet" / "ETH testnet".
//   3. assetTestKey: a testnet currency's key gets a `-testnet` suffix so two rows sharing a backing
//      symbol (ckBTC + ckTESTBTC) get DISTINCT testIDs (the e2e net matches testID literally). Mainnet
//      keys are UNCHANGED (the e2e testID contract for currencies 0/1/2 is preserved).
const CKTESTBTC_DESC: CurrencyDescriptor = mk({currency: 3, minter: 'mt', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKSEPOLIA_USDC_DESC: CurrencyDescriptor = mk({currency: 4, minter: 'ms', minter_family: 'CkEthErc20', symbol: 'ckSepoliaUSDC', decimals: 6, wrapper_name: 'ckSepoliaUSDC', backing_symbol: 'USDC', network: 'Sepolia', display_decimals: 6, chain_id: 11155111, token_contract: '0x...', onramp: 'Direct', offramp: 'Direct'});
const CKSEPOLIA_ETH_DESC: CurrencyDescriptor = mk({currency: 5, minter: 'me', minter_family: 'CkEthErc20', symbol: 'ckSepoliaETH', decimals: 18, wrapper_name: 'ckSepoliaETH', backing_symbol: 'ETH', network: 'Sepolia', display_decimals: 18, token_contract: null, onramp: 'Direct', offramp: 'Direct'});

describe('isTestnetCurrency — a network NOT in {Bitcoin, Ethereum} is testnet', () => {
  it('mainnet ckBTC (network "Bitcoin") is NOT testnet', () => {
    expect(isTestnetCurrency(CKBTC_DESC)).toBe(false);
  });
  it('mainnet ckUSDC (network "Ethereum") is NOT testnet', () => {
    expect(isTestnetCurrency(CKUSDC_DESC)).toBe(false);
  });
  it('DEMO (network null) is NOT testnet (null network ⇒ not testnet)', () => {
    expect(isTestnetCurrency(DEMO_DESC)).toBe(false);
  });
  it('ckTESTBTC (network "Bitcoin Testnet") IS testnet', () => {
    expect(isTestnetCurrency(CKTESTBTC_DESC)).toBe(true);
  });
  it('ckSepoliaUSDC (network "Sepolia") IS testnet', () => {
    expect(isTestnetCurrency(CKSEPOLIA_USDC_DESC)).toBe(true);
  });
  it('ckSepoliaETH (network "Sepolia") IS testnet', () => {
    expect(isTestnetCurrency(CKSEPOLIA_ETH_DESC)).toBe(true);
  });
});

describe('testnetDisplayName — "<backing_symbol> testnet" (never the bare duplicate)', () => {
  it('ckTESTBTC → "BTC testnet" (NOT "BTC" — the indistinguishable mainnet duplicate)', () => {
    expect(testnetDisplayName(CKTESTBTC_DESC)).toBe('BTC testnet');
    expect(testnetDisplayName(CKTESTBTC_DESC)).not.toBe('BTC');
  });
  it('ckSepoliaUSDC → "USDC testnet"', () => {
    expect(testnetDisplayName(CKSEPOLIA_USDC_DESC)).toBe('USDC testnet');
  });
  it('ckSepoliaETH → "ETH testnet"', () => {
    expect(testnetDisplayName(CKSEPOLIA_ETH_DESC)).toBe('ETH testnet');
  });
  it('falls back to the wrapper name when backing_symbol is absent', () => {
    const noBacking: CurrencyDescriptor = {...CKTESTBTC_DESC, backing_symbol: null};
    expect(testnetDisplayName(noBacking)).toBe('ckTESTBTC testnet');
  });
  it('falls back to "Testnet" when both backing_symbol + wrapper_name are absent', () => {
    const bare: CurrencyDescriptor = mk({currency: 9, minter_family: 'CkBtcUtxo', network: 'Bitcoin Testnet'});
    expect(testnetDisplayName(bare)).toBe('Testnet');
  });
});

describe('assetTestKey — testnet currencies get a "-testnet" suffix (unique testIDs)', () => {
  it('mainnet ckBTC keeps "ckbtc" (e2e testID contract UNCHANGED)', () => {
    expect(assetTestKey(CKBTC_DESC)).toBe('ckbtc');
  });
  it('ckTESTBTC (CkBtcUtxo + testnet) → "ckbtc-testnet" — DISTINCT from mainnet ckBTC', () => {
    // The collision this prevents: both ckBTC + ckTESTBTC are CkBtcUtxo → both would map to "ckbtc"
    // → `asset-ckbtc` + `asset-add-ckbtc` would match TWO rows in the e2e net. The suffix keeps them
    // distinct while leaving the mainnet key byte-for-byte unchanged.
    expect(assetTestKey(CKTESTBTC_DESC)).toBe('ckbtc-testnet');
    expect(assetTestKey(CKTESTBTC_DESC)).not.toBe('ckbtc');
  });
  it('ckSepoliaUSDC → "cksepoliausdc-testnet" — distinct from a mainnet ckUSDC', () => {
    expect(assetTestKey(CKSEPOLIA_USDC_DESC)).toBe('cksepoliausdc-testnet');
  });
  it('ckSepoliaETH (CkEthErc20 native ETH + testnet) → "cksepoliaeth-testnet"', () => {
    expect(assetTestKey(CKSEPOLIA_ETH_DESC)).toBe('cksepoliaeth-testnet');
  });
  it('a mainnet asset stays UNSUFFIXED (only the testnet sibling gets the -testnet suffix)', () => {
    // Belt-and-suspenders: the mainnet key is the unsuffixed base; only the testnet sibling suffixes.
    // A CkBtcUtxo-family mainnet currency always maps to the e2e-contracted "ckbtc" (the early
    // return), so it is NEVER confused with "ckbtc-testnet".
    const mainnetBtcClone: CurrencyDescriptor = mk({currency: 6, minter_family: 'CkBtcUtxo', wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin'});
    expect(isTestnetCurrency(mainnetBtcClone)).toBe(false);
    expect(assetTestKey(mainnetBtcClone)).toBe('ckbtc');
    // A CkEthErc20 mainnet currency keeps its wrapper-name key unsuffixed too.
    const mainnetErcClone: CurrencyDescriptor = mk({currency: 7, minter_family: 'CkEthErc20', wrapper_name: 'ckFoo', backing_symbol: 'FOO', network: 'Ethereum'});
    expect(isTestnetCurrency(mainnetErcClone)).toBe(false);
    expect(assetTestKey(mainnetErcClone)).toBe('ckfoo');
  });
});

// --- MC1 unit 5: authoritative per-currency asset metadata ------------------------------------
// RED-first proof that BUNDLED_CATALOG carries the authoritative per-currency field set (backing
// symbol, wrapper name, network, decimals, fee/cap, chain id, token contract, per-direction ramp
// capability), and that displayName/currencySymbol read from the PER-CURRENCY descriptor instead of
// family-level assumptions (closes "every CkEthErc20 displays as USDC"). Also pins the no-swap
// honesty contract: ckUSDC offramp is Unavailable (Fork-C/O3 — NO cash-out button).

describe('BUNDLED_CATALOG — authoritative per-currency metadata populated', () => {
  const byId = (id: number) => BUNDLED_CATALOG.find(c => c.currency === id)!;

  it('ckBTC carries backing_symbol=BTC, wrapper_name=ckBTC, network=Bitcoin, onramp=Direct, offramp=Direct', () => {
    const a = byId(1);
    expect(a.backing_symbol).toBe('BTC');
    expect(a.wrapper_name).toBe('ckBTC');
    expect(a.network).toBe('Bitcoin');
    expect(a.display_decimals).toBe(8);
    expect(a.onramp).toBe('Direct');
    expect(a.offramp).toBe('Direct');
  });

  it('ckUSDC carries backing_symbol=USDC, token_contract set, fee=10000, chain_id=1, onramp=Direct', () => {
    const a = byId(2);
    expect(a.backing_symbol).toBe('USDC');
    expect(a.wrapper_name).toBe('ckUSDC');
    expect(a.network).toBe('Ethereum');
    expect(a.fee).toBe('10000');
    expect(a.chain_id).toBe(1);
    expect(a.token_contract).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(a.onramp).toBe('Direct');
  });

  it('ckUSDC offramp is Direct + gas_ledger carries the ckETH principal (dual-ledger withdraw_erc20 cash-out)', () => {
    // The dual-ledger `withdraw_erc20` cash-out path: ckUSDC offramp=Direct + the ckETH gas_ledger
    // principal. dpay never converts ckUSDC→ckETH (no-swap); the user MUST hold ckETH for gas. The
    // app surfaces an honest "You need ckETH for gas" note in the WithdrawSheet.
    const a = byId(2);
    expect(a.offramp).toBe('Direct');
    expect(a.gas_ledger).toBe('ss2fx-dyaaa-aaaar-qacoq-cai');
  });

  it('DEMO offramp is Unavailable (play money — no cash-out) and onramp is Direct (faucet)', () => {
    const a = byId(0);
    expect(a.offramp).toBe('Unavailable');
    expect(a.onramp).toBe('Direct');
  });
});

describe('displayName/currencySymbol — per-currency fields over family assumptions (MC1 unit 5)', () => {
  it('displayName(ckUSDC) reads backing_symbol="USDC" (not a family-level assumption)', () => {
    expect(displayName(CKUSDC_DESC)).toBe('USDC');
  });
  it('displayName(ckBTC) reads backing_symbol="BTC"', () => {
    expect(displayName(CKBTC_DESC)).toBe('BTC');
  });
  it('a future ckERC20 (ckUSDT) renders as ITSELF, not "USDC" (per-currency backing_symbol wins)', () => {
    const ckusdt: CurrencyDescriptor = mk({currency: 5, minter_family: 'CkEthErc20', symbol: 'ckUSDT', decimals: 6, wrapper_name: 'ckUSDT', backing_symbol: 'USDT', network: 'Ethereum', display_decimals: 6});
    expect(displayName(ckusdt)).toBe('USDT');
    expect(displayName(ckusdt)).not.toBe('USDC');
  });
  it('currencySymbol(ckUSDC) is "$" (USD-backed stablecoin via backing_symbol)', () => {
    expect(currencySymbol([CKUSDC_DESC], 2)).toBe('$');
  });
  it('currencySymbol(ckBTC) is "₿"', () => {
    expect(currencySymbol([CKBTC_DESC], 1)).toBe('₿');
  });
  it('fmtCurrencyAmount(ckUSDC) reads per-currency decimals + backing_symbol', () => {
    // 1000000 raw @ 6 decimals → "1.000000 USDC" (reads descriptor.backing_symbol + display_decimals)
    expect(fmtCurrencyAmount([CKUSDC_DESC], 2, '1000000')).toBe('1.000000 USDC');
  });
  it('fmtCurrencyAmount(ckBTC) reads per-currency decimals + backing_symbol', () => {
    expect(fmtCurrencyAmount([CKBTC_DESC], 1, '50000')).toBe('0.00050000 BTC');
  });
  it('fmtCurrencyAmount renders a future ckERC20 in its OWN unit (not USDC)', () => {
    const ckusdt: CurrencyDescriptor = mk({currency: 5, minter_family: 'CkEthErc20', symbol: 'ckUSDT', decimals: 6, wrapper_name: 'ckUSDT', backing_symbol: 'USDT', network: 'Ethereum', display_decimals: 6});
    expect(fmtCurrencyAmount([ckusdt], 5, '2000000')).toBe('2.000000 USDT');
    expect(fmtCurrencyAmount([ckusdt], 5, '2000000')).not.toMatch(/USDC/);
  });
});

describe('familyDisplay sources per-currency facts from the descriptor (MC1 unit 5)', () => {
  it('familyDisplay(ckBTC).nativeAsset === "BTC" from the descriptor backing_symbol', () => {
    expect(familyDisplay(KNOWN_CATALOG, 1)?.nativeAsset).toBe('BTC');
    expect(familyDisplay(KNOWN_CATALOG, 1)?.networkLabel).toBe('Bitcoin');
    expect(familyDisplay(KNOWN_CATALOG, 1)?.amountDecimals).toBe(8);
  });
  it('familyDisplay(ckUSDC).nativeAsset === "USDC" from the descriptor backing_symbol', () => {
    expect(familyDisplay(KNOWN_CATALOG, 2)?.nativeAsset).toBe('USDC');
    expect(familyDisplay(KNOWN_CATALOG, 2)?.networkLabel).toBe('Ethereum');
    expect(familyDisplay(KNOWN_CATALOG, 2)?.amountDecimals).toBe(6);
  });
  it('a legacy descriptor without backing_symbol falls back to the family-default', () => {
    // No backing_symbol/network/display_decimals ⇒ family defaults (BTC/Bitcoin/8) keep working.
    const legacy: CurrencyDescriptor[] = [mk({currency: 1, minter_family: 'CkBtcUtxo', decimals: 8, symbol: '₿'})];
    expect(familyDisplay(legacy, 1)?.nativeAsset).toBe('BTC');
    expect(familyDisplay(legacy, 1)?.amountDecimals).toBe(8);
  });
});

// --- MC5: isPayableAsset — reject unknown/unsupported currencies BEFORE signing ----------------
// The bug: the payer signed ANY req.currency the merchant's request carried, even if that currency
// was unknown/unsupported. Defense-in-depth at the app: never let the user Approve a sign for a
// garbage/unsupported currency. The canister also rejects retired/unknown currencies, but the app
// should fail closed BEFORE the user signs.
//
// "Supported" ≠ "familyDisplay non-null": DEMO (currency 0) has minter_family null → familyDisplay
// returns null, BUT DEMO IS payable (the faucet funds it). So the predicate is:
//   currency === 0 || familyDisplay(catalog, currency) !== null.
// Known families (CkBtcUtxo/CkEthErc20) ⇒ payable. Unknown family (CkSol) / missing-from-catalog
// ⇒ NOT payable. Mirrors the fail-closed discipline of MC1 unit 6 (no Bitcoin fallback).
describe('isPayableAsset — payable predicate (MC5 fail-closed before signing)', () => {
  it('DEMO (currency 0) is payable even though familyDisplay returns null', () => {
    // CRITICAL: familyDisplay(KNOWN_CATALOG, 0) === null but DEMO IS supported. The predicate MUST
    // not collapse "supported" onto familyDisplay — currency 0 is the special case.
    expect(familyDisplay(KNOWN_CATALOG, 0)).toBeNull();
    expect(isPayableAsset(KNOWN_CATALOG, 0)).toBe(true);
  });
  it('ckBTC (currency 1, CkBtcUtxo) is payable', () => {
    expect(isPayableAsset(KNOWN_CATALOG, 1)).toBe(true);
  });
  it('ckUSDC (currency 2, CkEthErc20) is payable', () => {
    expect(isPayableAsset(KNOWN_CATALOG, 2)).toBe(true);
  });
  it('an unknown currency id (999, missing from the catalog) is NOT payable', () => {
    expect(isPayableAsset(KNOWN_CATALOG, 999)).toBe(false);
  });
  it('a CkSol-family currency is NOT payable (unknown family — fail closed)', () => {
    // CkSol is in the catalog but familyDisplay returns null for it (no ramp config) → NOT payable.
    expect(isPayableAsset(UNKNOWN_CATALOG, 99)).toBe(false);
  });
  it('empty catalog: only currency 0 is payable (DEMO special case)', () => {
    expect(isPayableAsset([], 0)).toBe(true);
    expect(isPayableAsset([], 1)).toBe(false);
  });
});

// --- MC8 U7 — ramp-honesty regression pins (no false cash-out / no CkSol advertising) ---------
// MC1 unit 5 + MC5 item 2 closed false ramp advertising: BalancesSheet.tsx AND-gates the Cash
// out button on `funded && offramp !== 'Unavailable' && (minter_family === 'CkBtcUtxo' ||
// minter_family === 'CkEthErc20')`, and familyDisplay returns null for unknown families (CkSol).
// ckUSDC (`offramp: 'Direct'` + `gas_ledger` set) now shows Cash-out (the dual-ledger
// withdraw_erc20 path); an `offramp: 'Unavailable'` currency (DEMO) still shows NO button. CkSol
// appears only in tests. This block pins those invariants so a future edit can't silently reopen a
// false-advertising path. NO behavior change — pins only.
//
// The cash-out predicate mirrors BalancesSheet.tsx at the CATALOG level (the `funded` leg is
// runtime balance state, out of catalog scope). A currency is cash-out-ELIGIBLE at the catalog
// level iff `offramp !== 'Unavailable' && (CkBtcUtxo || CkEthErc20)`.
describe('MC8 U7 — ramp-honesty regression pins (no false cash-out / no CkSol advertising)', () => {
  const cashOutEligible = (a: CurrencyDescriptor): boolean =>
    a.offramp !== 'Unavailable' &&
    (a.minter_family === 'CkBtcUtxo' || a.minter_family === 'CkEthErc20');

  it('ckUSDC (currency 2) is payable/onrampable AND cash-out-eligible (dual-ledger withdraw_erc20)', () => {
    // The ckERC20 cash-out pin: ckUSDC is fully payable (familyDisplay non-null), HAS a Direct
    // on-ramp, AND now HAS a Direct off-ramp (the dual-ledger withdraw_erc20 path). The gas_ledger
    // field carries the ckETH principal; the app surfaces a "You need ckETH for gas" note. Asserting
    // familyDisplay + onramp + offramp + gas_ledger + the cash-out predicate together so flipping
    // ANY leg turns this RED.
    const ckusdc = BUNDLED_CATALOG.find(c => c.currency === 2)!;
    expect(familyDisplay(BUNDLED_CATALOG, 2)).not.toBeNull(); // payable / onrampable
    expect(ckusdc.onramp).toBe('Direct');                    // HAS an on-ramp
    expect(ckusdc.offramp).toBe('Direct');                   // HAS an off-ramp (withdraw_erc20)
    expect(ckusdc.gas_ledger).toBe('ss2fx-dyaaa-aaaar-qacoq-cai'); // ckETH gas ledger
    expect(cashOutEligible(ckusdc)).toBe(true);              // cash-out predicate TRUE
  });

  it('DEMO (currency 0) is NOT cash-out-eligible (play money — offramp Unavailable)', () => {
    // The no-false-cash-out pin for play money: DEMO has onramp=Direct (faucet) but offramp=
    // Unavailable (no real-world value). The cash-out gate stays closed.
    const demo = BUNDLED_CATALOG.find(c => c.currency === 0)!;
    expect(demo.offramp).toBe('Unavailable');
    expect(cashOutEligible(demo)).toBe(false);
  });

  it('NO currency in BUNDLED_CATALOG has minter_family === CkSol (CkSol is test-only)', () => {
    // CkSol has no shipped ramp config (no per-principal deposit address, no retrieve path). It
    // must NEVER appear in the bundled fallback catalog — a user would see a SOL asset they can
    // neither fund nor cash out, and a familyDisplay bug could mis-render it as BTC. Pinned so
    // adding one is a deliberate, review-visible change, not an accidental catalog entry.
    const sol = BUNDLED_CATALOG.filter(c => c.minter_family === 'CkSol');
    expect(sol).toEqual([]);
  });

  it('familyDisplay returns null for an explicit CkSol fixture (fail-closed — never BTC fallback)', () => {
    // Explicit mirror of the MC1 unit 6 fail-closed pin with a CkSol descriptor. familyDisplay MUST
    // return null for an unknown family — a SOL asset labelled "BTC" is a non-custodial-trust
    // violation (dpay never swaps). Consumers render "Unsupported" + disable ramps on null.
    const cksol: CurrencyDescriptor = mk({
      currency: 42, minter: 'x', minter_family: 'CkSol', symbol: 'SOL', decimals: 9,
    });
    expect(familyDisplay([cksol], 42)).toBeNull();
  });

  it('EVERY currency with offramp === Unavailable has a FALSE cash-out predicate (catalog scan)', () => {
    // The no-false-cash-out-advertising invariant over the WHOLE catalog: every offramp=Unavailable
    // currency MUST fail the cash-out gate. DEMO (play money) qualifies; ckUSDC no longer does
    // (its offramp is now Direct).
    const noCashOut = BUNDLED_CATALOG.filter(c => c.offramp === 'Unavailable');
    expect(noCashOut.length).toBeGreaterThan(0); // DEMO at minimum
    for (const c of noCashOut) {
      expect(cashOutEligible(c)).toBe(false);
    }
  });

  it('ckBTC (currency 1) + ckUSDC (currency 2) + ckETH (currency 6) are the cash-out-eligible assets in BUNDLED_CATALOG', () => {
    // Belt-and-suspenders: cash-out is offered for CkBtcUtxo OR CkEthErc20 with offramp !==
    // Unavailable. In the shipped catalog that is ckBTC (retrieve_btc) + ckUSDC (withdraw_erc20) +
    // ckETH native (withdraw_eth, token_contract null). Pinned so removing any — or accidentally
    // enabling cash-out on DEMO — is a deliberate change.
    const eligible = BUNDLED_CATALOG.filter(cashOutEligible).map(c => c.currency).sort((a, b) => a - b);
    expect(eligible).toEqual([1, 2, 6]);
  });
});

// --- catalog single-source drift alarm (item 2, 2026-08-08) -----------------------------------
// `dfx/catalog_truth.json` is the single source of truth for the drift-prone currency literals
// shared across the relay's fake_catalog() (crates/dpay-relay/src/ledger.rs) and the app's
// BUNDLED_CATALOG (app/config/catalog.ts). The RELAY side is cross-checked by a Rust #[cfg(test)]
// drift-alarm in ledger.rs (catalog_truth_tests); THIS suite is the APP half. A drift in either
// direction goes RED:
//   - someone changes a literal in BUNDLED_CATALOG without updating the JSON → this suite RED;
//   - someone changes the JSON without updating BUNDLED_CATALOG → this suite RED.
// The relay's live /catalog response remains the RUNTIME source of truth; BUNDLED_CATALOG +
// fake_catalog are COLD-START FALLBACKS only — no second runtime source is introduced. Read at test
// time (mirrors payments.test.ts's wire_layout.json drift alarm) so it is independent of any bundler
// / resolveJsonModule config — the prod app has NO JSON imports.
const TRUTH = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'dfx', 'catalog_truth.json'), 'utf8'),
) as {
  principals: {ckbtc_minter: string; cketh_minter: string; ckusdc_ledger: string; cketh_gas_ledger: string; cketh_ledger: string};
  erc20_contracts: {ckusdc: string};
  decimals: {demo: number; ckbtc: number; ckusdc: number; eth: number};
  wire_consts: {retrieve_btc_min_amount: number; mint_account: string};
};

describe('BUNDLED_CATALOG vs dfx/catalog_truth.json (drift alarm)', () => {
  const byId = (id: number) => BUNDLED_CATALOG.find(c => c.currency === id)!;

  it('DEMO (currency 0) decimals match the shared truth', () => {
    expect(byId(0).decimals).toBe(TRUTH.decimals.demo);
  });

  it('ckBTC (currency 1) decimals + ckBTC minter principal match the shared truth', () => {
    // The ckBTC ledger principal is deliberately NOT asserted here: BUNDLED_CATALOG leaves it empty
    // (the relay resolves ledgers server-side from the currency id), so it is not a cross-side drift
    // risk. Only the minter principal + decimals are shared across the two fallbacks.
    const a = byId(1);
    expect(a.decimals).toBe(TRUTH.decimals.ckbtc);
    expect(a.minter).toBe(TRUTH.principals.ckbtc_minter);
  });

  it('ckUSDC (currency 2) decimals + ledger + minter + ERC-20 + gas-ledger all match the shared truth', () => {
    // ckUSDC is the highest-stakes entry: it carries the ckUSDC ERC-20 contract, the ckETH gas-ledger
    // principal (the dual-ledger withdraw_erc20 cash-out), AND the ckUSDC ledger + ckETH minter. A
    // drift on ANY of these → wrong-decimals display on cold load OR a broken cash-out path. All five
    // drift-prone values are pinned against the JSON here.
    const a = byId(2);
    expect(a.decimals).toBe(TRUTH.decimals.ckusdc);
    expect(a.ledger).toBe(TRUTH.principals.ckusdc_ledger);
    expect(a.minter).toBe(TRUTH.principals.cketh_minter);
    expect(a.token_contract).toBe(TRUTH.erc20_contracts.ckusdc);
    expect(a.gas_ledger).toBe(TRUTH.principals.cketh_gas_ledger);
  });

  it('ckETH native (currency 6) decimals + ledger + minter match the shared truth (18-dec mainnet)', () => {
    // ckETH mainnet (id 6) is the native-ETH entry: token_contract null (depositEth/withdraw_eth,
    // not an ERC-20), 18 decimals (Wei), backing_symbol ETH. The ledger principal (ss2fx…) is the
    // SAME principal as cketh_gas_ledger (the ckETH ledger serves dual purpose: native-ETH ledger +
    // gas source for ckERC20 cash-out). Pinned against the JSON so a cold-load (relay unreachable)
    // renders the correct 4th mainnet asset + the 18-dec precision extreme matches prod.
    const a = byId(6);
    expect(a.decimals).toBe(TRUTH.decimals.eth);
    expect(a.ledger).toBe(TRUTH.principals.cketh_ledger);
    expect(a.minter).toBe(TRUTH.principals.cketh_minter);
  });
});

// --- wire_consts drift alarm (M15 app half) ---------------------------------------------------
// `dfx/catalog_truth.json` `wire_consts` carries two literals that ALSO live as app-side values:
//   - `retrieve_btc_min_amount` (50_000 sats) — the ckBTC offramp floor, mirrored in the app as
//     `familyDisplay(BUNDLED_CATALOG, 1).withdrawMinRaw` (FD_CKBTC). A drift → the app's WithdrawSheet
//     would accept an amount the minter rejects (or reject one the minter accepts).
//   - `mint_account` (32 bytes of 0xFF, hex) — the faucet-mint sentinel, mirrored in the app as
//     `MINT_HEX` (lib/format.ts). A drift → the app would leak raw protocol hex ("from ffff…") instead
//     of the friendly "faucet" label (N4).
// The CANISTER half is cross-checked by a Rust drift-alarm in types.rs; this is the APP half. A drift
// in either direction goes RED here.
describe('wire_consts vs dfx/catalog_truth.json (M15 app-half drift alarm)', () => {
  it('ckBTC offramp floor familyDisplay(1).withdrawMinRaw === retrieve_btc_min_amount', () => {
    // The app's ckBTC withdraw floor (FD_CKBTC.withdrawMinRaw, surfaced via familyDisplay for
    // currency 1) must equal the shared truth's retrieve_btc_min_amount. Resolved through
    // familyDisplay (the same path WithdrawSheet reads) rather than the unexported FD_CKBTC const.
    const fd = familyDisplay(BUNDLED_CATALOG, 1);
    expect(fd).not.toBeNull();
    expect(fd!.withdrawMinRaw).toBe(TRUTH.wire_consts.retrieve_btc_min_amount);
  });

  it('MINT_HEX (lib/format) === mint_account (32 bytes of 0xFF)', () => {
    // The app's faucet-mint sentinel (MINT_HEX) must equal the shared truth's mint_account. A drift
    // breaks the friendly "faucet" label → leaks raw protocol hex to end users (N4).
    expect(MINT_HEX).toBe(TRUTH.wire_consts.mint_account);
    expect(MINT_HEX.length).toBe(64);
  });
});

// --- Phase 1: relay-scoped catalog cache (2026-08-12 unified asset selection rewrite) -------------
// The cache key is now NAMESPACED BY RELAY URL (was a global 'dpay.currencies.v1'). The bug this
// closes: a user who switches relay URLs (Settings → advanced) would otherwise reuse the PRIOR
// relay's cached catalog — a relay that exposes a different asset set (testnet, a different
// currency id mapping) would render stale/wrong rows until the next fetch landed. The cache key
// now embeds the normalized relay URL + bumps the version (v1 → v2) so stale global v1 entries
// do not bleed into the scoped cache. `catalogCacheKey` is PURE (no AsyncStorage) so it is unit-
// testable without mocking the storage layer.
describe('catalogCacheKey — relay-URL-scoped cache (Phase 1)', () => {
  it('produces DISTINCT keys for two distinct relay URLs (no cross-relay bleed)', () => {
    const a = catalogCacheKey('https://relay-a.example.com');
    const b = catalogCacheKey('https://relay-b.example.com');
    expect(a).not.toBe(b);
  });

  it('normalizes a trailing slash (https://x/ and https://x share ONE key)', () => {
    // Without normalization, a user who edits the relay URL and accidentally pastes a trailing
    // slash would miss the prior cache (two keys for one logical relay). Trim trailing slashes.
    expect(catalogCacheKey('https://relay.example.com')).toBe(catalogCacheKey('https://relay.example.com/'));
    expect(catalogCacheKey('https://relay.example.com')).toBe(catalogCacheKey('https://relay.example.com///'));
  });

  it('bumps the version to v2 (a stale global v1 entry must NOT bleed into the scoped cache)', () => {
    // The pre-Phase-1 key was the global 'dpay.currencies.v1'. The new key is namespaced + version-
    // bumped so a prior install's v1 cache entry is ignored (a schema drift between v1 and v2 would
    // otherwise be parsed through the validator; cleaner to namespace-invalidate).
    const k = catalogCacheKey('https://relay.example.com');
    expect(k.startsWith('dpay.currencies.v2:')).toBe(true);
    expect(k).not.toBe('dpay.currencies.v1');
  });

  it('embeds the normalized relay URL in the key (the scope IS the URL)', () => {
    const k = catalogCacheKey('https://relay.example.com/');
    expect(k).toContain('https://relay.example.com');
    expect(k).not.toContain('https://relay.example.com/'); // trailing slash stripped from the scope
  });

  it('a relay switch does NOT reuse the other relay\'s cache (distinct keys ⇒ distinct reads)', () => {
    // The relay-switch scenario end-to-end: cache one relay's catalog, switch relays, the new relay
    // MUST NOT see the old relay's entry. Two distinct keys ⇒ two distinct AsyncStorage reads.
    const keyA = catalogCacheKey('https://relay-a.example.com');
    const keyB = catalogCacheKey('https://relay-b.example.com');
    expect(keyA).not.toBe(keyB);
    // And after switching BACK, the original key is recovered (stable per URL).
    expect(catalogCacheKey('https://relay-a.example.com')).toBe(keyA);
  });
});
