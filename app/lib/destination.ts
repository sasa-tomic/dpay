import type {CurrencyDescriptor, MinterFamily} from '../config/catalog';
import {ICP_LEDGER_PRINCIPAL} from '../config/constants';

// --- send-to-address destination routing ----------------------------------------------------------
// ONE destination field, whatever the user pastes or scans. This module decides WHICH rail moves the
// money — and, when nothing can, WHY, in terms the user can act on (founder hard rule 2026-08-29:
// useful practical instructions on every step, especially the error path).
//
// The routing is a two-stage split so the expensive half is never guessed at:
//   1. `detectAddressShape` — PURE, synchronous, cheap. Recognises which ADDRESS NAMESPACE a string
//      belongs to by shape alone. It deliberately does NOT verify checksums: shape is what picks the
//      message and the route; validity is the core's job.
//   2. `routeForShape` — PURE. The policy table: given a shape and the selected asset, either name
//      the route or refuse with a specific reason.
// The caller then runs the ONE core validator that route needs (`icpValidateIcrcAccount` /
// `icpValidateAccountId`), so a CRC failure is reported against a known namespace ("this IC address
// is mistyped") instead of a shrug ("invalid address").
//
// Why shape-first and not try-every-parser: a wrong-chain paste is the single most common and most
// dangerous user error, and "that's an Ethereum address, this is VCHF on the Internet Computer" is
// only sayable if we recognise the namespace we are REFUSING. Trying parsers until one succeeds
// throws that information away and lands everyone on the same useless message.

/** The address namespaces a destination can belong to, by SHAPE alone (no checksum verification).
 *  `unknown` means no namespace claimed it — not that it is invalid. */
export type AddressShape =
  | 'ic-account'      // dash-grouped base32: an ICRC-1 principal, optionally `-checksum.subaccount`
  | 'icp-account-id'  // 64 hex chars: the LEGACY ICP account identifier namespace
  | 'evm'             // 0x + 40 hex
  | 'btc'             // bech32 `bc1…` or base58 `1…`/`3…`
  | 'base58'          // 32–44 base58 chars with no dashes — a Solana address
  | 'unknown';

/** How the money actually moves. Each kind maps to exactly one signing path. */
export type SendRoute =
  /** `icrc1_transfer` on the asset's own ledger — every IC asset supports this. */
  | {kind: 'icrc'}
  /** The ICP ledger's legacy `transfer`. ICP-ledger-only: no other ICRC ledger has the method. */
  | {kind: 'icp-legacy'}
  /** Burn the chain-key asset; the minter sends native funds on `family`'s chain. */
  | {kind: 'native'; family: MinterFamily};

/** Why a destination cannot be used for THIS asset. Each maps to one specific on-screen
 *  instruction — never a generic "invalid address". */
export type RefusalReason =
  /** An address for a different chain than the selected asset settles on. */
  | {reason: 'wrong-chain'; shape: AddressShape}
  /** A 64-hex legacy ICP account identifier, but the selected asset is not native ICP. Only the
   *  ICP ledger has a legacy `transfer`; every chain-key / ICRC-1 ledger is principal-addressed. */
  | {reason: 'legacy-not-icp'}
  /** Nothing recognised the string at all. */
  | {reason: 'unrecognised'};

export type DestinationRoute = {ok: true; route: SendRoute} | {ok: false; refusal: RefusalReason};

// Shape patterns. Conservative and mutually exclusive on real input — each anchors on a feature the
// others cannot have (dashes / exact hex length / the 0x prefix / bech32 + base58 leaders).
const RE_ICP_ACCOUNT_ID = /^[0-9a-fA-F]{64}$/;
const RE_EVM = /^0x[a-fA-F0-9]{40}$/;
// A principal is base32 in 5-char dash-separated groups (the last group may be shorter); the
// ICRC-1 subaccount form appends `-<checksum>.<subaccount-hex>`, where the checksum is SEVEN
// base32 chars — hence {1,7} rather than {1,5}. Shape only: the core verifies both CRCs.
const RE_IC_ACCOUNT = /^[a-z2-7]{1,7}(-[a-z2-7]{1,7})+(\.[0-9a-f]+)?$/i;
const RE_BTC = /^(bc1[02-9ac-hj-np-z]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{24,})$/;
const RE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Recognise a destination's address NAMESPACE by shape. Pure, total, checksum-free.
 *
 *  Order matters where two namespaces could both match a string:
 *  • 64-hex is tested BEFORE base58 — a 64-char hex string is also valid base58 alphabet, but no
 *    Solana address is 64 characters, so the legacy-ICP reading is the only sensible one.
 *  • `ic-account` requires a dash, which no other namespace here permits, so it cannot collide.
 *  • BTC is tested before the generic base58 catch-all, since `1…`/`3…` addresses are base58 too. */
