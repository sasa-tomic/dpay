/**
 * AssetGlyph — per-family asset monogram chips ($ ₿ Ξ ◎ ∂).
 * Design (2026-08-16 visual overhaul): every asset row/picker/balance surface shows a rounded
 * chip tinted with the family hue + the family's NATIVE SYMBOL as text. Symbols are currency
 * language (never icons — see icons.tsx), so they render as Text for exact font metrics.
 *
 * Pure mapping `glyphFor(asset)` is exported for jest: family is derived from the SelectableAsset
 * shape itself (protocol/token/symbol) — NO new field on SelectableAsset, NO second source of
 * truth for what an asset IS (that lives in config/assets.ts alone).
 */
import React from 'react';
import {Text, View} from 'react-native';
import type {SelectableAsset} from '../config/assets';
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
    light: {glyph: 'Ξ', color: '#4338CA', bg: 'rgba(79,70,229,0.08)'},
    dark: {glyph: 'Ξ', color: '#8B93F8', bg: 'rgba(139,147,248,0.14)'},
  },
  usdc: {
    light: {glyph: '$', color: '#1D4ED8', bg: 'rgba(29,78,216,0.08)'},
    dark: {glyph: '$', color: '#6E9BFF', bg: 'rgba(110,155,255,0.14)'},
  },
  sol: {
    light: {glyph: '◎', color: '#7E22CE', bg: 'rgba(147,51,234,0.08)'},
    dark: {glyph: '◎', color: '#B57AEE', bg: 'rgba(181,122,238,0.14)'},
  },
};

function familyKey(asset: SelectableAsset): keyof typeof FAMILIES | 'fallback' {
  if (asset.protocol === 'solana') {
    return asset.token === 'USDC' ? 'usdc' : 'sol';
  }
  // IC: currency 0 is the DEMO unit; everything else is an ICRC ck-asset keyed by backing.
  if (asset.currency === 0) return 'demo';
  const s = asset.symbol.toUpperCase();
  if (s.includes('BTC')) return 'btc';
  if (s.includes('ETH')) return 'eth';
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

export function AssetGlyph({asset, size = 38}: {asset: SelectableAsset; size?: number}) {
  const g = glyphFor(asset);
  const scaled = size >= 46 ? S.assetGlyphLg : S.assetGlyph;
  return (
    <View style={[scaled, {width: size, height: size, borderRadius: Math.round(size * 0.32), backgroundColor: g.bg}]}>
      <Text style={[S.assetGlyphText, {color: g.color, fontSize: Math.round(size * 0.44)}]}>{g.glyph}</Text>
    </View>
  );
}
