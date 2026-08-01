import {describe, it, expect} from '@jest/globals';
import {
  isValidDestinationAddress,
  familyDisplay,
  displayName,
  currencySymbol,
  fmtCurrencyAmount,
  assetTestKey,
  type CurrencyDescriptor,
} from '../config/catalog';

// --- shared fixtures --------------------------------------------------------------------------
const CKBTC_DESC: CurrencyDescriptor = {currency: 1, ledger: '', mintable: false, minter: 'm', minter_family: 'CkBtcUtxo', symbol: '₿', decimals: 8};
const CKUSDC_DESC: CurrencyDescriptor = {currency: 2, ledger: 'l', mintable: false, minter: 's', minter_family: 'CkEthErc20', symbol: 'ckUSDC', decimals: 6};
const CKSOL_DESC: CurrencyDescriptor = {currency: 99, ledger: '', mintable: false, minter: 'x', minter_family: 'CkSol', symbol: 'SOL', decimals: 9};
const DEMO_DESC: CurrencyDescriptor = {currency: 0, ledger: '', mintable: true, minter: null, minter_family: null, symbol: '$', decimals: 2};
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
      {currency: 7, ledger: 'l', mintable: false, minter: null, minter_family: null, symbol: null, decimals: null},
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
