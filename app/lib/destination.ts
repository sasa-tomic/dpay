import type {CurrencyDescriptor, MinterFamily} from '../config/catalog';
import {ICP_LEDGER_PRINCIPAL} from '../config/constants';
import bs58 from 'bs58';

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

/** The Solana rail's verdict. It carries no route variant because the rail has exactly one way to
 *  move money — a device-key-signed transfer to a base58 wallet address — so "usable" is the whole
 *  answer. The refusal type is SHARED with the IC rail on purpose: that is what makes both rails
 *  refuse a wrong-chain paste in the same words. It is narrowed to the two reasons this rail can
 *  actually produce, so the caller's handling is exhaustive without a dead branch — `legacy-not-icp`
 *  is a fact about the ICP ledger and has no meaning here. */
export type SolanaRoute =
  | {ok: true}
  | {ok: false; refusal: Extract<RefusalReason, {reason: 'wrong-chain' | 'unrecognised'}>};

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

/** True when `t` (already matched against RE_BASE58's alphabet/length band) decodes to exactly
 *  32 bytes — a Solana ed25519 pubkey. Shape-only still: no checksum is verified, the decode is
 *  pure base58. Total by construction: bs58.decode can throw only on characters outside the
 *  alphabet, which RE_BASE58 has already excluded — the catch is belt-and-braces for totalness. */
function isSolanaPubkeyShape(t: string): boolean {
  try {
    return bs58.decode(t).length === 32;
  } catch {
    return false;
  }
}

/** Recognise a destination's address NAMESPACE by shape. Pure, total, checksum-free.
 *
 *  Order matters where two namespaces could both match a string:
 *  • 64-hex is tested BEFORE base58 — a 64-char hex string is also valid base58 alphabet, but no
 *    Solana address is 64 characters, so the legacy-ICP reading is the only sensible one.
 *  • `ic-account` requires a dash, which no other namespace here permits, so it cannot collide.
 *  • BTC is tested before the generic base58 catch-all, since `1…`/`3…` addresses are base58 too —
 *    BUT the base58 branch is tested FIRST when the string decodes to 32 bytes, because the
 *    leading-character rule CANNOT separate the namespaces: a BTC base58 address is 25 bytes
 *    (26–35 chars) while a Solana pubkey is 32 bytes (usually 43–44 chars), and venue deposit
 *    addresses DO start with `1`/`3` (live 2026-09-22: SideShift's EURC deposit address
 *    `3ytbGFZ…GurJ` — a pure `[13]…` prefix rule misread it as Bitcoin and gated the real
 *    funding send; attempt #9). The byte-length decode is the only honest disambiguator. */
export function detectAddressShape(text: string): AddressShape {
  const t = text.trim();
  if (t.length === 0) return 'unknown';
  if (RE_EVM.test(t)) return 'evm';
  if (RE_ICP_ACCOUNT_ID.test(t)) return 'icp-account-id';
  if (RE_IC_ACCOUNT.test(t)) return 'ic-account';
  if (RE_BASE58.test(t)) {
    // The ambiguous band: 32–44 base58 chars could be a Solana pubkey OR a long BTC base58
    // address. The decoded byte length decides — 32 = Solana, anything else falls through to
    // the BTC namespace (which ownes the `1…`/`3…` prefixes for its own 25-byte addresses) and
    // finally to `unknown` for strings no namespace can claim.
    if (isSolanaPubkeyShape(t)) return 'base58';
    if (RE_BTC.test(t)) return 'btc';
    return 'unknown';
  }
  if (RE_BTC.test(t)) return 'btc';
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

/** The Solana rail's half of the same policy table. It takes no descriptor because the rail has
 *  none — the device holds the key and talks to a Solana RPC directly, so there is no IC catalog
 *  row to consult; SOL and USDC-on-Solana are both addressed by the same base58 wallet address.
 *
 *  It exists so BOTH rails refuse in the same words: before this, the SOL send form answered every
 *  bad paste with "not a valid Solana address", which cannot tell a typo from a Bitcoin address a
 *  user pasted into the wrong wallet. That divergence is what CLAUDE.md's same-surfaces rule calls
 *  a bug rather than an exception. */
export function routeForSolana(shape: AddressShape): SolanaRoute {
  switch (shape) {
    case 'base58':
      return {ok: true};
    case 'evm':
    case 'btc':
    case 'ic-account':
    case 'icp-account-id':
      // Every other namespace is a real address on a real chain that is not Solana. Naming it is
      // the whole point — a wrong-chain paste is the most dangerous mistake this screen can accept.
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