export function detectAddressShape(text: string): AddressShape {
  const t = text.trim();
  if (t.length === 0) return 'unknown';
  if (RE_EVM.test(t)) return 'evm';
  if (RE_ICP_ACCOUNT_ID.test(t)) return 'icp-account-id';
  if (RE_IC_ACCOUNT.test(t)) return 'ic-account';
  if (RE_BTC.test(t)) return 'btc';
  if (RE_BASE58.test(t)) return 'base58';
  return 'unknown';
}

/** True when this descriptor is the NATIVE ICP ledger — the one canister that exposes the legacy
 *  `transfer` method, and therefore the only asset for which a 64-hex account identifier is a
 *  reachable destination. Identified by its ledger principal because that IS the fact: the method
 *  exists on that canister and nowhere else. Pinned against `dfx/catalog_truth.json` by the jest
 *  drift alarm, exactly as the relay pins its own copy. */
export function isNativeIcpLedger(desc: CurrencyDescriptor | null | undefined): boolean {
  return !!desc && desc.ledger === ICP_LEDGER_PRINCIPAL;
}

/** The routing policy table: which rail (if any) moves `desc` to a destination of this shape.
 *
 *  Every IC asset can pay an IC account, so `ic-account` always routes to `icrc` — that is what
 *  makes ckBTC sendable to an Oisy wallet, and it is the ONLY route VCHF/ICP have.
 *  A native-chain address routes to the minter burn, but only for the family that owns that chain:
 *  a `0x…` is a real Ethereum address and a real mistake when the selected asset is ckBTC.
 *
 *  `desc == null` (no asset selected / unknown currency) refuses everything — fail closed. */
export function routeForShape(shape: AddressShape, desc: CurrencyDescriptor | null | undefined): DestinationRoute {
  if (!desc) return {ok: false, refusal: {reason: 'unrecognised'}};
  const family = desc.minter_family;
  switch (shape) {
    case 'ic-account':
      // Every IC asset is principal-addressed on its own ledger.
      return {ok: true, route: {kind: 'icrc'}};
    case 'icp-account-id':
      return isNativeIcpLedger(desc)
        ? {ok: true, route: {kind: 'icp-legacy'}}
        : {ok: false, refusal: {reason: 'legacy-not-icp'}};
    case 'evm':
      return family === 'CkEthErc20'
        ? {ok: true, route: {kind: 'native', family}}
        : {ok: false, refusal: {reason: 'wrong-chain', shape}};
    case 'btc':
      return family === 'CkBtcUtxo'
        ? {ok: true, route: {kind: 'native', family}}
        : {ok: false, refusal: {reason: 'wrong-chain', shape}};
    case 'base58':
      // A Solana address. No IC asset settles on Solana, and dpay never swaps, so this is always a
      // wrong-chain paste — named as such rather than lumped in with unparseable junk.
      return {ok: false, refusal: {reason: 'wrong-chain', shape}};
    case 'unknown':
      return {ok: false, refusal: {reason: 'unrecognised'}};
  }
}

/** The chain a shape belongs to, as a proper noun for the refusal copy ("That's a Bitcoin
 *  address"). Wire/display constant, never translated — chain names are proper nouns, matching
 *  how `CurrencyDescriptor.network` is treated. Returns null for shapes with no single chain. */
export function chainNameOfShape(shape: AddressShape): string | null {
  switch (shape) {
    case 'evm': return 'Ethereum';
    case 'btc': return 'Bitcoin';
    case 'base58': return 'Solana';
    case 'ic-account':
    case 'icp-account-id': return 'Internet Computer';
    case 'unknown': return null;
  }
}
