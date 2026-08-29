import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it, expect, afterEach, jest} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  isValidDestinationAddress,
  familyDisplay,
  displayName,
  currencySymbol,
  fmtCurrencyAmount,
  assetTestKey,
  isPayableAsset,
  isDirectIcrcAsset,
  isTestnetCurrency,
  testnetDisplayName,
  catalogCacheKey,
  fetchCurrencies,
  parseNetworkCatalog,
  icpCatalogOf,
  solanaAssetsOf,
  BUNDLED_NETWORKS,
  type CurrencyDescriptor,
  type NetworkSection,
} from '../config/catalog';
import {SOL_DECIMALS} from '../solana/identity';
import {ICP_LEDGER_PRINCIPAL} from '../config/constants';
import {USDC_DECIMALS, USDC_MINT_ADDRESS} from '../solana/spl';
import {MINT_HEX} from '../lib/format';

// Catalog v2: the bundled fallback is the network-first `BUNDLED_NETWORKS`; the flat IC catalog the
// metadata/drift-alarm describes below assert against is DERIVED through the same `icpCatalogOf`
// every consumer uses (one shape, one derivation — never a second hand-maintained flat array).
const BUNDLED_CATALOG: CurrencyDescriptor[] = icpCatalogOf(BUNDLED_NETWORKS);

// --- shared fixtures --------------------------------------------------------------------------
// MC1 unit 5: fixtures carry the full authoritative per-currency field set. `mk` fills the new
// fields with null defaults so each test only spells out what it asserts. Catalog v2: `testnet`
// defaults to false (a MAINNET-side row) — testnet fixtures set it explicitly, mirroring the parse
// time stamp from the owning icp section's environment.
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null,
  fee: null, cap: null, chain_id: null, token_contract: null, gas_ledger: null,
  onramp: 'Unavailable', offramp: 'Unavailable', testnet: false, ...d,
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
  it('fmtCurrencyAmount(DEMO, 5000) === "∂50.00" (not BTC, not $)', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 0, '5000')).toBe('∂50.00');
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
  it('returns the exact unit text "VCHF"/"ICP" for the complete bundled direct-ICRC rows (not "?")', () => {
    // U2 (2026-08-28): a complete trusted no-minter row renders its EXACT payment-unit text — the
    // descriptor's backing_symbol — instead of the ambiguous '?'. No franc glyph, no token icon:
    // the honest unit is the text the user pays.
    expect(currencySymbol(BUNDLED_CATALOG, 7)).toBe('VCHF');
    expect(currencySymbol(BUNDLED_CATALOG, 8)).toBe('ICP');
  });
  it('keeps "?" for an INCOMPLETE no-minter row (completeness gates the honest unit text)', () => {
    // Same VCHF row but with the cap stripped: not a complete trusted descriptor → the ambiguous
    // '?' fallback, never a half-honest unit prefix.
    const incomplete: CurrencyDescriptor[] = [{
      ...mk({
        currency: 7, minter_family: null, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', symbol: 'VCHF', decimals: 8,
        wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer',
        display_decimals: 8, fee: '10000', cap: null,
      }),
    }];
    expect(currencySymbol(incomplete, 7)).toBe('?');
  });
  it('DEMO/BTC/USD glyph behavior is preserved beside the new unit-text rows', () => {
    expect(currencySymbol(BUNDLED_CATALOG, 0)).toBe('∂');
    expect(currencySymbol(BUNDLED_CATALOG, 1)).toBe('₿');
    expect(currencySymbol(BUNDLED_CATALOG, 2)).toBe('$');
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
  it('returns "vchf"/"icp" for the bundled direct-ICRC rows (stable, unsuffixed, mainnet)', () => {
    // U5 (2026-08-28): the wrapper_name lowercased — the stable picker/Balances testID contract
    // (`asset-vchf` / `asset-icp`). Mainnet rows carry NO -testnet suffix.
    const vchf = BUNDLED_CATALOG.find(c => c.currency === 7)!;
    const icp = BUNDLED_CATALOG.find(c => c.currency === 8)!;
    expect(assetTestKey(vchf)).toBe('vchf');
    expect(assetTestKey(icp)).toBe('icp');
    expect(isTestnetCurrency(vchf)).toBe(false);
    expect(isTestnetCurrency(icp)).toBe(false);
  });
});

