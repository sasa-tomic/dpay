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
import {S} from '../styles';

export type FamilyGlyph = {
  /** The native currency symbol rendered inside the chip. */
  glyph: string;
  /** Family hue for the glyph text. */
  color: string;
  /** Soft tinted chip background (same hue, low alpha). */
  bg: string;
};

// Family hues — recognizable per-chain colors, softened for the dark UI.
// DEMO stays brand-mint (∂ is the dpay demo unit); BTC orange, ETH lavender, USDC blue,
// SOL purple. Testnet variants keep the family hue (the row label already says testnet).
const FAMILIES: Record<string, FamilyGlyph> = {
  demo: {glyph: '∂', color: '#3ee0ac', bg: 'rgba(62,224,172,0.13)'},
  btc: {glyph: '₿', color: '#f7a54a', bg: 'rgba(247,165,74,0.13)'},
  eth: {glyph: 'Ξ', color: '#a3adcf', bg: 'rgba(163,173,207,0.13)'},
  usdc: {glyph: '$', color: '#5b9dff', bg: 'rgba(91,157,255,0.13)'},
  sol: {glyph: '◎', color: '#a78bff', bg: 'rgba(167,139,255,0.14)'},
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

/** Pure: family chip spec for any SelectableAsset. Fallback = first letter, brand hue. */
export function glyphFor(asset: SelectableAsset): FamilyGlyph {
  const key = familyKey(asset);
  if (key !== 'fallback') return FAMILIES[key];
  return {glyph: asset.symbol.charAt(0).toUpperCase(), color: '#3ee0ac', bg: 'rgba(62,224,172,0.13)'};
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
