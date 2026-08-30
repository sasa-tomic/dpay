import {detectAddressShape, type AddressShape} from './destination';
import {parsePayLink, decodeDeeplink} from './deepLink';

// --- what else a scanned code could be ------------------------------------------------------------
// The Pay camera's only question used to be "is this a 132-byte wire request?", and its only answer
// on `no` was "This isn't a dpay payment code". That made two legitimate codes dead ends:
//
//   • a printed PAYMENT LINK — the shareable format `deepLink.ts` exists to produce, which until now
//     only worked when the OS delivered it as an App Link. Scanned with dpay's own camera it failed.
//   • a plain wallet ADDRESS — what every receive QR contains, dpay's own "My address" screen
//     included. The wallet could show you an address it could not then read back.
//
// This module is the second opinion, consulted ONLY after the active rail's own payment codec has
// refused the string. That ordering matters: the codec is a strict length-and-CRC parser, so letting
// it answer first means the loose shape regexes below can never steal a valid request.

/** What a scanned string turns out to be once the rail's payment codec has refused it. */
export type ScanFallback =
  /** A dpay URL — a payment link or a `dpay:pay/` receipt hand-back. The Wallet's existing link
   *  pipeline resolves it (catalog lookup, cross-rail routing, per-part error copy); this module
   *  deliberately does not re-derive any of that. */
  | {kind: 'link'}
  /** A wallet address, with the namespace it belongs to. The send-to-address surface decides
   *  whether it is usable for the selected asset and says so — one refusal, one place. */
  | {kind: 'address'; shape: AddressShape}
  /** Nothing claimed it. The caller's honest "not a payment code" error stands. */
  | {kind: 'unknown'};

/**
 * Classify a scanned string the rail's payment codec could not read.
 *
 * Link before address: a link is identified by an EXACT path match (`/wallet/pay/`) or an exact
 * scheme (`dpay:pay/`), while the address namespaces are recognised by loose shape regexes. Testing
 * the exact matcher first means a URL can never be mistaken for an address, and an address — which
 * has no scheme and no path — can never parse as a link.
 *
 * A MALFORMED payment link still answers `link`: "it is a link and part of it is damaged" is a
 * different, more useful statement than "unrecognised", and the link pipeline already names which
 * part. Pure, total, never throws.
 */
export function classifyScan(raw: string): ScanFallback {
  const t = raw.trim();
  if (t.length === 0) return {kind: 'unknown'};
  if (parsePayLink(t) != null || decodeDeeplink(t) != null) return {kind: 'link'};
  const shape = detectAddressShape(t);
  return shape === 'unknown' ? {kind: 'unknown'} : {kind: 'address', shape};
}
