/**
 * AssetGlyph — per-family asset monogram chips (CHF $ € ₿ ◊ ◎ ∂).
 * Design (2026-08-16 visual overhaul): every asset row/picker/balance surface shows a rounded
 * chip tinted with the family hue + the family's NATIVE SYMBOL as text. Symbols are currency
 * language (never icons — see icons.tsx), so they render as Text for exact font metrics.
 *
 * Pure mapping `glyphFor(asset)` is exported for jest: family is derived from the SelectableAsset
 * shape itself (its home currency, else protocol/token/symbol) — NO new field on SelectableAsset,
 * NO second source of truth for what an asset IS (that lives in config/assets.ts and, for which
 * currency a rail settles, in config/currency.ts alone).
 */
import React from 'react';
import {Text, View} from 'react-native';
import type {SelectableAsset} from '../config/assets';
import {currencyOfAsset, type HomeCurrency} from '../config/currency';
import {S, isDark} from '../styles';

export type FamilyGlyph = {
  /** The native currency symbol rendered inside the chip. */
  glyph: string;
  /** Family hue for the glyph text. */
  color: string;
  /** Soft tinted chip background (same hue, low alpha). */
  bg: string;
};

// Family hues — recognizable per-chain colors. LIGHT variants are deepened for the porcelain UI
// (dark-on-tint chips: hue text ~4.5:1 on the 8–10% tint over white). DARK variants are LIFTED
// (light-on-tint over the #2A2620 card: lifted hue text 4.1–5.3:1 on the 14% tint over card —
// glyphs render 700-weight, comfortably past the 3:1 large-text bar).
// DEMO ties to the brand (∂ = the dpay demo unit, tangerine); BTC amber, ETH indigo, USDC blue,
// SOL purple. Testnet variants keep the family hue (the row label already says testnet).
const FAMILIES: Record<string, Record<'light' | 'dark', FamilyGlyph>> = {
  demo: {
    light: {glyph: '∂', color: '#D8450D', bg: 'rgba(255,90,31,0.10)'},
    dark: {glyph: '∂', color: '#FF7A45', bg: 'rgba(255,122,69,0.14)'},
  },
  btc: {
    light: {glyph: '₿', color: '#92580B', bg: 'rgba(161,98,7,0.10)'},
    dark: {glyph: '₿', color: '#E8A33D', bg: 'rgba(232,163,61,0.14)'},
  },
  eth: {
    // ◊ lozenge (U+25CA): the ONLY diamond-family glyph present in EVERY bundled font (Ξ U+039E
    // is in none — MIUI fallback drew three disconnected "hamburger" bars on device, 2026-08-23).
    light: {glyph: '◊', color: '#4338CA', bg: 'rgba(79,70,229,0.08)'},
    dark: {glyph: '◊', color: '#8B93F8', bg: 'rgba(139,147,248,0.14)'},
  },
  usdc: {
    light: {glyph: '$', color: '#1D4ED8', bg: 'rgba(29,78,216,0.08)'},
    dark: {glyph: '$', color: '#6E9BFF', bg: 'rgba(110,155,255,0.14)'},
  },
  sol: {
    light: {glyph: '◎', color: '#7E22CE', bg: 'rgba(147,51,234,0.08)'},
    dark: {glyph: '◎', color: '#B57AEE', bg: 'rgba(181,122,238,0.14)'},
  },
  // The two home currencies whose mark is not already a family above (USD reuses `usdc`'s $).
  // CHF has no single-character sign every bundled font carries — the franc sign ₣ (U+20A3) is the
  // Ξ mistake again (2026-08-23: MIUI drew Ξ as three loose bars), so the mark is the three ASCII
  // letters the currency is written with everywhere, sized down by `glyphFontSize`. EUR gets a teal
  // that cannot be confused with USD's blue at a glance; the € carries the identity, the hue only
  // has to separate two stablecoin rows sitting next to each other in one list.
  chf: {
    light: {glyph: 'CHF', color: '#B3261E', bg: 'rgba(218,41,28,0.10)'},
    dark: {glyph: 'CHF', color: '#F2887E', bg: 'rgba(242,136,126,0.14)'},
  },
  eur: {
    light: {glyph: '€', color: '#0F766E', bg: 'rgba(15,118,110,0.10)'},
    dark: {glyph: '€', color: '#5EDBCB', bg: 'rgba(94,219,203,0.14)'},
  },
};

/** Which family carries each home currency's mark. USD deliberately reuses the `usdc` family: the
 *  dollar rails already wore $ and that was always the currency's mark, not the token's. */
const CURRENCY_FAMILY: Record<HomeCurrency, keyof typeof FAMILIES> = {CHF: 'chf', USD: 'usdc', EUR: 'eur'};

function familyKey(asset: SelectableAsset): keyof typeof FAMILIES | 'fallback' {
  // FIRST: does this asset settle a home currency? Then it wears the CURRENCY's mark, on every
  // surface that renders a chip — the chooser row (a currency), the accounts row (a rail of one).
  // Without this, the mark came from the rail: EURC-on-Solana wore ◎ and read as a SOL row, and
  // VCHF fell through to the first-letter fallback 'V'. `currencyOfAsset` is the ONE definition of
  // which currency a rail settles (config/currency.ts CURRENCY_RAILS), so a new rail of an existing
  // currency inherits the mark with no change here.
  const currency = currencyOfAsset(asset);
  if (currency !== null) return CURRENCY_FAMILY[currency];
  // Every remaining Solana row is a rail of no home currency, so it wears the chain's own mark.
  // (There is no per-token branch left here: a Solana row's `linkToken` IS its token, so USDC and
  // EURC are both resolved by the currency test above — a second test for them would be dead.)
  if (asset.protocol === 'solana') return 'sol';
  // IC: currency 0 is the DEMO unit; everything else is an ICRC ck-asset keyed by backing.
  if (asset.currency === 0) return 'demo';
  const s = asset.symbol.toUpperCase();
  if (s.includes('BTC')) return 'btc';
  if (s.includes('ETH')) return 'eth';
  // Stale-cache guard: a relay-served live catalog (AsyncStorage-cached) may still carry the
  // retired 'Ξ' symbol — it must still map home instead of falling to the brand fallback.
  if (s.includes('Ξ')) return 'eth';
  if (s.includes('USDC') || s.includes('USD')) return 'usdc';
  return 'fallback';
}

/** Pure: family chip spec for any SelectableAsset. Fallback = first letter, brand hue. The
 *  returned spec reflects the CURRENTLY APPLIED theme (light/deepened vs dark/lifted); the
 *  theme cannot change between two calls in one render pass. */
export function glyphFor(asset: SelectableAsset): FamilyGlyph {
  const key = familyKey(asset);
  const mode = isDark() ? 'dark' : 'light';
  if (key !== 'fallback') return FAMILIES[key][mode];
  return mode === 'dark'
    ? {glyph: asset.symbol.charAt(0).toUpperCase(), color: '#FF7A45', bg: 'rgba(255,122,69,0.14)'}
    : {glyph: asset.symbol.charAt(0).toUpperCase(), color: '#D8450D', bg: 'rgba(255,90,31,0.10)'};
}

/** Type size for a mark inside a `size`-wide chip. A one-character sign is set at 0.44·size (the
 *  original ratio); a multi-letter one (CHF) is set narrower so it fits the chip instead of
 *  spilling out of it — the Text has no width bound, so an oversized mark would simply overflow. */
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