// --- testnet detection + labelling (single source of truth) -----------------------------------
// The production relay serves mainnet AND testnet chain-key currencies side-by-side: mainnet ckBTC
// (network "Bitcoin") next to ckTESTBTC (network "Bitcoin Testnet"), mainnet ckUSDC (network
// "Ethereum") next to ckSepoliaUSDC (network "Sepolia"). `displayName` returns the backing_symbol
// first, so WITHOUT testnet-aware labelling the two BTC rows render as indistinguishable "BTC"
// duplicates. These pin the three load-bearing invariants:
//   1. isTestnetCurrency: a FIELD READ on the server-declared `testnet` flag (stamped at parse
//      time from the owning section's environment — the client-side MAINNET_NETWORKS inference is
//      deleted; see parseNetworkCatalog tests below).
//   2. testnetDisplayName: "<backing_symbol> testnet" → "BTC testnet" / "USDC testnet" / "ETH testnet".
//   3. assetTestKey: a testnet currency's key gets a `-testnet` suffix so two rows sharing a backing
//      symbol (ckBTC + ckTESTBTC) get DISTINCT testIDs (the e2e net matches testID literally). Mainnet
//      keys are UNCHANGED (the e2e testID contract for currencies 0/1/2 is preserved).
const CKTESTBTC_DESC: CurrencyDescriptor = mk({currency: 3, minter: 'mt', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckTESTBTC', backing_symbol: 'BTC', network: 'Bitcoin Testnet', display_decimals: 8, onramp: 'Direct', offramp: 'Direct', testnet: true});
const CKSEPOLIA_USDC_DESC: CurrencyDescriptor = mk({currency: 4, minter: 'ms', minter_family: 'CkEthErc20', symbol: 'ckSepoliaUSDC', decimals: 6, wrapper_name: 'ckSepoliaUSDC', backing_symbol: 'USDC', network: 'Sepolia', display_decimals: 6, chain_id: 11155111, token_contract: '0x...', onramp: 'Direct', offramp: 'Direct', testnet: true});
const CKSEPOLIA_ETH_DESC: CurrencyDescriptor = mk({currency: 5, minter: 'me', minter_family: 'CkEthErc20', symbol: 'ckSepoliaETH', decimals: 18, wrapper_name: 'ckSepoliaETH', backing_symbol: 'ETH', network: 'Sepolia', display_decimals: 18, token_contract: null, onramp: 'Direct', offramp: 'Direct', testnet: true});

describe('isTestnetCurrency — a field read on the server-declared flag (no client inference)', () => {
  it('mainnet ckBTC (testnet=false) is NOT testnet', () => {
    expect(isTestnetCurrency(CKBTC_DESC)).toBe(false);
  });
  it('mainnet ckUSDC (testnet=false) is NOT testnet', () => {
    expect(isTestnetCurrency(CKUSDC_DESC)).toBe(false);
  });
  it('DEMO (testnet=false) is NOT testnet', () => {
    expect(isTestnetCurrency(DEMO_DESC)).toBe(false);
  });
  it('ckTESTBTC (testnet=true) IS testnet', () => {
    expect(isTestnetCurrency(CKTESTBTC_DESC)).toBe(true);
  });
  it('ckSepoliaUSDC (testnet=true) IS testnet', () => {
    expect(isTestnetCurrency(CKSEPOLIA_USDC_DESC)).toBe(true);
  });
  it('ckSepoliaETH (testnet=true) IS testnet', () => {
    expect(isTestnetCurrency(CKSEPOLIA_ETH_DESC)).toBe(true);
  });
  it('the flag WINS over the display `network` string in BOTH directions (declaration beats inference)', () => {
    // The deleted inference read `network`; the field read must not be nudged by it. A row the
    // SERVER declared testnet stays testnet even when its display network is a mainnet string, and
    // a mainnet-declared row stays mainnet even when its display network says "Sepolia".
    expect(isTestnetCurrency({...CKBTC_DESC, network: 'Bitcoin Testnet', testnet: false})).toBe(false);
    expect(isTestnetCurrency({...CKTESTBTC_DESC, network: 'Bitcoin', testnet: true})).toBe(true);
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
// "Supported" ≠ "familyDisplay non-null": PAYMENT capability ≠ RAMP capability (2026-08-28,
// VCHF/ICP). The predicate is the disjunction:
//   currency === 0 (DEMO always payable)
//   || familyDisplay(catalog, currency) !== null (a known ramp family vouches for the row)
//   || isCompleteDirectIcrcRow(descriptor) (a COMPLETE no-minter direct-ICRC row carries every
//      fact a plain icrc1_transfer needs).
// Known families (CkBtcUtxo/CkEthErc20) ⇒ payable. A complete no-minter row (VCHF 7 / ICP 8) ⇒
// payable WITHOUT a minter. Unknown family (CkSol) with incomplete facts / missing-from-catalog ⇒
// NOT payable. Mirrors the fail-closed discipline of MC1 unit 6 (no Bitcoin fallback).
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
    // CkSol is in the catalog but familyDisplay returns null for it (no ramp config) AND its row is
    // missing the direct-path facts (no ledger/fee/cap) → NOT payable either way.
    expect(isPayableAsset(UNKNOWN_CATALOG, 99)).toBe(false);
  });
  it('empty catalog: only currency 0 is payable (DEMO special case)', () => {
    expect(isPayableAsset([], 0)).toBe(true);
    expect(isPayableAsset([], 1)).toBe(false);
  });

  // --- VCHF/ICP (2026-08-28): direct payability decoupled from ramps ----------------------------
  // A COMPLETE trusted no-minter ICRC descriptor is payable WITHOUT any minter: the rail signs a
  // plain icrc1_transfer to the row's own ledger principal, so ramps (mintable/minter/
  // minter_family/onramp/offramp) are deliberately NOT inspected. Any missing direct fact fails
  // closed — the payer must never Approve a sign for a malformed asset.
  const VCHF_COMPLETE: CurrencyDescriptor = mk({
    currency: 7, minter_family: null, ledger: 'ly36x-wiaaa-aaaai-aqj7q-cai', symbol: 'VCHF', decimals: 8,
    wrapper_name: 'VCHF', backing_symbol: 'VCHF', network: 'Internet Computer',
    display_decimals: 8, fee: '10000', cap: '1000000000000',
    // mk defaults onramp/offramp to 'Unavailable' — this fixture pays with NO ramps by construction.
  });

  it('the complete bundled VCHF (7) and ICP (8) no-minter rows are payable', () => {
    // familyDisplay is null for both (no family — the ramp config is display/dispatch only), yet
    // both are payable: payability no longer collapses onto familyDisplay.
    expect(familyDisplay(BUNDLED_CATALOG, 7)).toBeNull();
    expect(familyDisplay(BUNDLED_CATALOG, 8)).toBeNull();
    expect(isPayableAsset(BUNDLED_CATALOG, 7)).toBe(true);
    expect(isPayableAsset(BUNDLED_CATALOG, 8)).toBe(true);
  });

  it('Unavailable ramps do NOT disable payment (no onramp, no offramp, no minter — still pays)', () => {
    const cat: CurrencyDescriptor[] = [VCHF_COMPLETE];
    expect(cat[0].onramp).toBe('Unavailable');
    expect(cat[0].offramp).toBe('Unavailable');
    expect(isPayableAsset(cat, 7)).toBe(true);
  });

  it('missing ledger principal ⇒ NOT payable (fail closed)', () => {
    expect(isPayableAsset([{...VCHF_COMPLETE, ledger: ''}], 7)).toBe(false);
  });
  it('missing / non-integer / out-of-range decimals ⇒ NOT payable', () => {
    // Decimals must be an integer within the u64 amount contract (0..=MAX_DECIMALS=18), mirroring
    // parseDecimalToUnits — a value the amount parser rejects can never back a payable asset.
    expect(isPayableAsset([{...VCHF_COMPLETE, decimals: null}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, decimals: 8.5}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, decimals: 19}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, decimals: -1}], 7)).toBe(false);
  });
  it('missing identity strings (wrapper_name / backing_symbol) ⇒ NOT payable', () => {
    expect(isPayableAsset([{...VCHF_COMPLETE, wrapper_name: null}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, wrapper_name: ''}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, backing_symbol: null}], 7)).toBe(false);
  });
  it('missing network ⇒ NOT payable', () => {
    expect(isPayableAsset([{...VCHF_COMPLETE, network: null}], 7)).toBe(false);
  });
  it('missing / unparseable raw fee ⇒ NOT payable', () => {
    expect(isPayableAsset([{...VCHF_COMPLETE, fee: null}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, fee: '-1'}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, fee: '1.5'}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, fee: 'ten thousand'}], 7)).toBe(false);
  });
  it('missing / zero / non-numeric raw cap ⇒ NOT payable (cap must be a positive unsigned integer)', () => {
    expect(isPayableAsset([{...VCHF_COMPLETE, cap: null}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, cap: '0'}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, cap: '-5'}], 7)).toBe(false);
    expect(isPayableAsset([{...VCHF_COMPLETE, cap: '1e12'}], 7)).toBe(false);
  });
  it('unknown currency ids fail closed even beside the complete rows (9 / 999)', () => {
    expect(isPayableAsset(BUNDLED_CATALOG, 9)).toBe(false);
    expect(isPayableAsset(BUNDLED_CATALOG, 999)).toBe(false);
  });
  it('a malformed/unsupported family cannot supply missing direct-payment facts via a Bitcoin or Ethereum fallback', () => {
    // A CkSol row DRESSED as BTC (₿ symbol, BTC backing, Bitcoin network) is still not payable:
    // familyDisplay returns null for CkSol and the direct path demands its OWN complete facts
    // (this row has no ledger/fee/cap). The Bitcoin family's credibility must never be borrowed.
    const fakeBtc: CurrencyDescriptor = mk({
      currency: 10, minter: 'x', minter_family: 'CkSol', symbol: '₿', decimals: 8,
      wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8,
    });
    expect(familyDisplay([fakeBtc], 10)).toBeNull();
    expect(isPayableAsset([fakeBtc], 10)).toBe(false);

    // An Ethereum-flavored no-minter row with every identity string set but NO ledger/fee/cap:
    // the Ethereum LOOK must not stand in for the missing direct facts.
    const fakeEth: CurrencyDescriptor = mk({
      currency: 11, minter_family: null, symbol: 'ETH', decimals: 18,
      wrapper_name: 'ETH', backing_symbol: 'ETH', network: 'Ethereum', chain_id: 1,
    });
    expect(isPayableAsset([fakeEth], 11)).toBe(false);
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
  principals: {ckbtc_minter: string; cketh_minter: string; ckusdc_ledger: string; cketh_gas_ledger: string; cketh_ledger: string; vchf_ledger: string; icp_ledger: string};
  erc20_contracts: {ckusdc: string};
  decimals: {demo: number; ckbtc: number; ckusdc: number; eth: number; vchf: number; icp: number};
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

  // --- VCHF/ICP (2026-08-28): the two complete no-minter direct-ICRC rows -----------------------
  // docs/specs/2026-08-28-vchf-icp-support-spec.md "Locked identities and metadata": the ledger
  // principals + decimals are cross-checked against catalog_truth.json (vchf_ledger / icp_ledger);
  // everything else in the locked table is pinned as literals below (the JSON deliberately carries
  // no fee/cap/order fields — those live only in the spec + the two fallback catalogs).
  it('VCHF (currency 7) ledger principal + decimals match the shared truth (vchf_ledger, 8)', () => {
    const a = byId(7);
    expect(a.ledger).toBe(TRUTH.principals.vchf_ledger);
    expect(a.decimals).toBe(TRUTH.decimals.vchf);
    expect(a.decimals).toBe(8);
  });

  it('ICP (currency 8) ledger principal + decimals match the shared truth (icp_ledger, 8)', () => {
    const a = byId(8);
    expect(a.ledger).toBe(TRUTH.principals.icp_ledger);
    expect(a.decimals).toBe(TRUTH.decimals.icp);
    expect(a.decimals).toBe(8);
  });

  it('ICP_LEDGER_PRINCIPAL matches the shared truth AND the currency-8 row', () => {
    // The send rail asks "does this ledger expose the LEGACY `transfer` method?" by comparing
    // against this constant (app/lib/destination.ts isNativeIcpLedger), so a drift would either
    // strand exchange-style 64-hex ICP addresses or — worse — offer the legacy rail for an asset
    // whose ledger has no such method. Pinned to BOTH the JSON truth and the catalog row so the
    // three cannot disagree.
    expect(ICP_LEDGER_PRINCIPAL).toBe(TRUTH.principals.icp_ledger);
    expect(ICP_LEDGER_PRINCIPAL).toBe(byId(8).ledger);
  });

  it('VCHF/ICP rows pin the locked identity table: unit strings, fee, caps, no-minter shape, Unavailable ramps, order', () => {
    // The full locked table (see the spec's "Locked identities and metadata"). Order: VCHF (7)
    // comes immediately after currency 6, ICP (8) immediately after VCHF — in the icp MAINNET
    // section (both rows stamped testnet:false). A change to ANY locked value turns this RED, so a
    // catalog edit can never silently drift from the spec.
    const mainnet = BUNDLED_NETWORKS.find(
      (s): s is Extract<NetworkSection, {protocol: 'icp'}> => s.protocol === 'icp' && s.environment === 'mainnet',
    )!;
    expect(mainnet.assets.map(c => c.currency)).toEqual([0, 1, 2, 6, 7, 8]);
    expect(mainnet.assets[4].currency).toBe(7); // VCHF directly after ckETH (6)
    expect(mainnet.assets[5].currency).toBe(8); // ICP directly after VCHF (7)

    const vchf = byId(7);
    expect(vchf.symbol).toBe('VCHF');
    expect(vchf.wrapper_name).toBe('VCHF');
    expect(vchf.backing_symbol).toBe('VCHF');
    expect(vchf.network).toBe('Internet Computer');
    expect(vchf.display_decimals).toBe(8);
    expect(vchf.fee).toBe('10000');                       // raw 10_000 e8-splits
    expect(vchf.cap).toBe('1000000000000');               // raw 1_000_000_000_000 = 10,000 VCHF
    expect(vchf.mintable).toBe(false);
    expect(vchf.minter).toBeNull();                       // no-minter shape: direct icrc1_transfer
    expect(vchf.minter_family).toBeNull();                // NEVER a fake family
    expect(vchf.onramp).toBe('Unavailable');              // no Add money button
    expect(vchf.offramp).toBe('Unavailable');             // no Cash out button
    expect(vchf.chain_id).toBeNull();
    expect(vchf.token_contract).toBeNull();
    expect(vchf.gas_ledger).toBeNull();
    expect(vchf.testnet).toBe(false);

    const icp = byId(8);
    expect(icp.symbol).toBe('ICP');
    expect(icp.wrapper_name).toBe('ICP');
    expect(icp.backing_symbol).toBe('ICP');
    expect(icp.network).toBe('Internet Computer');
    expect(icp.display_decimals).toBe(8);
    expect(icp.fee).toBe('10000');
    expect(icp.cap).toBe('100000000000');                 // raw 100_000_000_000 = 1,000 ICP
    expect(icp.mintable).toBe(false);
    expect(icp.minter).toBeNull();
    expect(icp.minter_family).toBeNull();
    expect(icp.onramp).toBe('Unavailable');
    expect(icp.offramp).toBe('Unavailable');
    expect(icp.chain_id).toBeNull();
    expect(icp.token_contract).toBeNull();
    expect(icp.gas_ledger).toBeNull();
    expect(icp.testnet).toBe(false);
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
// The cache key is NAMESPACED BY RELAY URL (was a global 'dpay.currencies.v1'). The bug this
// closes: a user who switches relay URLs (Settings → advanced) would otherwise reuse the PRIOR
// relay's cached catalog — a relay that exposes a different asset set (testnet, a different
// currency id mapping) would render stale/wrong rows until the next fetch landed. The cache key
// embeds the normalized relay URL. Catalog v2 (2026-08-27) changes the CACHED SHAPE (flat
// CurrencyDescriptor[] → NetworkSection[]) and bumps the version v2 → v3 so a stale flat v2 entry
// can never bleed into the scoped cache. `catalogCacheKey` is PURE (no AsyncStorage) so it is
// unit-testable without mocking the storage layer.
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

  it('bumps the version to v3 with the network-first shape (a stale flat v2 entry must NOT bleed in)', () => {
    // v1 was the global flat key; v2 was the relay-scoped FLAT-catalog key. Catalog v2 changes the
    // cached shape to NetworkSection[] and bumps v2 → v3 so a prior install's flat entry can never
    // be parsed as sections (namespace-invalidate on schema drift, same discipline as v1 → v2).
    const k = catalogCacheKey('https://relay.example.com');
    expect(k.startsWith('dpay.currencies.v3:')).toBe(true);
    expect(k).not.toBe('dpay.currencies.v2');
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

// --- catalog v2: the network-first envelope parser ----------------------------------------------
// The wire contract (GET /api/v1/currencies): {"networks":[{protocol,name,environment,assets:[…]}]}
// with icp mainnet + icp testnet + solana mainnet sections. These pin the parse-time invariants:
// the testnet FLAG is stamped from the owning section's environment (never re-inferred from the
// display network string), the flat IC catalog is the mainnet+testnet concatenation in section
// order, malformed sections/rows are skipped (never fatal), and anything that is not the
// network-first envelope — including the legacy flat {currencies:[…]} — parses to null so callers
// keep their prior catalog.
const wireIcpRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  currency: 1, ledger: 'mxzaz-hqaaa-aaaar-qaada-cai', mintable: false, minter: 'mqygn-kiaaa-aaaar-qaadq-cai',
  minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC',
  network: 'Bitcoin', display_decimals: 8, fee: null, cap: null, chain_id: null, token_contract: null,
  gas_ledger: null, onramp: 'Direct', offramp: 'Direct', ...over,
});
const NETWORKS_JSON = {
  networks: [
    {protocol: 'icp', name: 'Internet Computer', environment: 'mainnet', assets: [
      wireIcpRow({currency: 0, ledger: 'td2nx-oaaaa-aaaab-qhdnq-cai', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2, wrapper_name: null, backing_symbol: null, network: null, display_decimals: null}),
      wireIcpRow({currency: 2, ledger: 'xevnm-gaaaa-aaaar-qafnq-cai', minter: 'sv3dd-oaaaa-aaaar-qacoa-cai', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, fee: 10000, chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', gas_ledger: 'ss2fx-dyaaa-aaaar-qacoq-cai'}),
    ]},
    {protocol: 'icp', name: 'Internet Computer', environment: 'testnet', assets: [
      wireIcpRow({currency: 3, minter: 'mt', wrapper_name: 'ckTESTBTC', network: 'Bitcoin Testnet'}),
    ]},
    {protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: [
      {token: 'SOL', symbol: 'SOL', decimals: 9, mint: null, onramp: 'Direct', offramp: 'Direct'},
      {token: 'USDC', symbol: 'USDC', decimals: 6, mint: USDC_MINT_ADDRESS, onramp: 'Direct', offramp: 'Direct'},
    ]},
  ],
};

describe('parseNetworkCatalog — network-first envelope (catalog v2)', () => {
  it('parses the icp mainnet + icp testnet + solana mainnet sections in order', () => {
    const sections = parseNetworkCatalog(NETWORKS_JSON)!;
    expect(sections.map(s => `${s.protocol}:${s.environment}`)).toEqual(['icp:mainnet', 'icp:testnet', 'solana:mainnet']);
  });

  it('stamps each icp row\'s testnet flag from its OWNING section\'s environment', () => {
    const flat = icpCatalogOf(parseNetworkCatalog(NETWORKS_JSON)!);
    expect(flat.map(c => [c.currency, c.testnet])).toEqual([[0, false], [2, false], [3, true]]);
  });

  it('the section\'s declaration WINS over the row\'s display network string (no re-inference)', () => {
    // A testnet-section row that carries a mainnet-style network string ("Bitcoin") is STILL
    // testnet — the relay owns classification; the app never re-infers from display fields.
    const j = {networks: [
      {protocol: 'icp', name: 'ic', environment: 'testnet', assets: [wireIcpRow({currency: 9, network: 'Bitcoin'})]},
    ]};
    const flat = icpCatalogOf(parseNetworkCatalog(j)!);
    expect(flat[0].testnet).toBe(true);
  });

  it('icpCatalogOf concatenates mainnet THEN testnet in section order (the flat catalog contract)', () => {
    const flat = icpCatalogOf(parseNetworkCatalog(NETWORKS_JSON)!);
    expect(flat.map(c => c.currency)).toEqual([0, 2, 3]);
  });

  it('maps icp rows field-for-field (IC row shape UNCHANGED; fee coerced number→string)', () => {
    const flat = icpCatalogOf(parseNetworkCatalog(NETWORKS_JSON)!);
    const usdc = flat.find(c => c.currency === 2)!;
    expect(usdc.ledger).toBe('xevnm-gaaaa-aaaar-qafnq-cai');
    expect(usdc.minter).toBe('sv3dd-oaaaa-aaaar-qacoa-cai');
    expect(usdc.minter_family).toBe('CkEthErc20');
    expect(usdc.decimals).toBe(6);
    expect(usdc.display_decimals).toBe(6);
    expect(usdc.fee).toBe('10000');
    expect(usdc.chain_id).toBe(1);
    expect(usdc.token_contract).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(usdc.gas_ledger).toBe('ss2fx-dyaaa-aaaar-qacoq-cai');
    expect(usdc.onramp).toBe('Direct');
    expect(usdc.offramp).toBe('Direct');
    expect(usdc.testnet).toBe(false);
  });

  it('an invalid ramp value fails closed to Unavailable', () => {
    const j = {networks: [{protocol: 'icp', name: 'ic', environment: 'mainnet', assets: [wireIcpRow({onramp: 'Soon'})]}]};
    const flat = icpCatalogOf(parseNetworkCatalog(j)!);
    expect(flat[0].onramp).toBe('Unavailable');
  });

  it('solanaAssetsOf returns the solana section rows (symbol/decimals/mint/ramps)', () => {
    const sol = solanaAssetsOf(parseNetworkCatalog(NETWORKS_JSON)!);
    expect(sol).toEqual([
      {token: 'SOL', symbol: 'SOL', decimals: 9, mint: null, onramp: 'Direct', offramp: 'Direct'},
      {token: 'USDC', symbol: 'USDC', decimals: 6, mint: USDC_MINT_ADDRESS, onramp: 'Direct', offramp: 'Direct'},
    ]);
  });

  it('keeps an EMPTY icp testnet section (clients must not infer from absence)', () => {
    const j = {networks: [
      {protocol: 'icp', name: 'ic', environment: 'mainnet', assets: [wireIcpRow({})]},
      {protocol: 'icp', name: 'ic', environment: 'testnet', assets: []},
    ]};
    const sections = parseNetworkCatalog(j)!;
    expect(sections).toHaveLength(2);
    expect(sections[1].environment).toBe('testnet');
    expect(sections[1].assets).toEqual([]);
  });

  it('returns NULL for the legacy flat envelope {currencies:[…]} (no legacy parsing path)', () => {
    expect(parseNetworkCatalog({currencies: [wireIcpRow({})]})).toBeNull();
  });

  it('returns NULL for non-envelope payloads (null / {} / networks not an array)', () => {
    expect(parseNetworkCatalog(null)).toBeNull();
    expect(parseNetworkCatalog({})).toBeNull();
    expect(parseNetworkCatalog({networks: 'nope'})).toBeNull();
  });

  it('returns NULL when no section carries a valid asset (mirrors the old empty-catalog guard)', () => {
    expect(parseNetworkCatalog({networks: []})).toBeNull();
    expect(parseNetworkCatalog({networks: [{protocol: 'icp', name: 'ic', environment: 'mainnet', assets: []}]})).toBeNull();
  });

  it('SKIPS a section whose environment is neither mainnet nor testnet (never infers)', () => {
    const j = {networks: [
      {protocol: 'icp', name: 'ic', environment: 'prod', assets: [wireIcpRow({})]},
      {protocol: 'icp', name: 'ic', environment: 'mainnet', assets: [wireIcpRow({currency: 2})]},
    ]};
    const sections = parseNetworkCatalog(j)!;
    expect(sections).toHaveLength(1);
    expect(sections[0].environment).toBe('mainnet');
  });

  it('SKIPS a section with an unknown protocol (a future chain this app has no rail for)', () => {
    const j = {networks: [
      {protocol: 'polkadot', name: 'Polkadot', environment: 'mainnet', assets: [{token: 'DOT', symbol: 'DOT', decimals: 10, mint: null, onramp: 'Direct', offramp: 'Direct'}]},
      {protocol: 'icp', name: 'ic', environment: 'mainnet', assets: [wireIcpRow({})]},
    ]};
    const sections = parseNetworkCatalog(j)!;
    expect(sections.map(s => s.protocol)).toEqual(['icp']);
  });

  it('filters malformed icp rows (non-number currency) without dropping the section', () => {
    const j = {networks: [{protocol: 'icp', name: 'ic', environment: 'mainnet', assets: [{currency: 'zero'}, null, wireIcpRow({currency: 2})]}]};
    const flat = icpCatalogOf(parseNetworkCatalog(j)!);
    expect(flat.map(c => c.currency)).toEqual([2]);
  });

  it('filters malformed solana rows (missing token/symbol/decimals)', () => {
    const j = {networks: [{protocol: 'solana', name: 'Solana', environment: 'mainnet', assets: [
      {symbol: 'SOL', decimals: 9},                     // no token
      {token: 'SOL', decimals: 9},                      // no symbol
      {token: 'SOL', symbol: 'SOL'},                    // no decimals
      {token: 'USDC', symbol: 'USDC', decimals: 6},     // valid (mint omitted ⇒ null)
    ]}]};
    const sol = solanaAssetsOf(parseNetworkCatalog(j)!);
    expect(sol).toEqual([{token: 'USDC', symbol: 'USDC', decimals: 6, mint: null, onramp: 'Unavailable', offramp: 'Unavailable'}]);
  });

  it('survives a JSON round-trip through the cached envelope (the cache read parses the SAME shape)', () => {
    // fetchCurrencies caches `{"networks":[…]}` (the wire envelope) and useCatalog replays it
    // through this same parser — the round-trip must be identity or a cache hit would be lost.
    const once = parseNetworkCatalog(NETWORKS_JSON)!;
    const cached = JSON.stringify({networks: once});            // what fetchCurrencies persists
    const twice = parseNetworkCatalog(JSON.parse(cached))!;     // what useCatalog reads back
    expect(twice).toEqual(once);
  });
});

describe('fetchCurrencies — wire fetch + cache persist (catalog v2)', () => {
  const realFetch = globalThis.fetch;
  afterEach(async () => {
    (globalThis as unknown as {fetch: typeof realFetch}).fetch = realFetch;
    await AsyncStorage.clear();
  });
  const install = (body: unknown, ok = true, status = 200) => {
    const mock = jest.fn(async () => ({ok, status, json: async () => body} as unknown as Response));
    (globalThis as unknown as {fetch: typeof mock}).fetch = mock;
  };

  it('parses the network-first envelope, returns the sections, and PERSISTS THE ENVELOPE (not a bare array)', async () => {
    // Regression pin: the cache must store `{"networks":[…]}` — useCatalog replays the cached blob
    // through parseNetworkCatalog, so a bare-array persist would make every cache read a miss.
    install(NETWORKS_JSON);
    const prior: NetworkSection[] = [];
    const out = await fetchCurrencies('https://relay.example.com', prior);
    expect(out).not.toBe(prior);
    expect(out.map(s => `${s.protocol}:${s.environment}`)).toEqual(['icp:mainnet', 'icp:testnet', 'solana:mainnet']);
    const key = catalogCacheKey('https://relay.example.com');
    const stored = await AsyncStorage.getItem(key);
    expect(stored).toBeTruthy();
    const reparsed = parseNetworkCatalog(JSON.parse(stored!));
    expect(reparsed).toEqual(out);
  });

  it('a non-OK response keeps prior (offline/503 ⇒ no catalog change) and caches nothing', async () => {
    install('unavailable', false, 503);
    const prior: NetworkSection[] = parseNetworkCatalog(NETWORKS_JSON)!;
    const out = await fetchCurrencies('https://relay.example.com', prior);
    expect(out).toBe(prior);
    expect(await AsyncStorage.getItem(catalogCacheKey('https://relay.example.com'))).toBeNull();
  });

  it('a legacy flat {currencies:[…]} body keeps prior and caches nothing', async () => {
    install({currencies: [wireIcpRow({})]});
    const prior: NetworkSection[] = [];
    expect(await fetchCurrencies('https://relay.example.com', prior)).toBe(prior);
    expect(await AsyncStorage.getItem(catalogCacheKey('https://relay.example.com'))).toBeNull();
  });
});

describe('BUNDLED_NETWORKS — one shape with the wire (catalog v2)', () => {
  it('carries the icp mainnet + icp testnet + solana mainnet sections in order', () => {
    expect(BUNDLED_NETWORKS.map(s => `${s.protocol}:${s.environment}`)).toEqual(['icp:mainnet', 'icp:testnet', 'solana:mainnet']);
  });

  it('derives the flat IC catalog [0,1,2,6,7,8] with every row stamped testnet=false', () => {
    const flat = icpCatalogOf(BUNDLED_NETWORKS);
    expect(flat.map(c => c.currency)).toEqual([0, 1, 2, 6, 7, 8]);
    expect(flat.every(c => !c.testnet)).toBe(true);
  });

  it('the icp testnet section is EMPTY (the section exists; the assets list does not)', () => {
    const testnet = BUNDLED_NETWORKS.find(s => s.protocol === 'icp' && s.environment === 'testnet')!;
    expect(testnet.assets).toEqual([]);
  });

  it('mirrors the solana rail constants VERBATIM (decimals + mint imported from the rail modules)', () => {
    expect(solanaAssetsOf(BUNDLED_NETWORKS)).toEqual([
      {token: 'SOL', symbol: 'SOL', decimals: SOL_DECIMALS, mint: null, onramp: 'Direct', offramp: 'Direct'},
      {token: 'USDC', symbol: 'USDC', decimals: USDC_DECIMALS, mint: USDC_MINT_ADDRESS, onramp: 'Direct', offramp: 'Direct'},
    ]);
  });
});

// isDirectIcrcAsset — the direct-ICRC receive gate (VCHF/ICP funding instructions, founder hard
// rule 2026-08-29). True ONLY for complete no-minter rows (receivable by a plain icrc1_transfer
// to the user's own principal); family rows, mintable rows and malformed rows all fail closed.
describe('isDirectIcrcAsset', () => {
  const flat = icpCatalogOf(BUNDLED_NETWORKS);
  const vchf = flat.find(c => c.currency === 7)!;
  const icp = flat.find(c => c.currency === 8)!;

  it('is TRUE for the bundled VCHF and ICP rows (complete no-minter direct-ICRC)', () => {
    expect(isDirectIcrcAsset(vchf)).toBe(true);
    expect(isDirectIcrcAsset(icp)).toBe(true);
  });

  it('is FALSE for mintable rows (DEMO — faucet), family rows (ckBTC/ckETH have minters) and null/undefined', () => {
    expect(isDirectIcrcAsset(flat.find(c => c.currency === 0)!)).toBe(false); // DEMO: mintable
    expect(isDirectIcrcAsset(flat.find(c => c.currency === 1)!)).toBe(false); // ckBTC: minter
    expect(isDirectIcrcAsset(flat.find(c => c.currency === 2)!)).toBe(false); // ckUSDC: minter
    expect(isDirectIcrcAsset(flat.find(c => c.currency === 6)!)).toBe(false); // ckETH: minter
    expect(isDirectIcrcAsset(null)).toBe(false);
    expect(isDirectIcrcAsset(undefined)).toBe(false);
  });

  it('fails CLOSED on an incomplete no-minter row (missing ledger / decimals / fee / cap)', () => {
    // `ledger: null as string` deliberately breaks the declared type at runtime — a malformed
    // wire row is exactly the threat model (this shape null-deref'd before the guard existed).
    expect(isDirectIcrcAsset({...vchf, ledger: null as unknown as string})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, ledger: ''})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, decimals: null})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, fee: null})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, cap: null})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, wrapper_name: null})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, network: null})).toBe(false);
  });

  it('is FALSE the moment a minter appears (a family sheet is strictly more useful)', () => {
    expect(isDirectIcrcAsset({...vchf, minter: 'aaaaa-aa'})).toBe(false);
    expect(isDirectIcrcAsset({...vchf, mintable: true})).toBe(false);
  });
});
