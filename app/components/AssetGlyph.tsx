/**
 * AssetGlyph - per-family asset monogram chips (CHF $ € ₿ ◊ • ∂).
 * Design (2026-08-16 visual overhaul): every asset row/picker/balance surface shows a rounded
 * chip tinted with the family hue + the family's NATIVE SYMBOL as text. Symbols are currency
 * language (never icons - see icons.tsx), so they render as Text for exact font metrics.
 *
 * Pure mapping `glyphFor(asset)` is exported for jest: family is derived from the SelectableAsset
 * shape itself (its home currency, else protocol/token/symbol) - NO new field on SelectableAsset,
 * NO second source of truth for what an asset IS (that lives in config/assets.ts and, for which
 * currency a rail settles, in config/currency.ts alone).
 */
import React from 'react';
import {Text, View} from 'react-native';
import type {SelectableAsset} from '../config/assets';
import {currencyOfAsset, type HomeCurrency} from '../config/currency';
import {C, withAlpha} from '../config/palette';
import {S, isDark} from '../styles';

export type FamilyGlyph = {
  /** The native currency symbol rendered inside the chip. */
  glyph: string;
  /** Family hue for the glyph text. */
  color: string;
  /** Soft tinted chip background - a `C.wash` tint OF `color`, never a second hue. */
  bg: string;
};

// Family hues - recognizable per-chain colors, retuned to the Ballast temperature (2026-09-26):
// cool families only (slate, steel, indigo, azure, violet, graphite, teal, sea green); the warm
// channel (the old BTC amber, CHF red) is gone. ONE hex per family per theme: the chip's tint is
// a `C.wash` tint of the monogram's own colour, so a family is one decision, not two that can
// drift out of contrast with each other. Each value is the family's OWN hue and chroma with only
// its lightness solved, so that the monogram clears 4.5:1 against its own tint over EVERY
// surface a chip can land on (bg / panel / panel2 / card / field); the contrast gate (section 4)
// is the arbiter and asserts exactly that via allChips().
//
// DEMO is NOT in this table: ∂ is the dpay unit, so its chip IS the brand and it is read from the
// palette at render time (`C.brandText`) - a copy of the teal here is a copy that survives the
// next brand change. Slate/steel BTC, indigo ETH, azure USDC, violet SOL, graphite CHF. Testnet
// variants keep the family hue (the row label already says testnet).
const FAMILIES: Record<string, {glyph: string; light: string; dark: string}> = {
  btc: {glyph: '₿', light: '#3E5A70', dark: '#93B8CC'},
  // ◊ lozenge (U+25CA): the ONLY diamond-family glyph present in EVERY bundled font (Ξ U+039E
  // is in none - MIUI fallback drew three disconnected "hamburger" bars on device, 2026-08-23).
  eth: {glyph: '◊', light: '#4C51B0', dark: '#A3AAEE'},
  usdc: {glyph: '$', light: '#1D5F8A', dark: '#6FB5DE'},
  // • bullet (U+2022): no bundled face carries the Solana mark - ◎ U+25CE, and also ○ U+25CB /
  // ● U+25CF (fonttools cmap-verified 2026-09-14, all four faces), so the old "swap to ○/●"
  // remedy was impossible. • is in EVERY face - the ◊ precedent: an in-font glyph the app's own
  // type can paint, never a system-fallback hope (2026-08-23 Ξ lesson).
  sol: {glyph: '•', light: '#6848A6', dark: '#BE9EEA'},
  // The two home currencies whose mark is not already a family above (USD reuses `usdc`'s $).
  // CHF has no single-character sign every bundled font carries - the franc sign ₣ (U+20A3) is the
  // Ξ mistake again (2026-08-23: MIUI drew Ξ as three loose bars), so the mark is the three ASCII
  // letters the currency is written with everywhere, sized down by `glyphFontSize`. EUR gets an
  // aqua teal that cannot be confused with USD's azure at a glance; the € carries the identity,
  // the hue only has to separate two stablecoin rows sitting next to each other in one list.
  // CHF wears graphite: the neutral home-currency ink of the cold palette.
  chf: {glyph: 'CHF', light: '#4E5C66', dark: '#A9BFC9'},
  eur: {glyph: '€', light: '#0A7366', dark: '#4FD8C4'},
  // ICP - the one currency with no single-character mark in the bundled fonts: the same
  // three-letter treatment CHF has, in a sea green that stays distinct from EUR's teal, USD's
  // azure and BTC's steel at a glance.
  icp: {glyph: 'ICP', light: '#1F6E52', dark: '#7BD3AF'},
};

/** A chip is a monogram and a `C.wash` tint of that same monogram. One colour in, one chip out. */
function chip(glyph: string, color: string): FamilyGlyph {
  return {glyph, color, bg: withAlpha(color, C.wash)};
}

