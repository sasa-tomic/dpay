import {describe, it, expect} from '@jest/globals';
import {
  isValidDestinationAddress,
  familyDisplay,
  displayName,
  currencySymbol,
  fmtCurrencyAmount,
  assetTestKey,
  BUNDLED_CATALOG,
  type CurrencyDescriptor,
} from '../config/catalog';

// --- shared fixtures --------------------------------------------------------------------------
// MC1 unit 5: fixtures carry the full authoritative per-currency field set. `mk` fills the new
// fields with null defaults so each test only spells out what it asserts.
const mk = (d: Partial<CurrencyDescriptor> & Pick<CurrencyDescriptor, 'currency' | 'minter_family'>): CurrencyDescriptor => ({
  ledger: '', mintable: false, minter: null, symbol: null, decimals: null,
  wrapper_name: null, backing_symbol: null, network: null, display_decimals: null,
  fee: null, cap: null, chain_id: null, token_contract: null,
  onramp: 'Unavailable', offramp: 'Unavailable', ...d,
});
const CKBTC_DESC: CurrencyDescriptor = mk({currency: 1, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8, wrapper_name: 'ckBTC', backing_symbol: 'BTC', network: 'Bitcoin', display_decimals: 8, onramp: 'Direct', offramp: 'Direct'});
const CKUSDC_DESC: CurrencyDescriptor = mk({currency: 2, ledger: 'l', minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6, wrapper_name: 'ckUSDC', backing_symbol: 'USDC', network: 'Ethereum', display_decimals: 6, fee: '10000', chain_id: 1, token_contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', onramp: 'Direct', offramp: 'Unavailable'});
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
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 0, 5000)).toBe('∂50.00');
  });
});

describe('fmtCurrencyAmount — explicit "Unsupported" sentinel for unknown families', () => {
  it('returns "Unsupported" for a CkSol amount (never "0.000001000 BTC")', () => {
    const s = fmtCurrencyAmount(UNKNOWN_CATALOG, 99, 1000);
    expect(s).toBe('Unsupported');
    expect(s).not.toMatch(/BTC/);
    expect(s).not.toMatch(/^\$/);
  });
  it('returns "Unsupported" even when a decimals value is present (family is the gate, not decimals)', () => {
    // CkSol carries decimals:9 in the catalog, but it's still an unknown FAMILY → fail closed.
    expect(fmtCurrencyAmount(UNKNOWN_CATALOG, 99, 123456789)).toBe('Unsupported');
  });
  it('formats ckBTC exactly (unchanged): 50000 sats → "0.00050000 BTC"', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 1, 50000)).toBe('0.00050000 BTC');
  });
  it('formats ckUSDC exactly (unchanged): 1000000 → "1.000000 USDC"', () => {
    expect(fmtCurrencyAmount(KNOWN_CATALOG, 2, 1000000)).toBe('1.000000 USDC');
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

  it('ckUSDC offramp is Unavailable (NO cash-out — Fork-C/O3 no-swap honesty)', () => {
    expect(byId(2).offramp).toBe('Unavailable');
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
    expect(fmtCurrencyAmount([CKUSDC_DESC], 2, 1000000)).toBe('1.000000 USDC');
  });
  it('fmtCurrencyAmount(ckBTC) reads per-currency decimals + backing_symbol', () => {
    expect(fmtCurrencyAmount([CKBTC_DESC], 1, 50000)).toBe('0.00050000 BTC');
  });
  it('fmtCurrencyAmount renders a future ckERC20 in its OWN unit (not USDC)', () => {
    const ckusdt: CurrencyDescriptor = mk({currency: 5, minter_family: 'CkEthErc20', symbol: 'ckUSDT', decimals: 6, wrapper_name: 'ckUSDT', backing_symbol: 'USDT', network: 'Ethereum', display_decimals: 6});
    expect(fmtCurrencyAmount([ckusdt], 5, 2000000)).toBe('2.000000 USDT');
    expect(fmtCurrencyAmount([ckusdt], 5, 2000000)).not.toMatch(/USDC/);
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