/** EVERY chip this module can render, in the CURRENTLY APPLIED theme - the family table plus the
 *  two brand-derived chips (the ∂ unit and the unknown-symbol fallback). Exported so the contrast
 *  gate measures the real set rather than a list of families copied into a test, which is the copy
 *  that would silently stop covering a family the day one is added here. */
export function allChips(): FamilyGlyph[] {
  const dark = isDark();
  return [
    chip('∂', C.brandText),
    chip('X', C.brandText), // the fallback's monogram is the symbol's first letter; its colour is this
    ...Object.values(FAMILIES).map(f => chip(f.glyph, dark ? f.dark : f.light)),
  ];
}

/** Which family carries each wallet currency's mark. USD deliberately reuses the `usdc` family:
 *  the dollar rails already wore $ and that was always the currency's mark, not the token's.
 *  ICP gets its own letters + hue (no single-character Internet Computer mark exists in the
 *  bundled fonts - the CHF precedent); SOL reuses the chain's • family; BTC/ETH theirs. */
const CURRENCY_FAMILY: Record<HomeCurrency, keyof typeof FAMILIES> = {
  CHF: 'chf', USD: 'usdc', EUR: 'eur', BTC: 'btc', ETH: 'eth', ICP: 'icp', SOL: 'sol',
};

function familyKey(asset: SelectableAsset): keyof typeof FAMILIES | 'demo' | 'fallback' {
  // FIRST: does this asset settle a home currency? Then it wears the CURRENCY's mark, on every
  // surface that renders a chip - the chooser row (a currency), the accounts row (a rail of one).
  // Without this, the mark came from the rail: EURC-on-Solana wore the SOL mark and read as a SOL
  // row, and
  // VCHF fell through to the first-letter fallback 'V'. `currencyOfAsset` is the ONE definition of
  // which currency a rail settles (config/currency.ts CURRENCY_RAILS), so a new rail of an existing
  // currency inherits the mark with no change here.
  const currency = currencyOfAsset(asset);
  if (currency !== null) return CURRENCY_FAMILY[currency];
  // Remaining rows settle no wallet currency: DEMO's ∂ below, and any future token the currency
  // table does not know yet - it wears the chain's own mark. (A testnet sibling - ckTESTBTC -
  // also lands here, since its wrapper token is not a rail: the symbol branches below keep the
  // family hue for it, as the row label already says testnet.)
  if (asset.protocol === 'solana') return 'sol';
  // EVM rows settle no wallet currency yet (the CHF table lists VCHF, and ZCHF is a different
  // token) — but ZCHF IS a franc token: it wears the CHF family's mark, the same rule a future
  // CURRENCY_RAILS entry would give it.
  if (asset.protocol === 'evm') return 'chf';
  // IC: currency 0 is the DEMO unit; everything else is an ICRC ck-asset keyed by backing.
  if (asset.protocol === 'ic' && asset.currency === 0) return 'demo';
  const s = asset.symbol.toUpperCase();
  if (s.includes('BTC')) return 'btc';
  if (s.includes('ETH')) return 'eth';
  // Stale-cache guard: a relay-served live catalog (AsyncStorage-cached) may still carry the
  // retired 'Ξ' symbol - it must still map home instead of falling to the brand fallback.
  if (s.includes('Ξ')) return 'eth';
  if (s.includes('USDC') || s.includes('USD')) return 'usdc';
  return 'fallback';
}

/** Pure: family chip spec for any SelectableAsset. Fallback = first letter, brand hue. The
 *  returned spec reflects the CURRENTLY APPLIED theme (light/deepened vs dark/lifted); the
 *  theme cannot change between two calls in one render pass. */
export function glyphFor(asset: SelectableAsset): FamilyGlyph {
  const key = familyKey(asset);
  // The demo unit and an unrecognised symbol are both the BRAND's chip, read live so they follow
  // the palette instead of pinning a tangerine of their own.
  if (key === 'demo') return chip('∂', C.brandText);
  if (key === 'fallback') return chip(asset.symbol.charAt(0).toUpperCase(), C.brandText);
  const f = FAMILIES[key];
  return chip(f.glyph, isDark() ? f.dark : f.light);
}

/** Type size for a mark inside a `size`-wide chip. A one-character sign is set at 0.44·size (the
 *  original ratio); a multi-letter one (CHF) is set narrower so it fits the chip instead of
 *  spilling out of it - the Text has no width bound, so an oversized mark would simply overflow. */
export function glyphFontSize(glyph: string, size: number): number {
  return Math.round(size * (glyph.length > 1 ? 0.26 : 0.44));
}

export function AssetGlyph({asset, size = 38}: {asset: SelectableAsset; size?: number}) {
  const g = glyphFor(asset);
  const scaled = size >= 46 ? S.assetGlyphLg : S.assetGlyph;
  return (
    <View style={[scaled, {width: size, height: size, borderRadius: Math.round(size * 0.32), backgroundColor: g.bg}]}>
      <Text style={[S.assetGlyphText, {color: g.color, fontSize: glyphFontSize(g.glyph, size)}]}>{g.glyph}</Text>
    </View>
  );
}
