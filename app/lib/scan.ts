import {detectAddressShape, type AddressShape} from './destination';
import {parsePayLink, decodeDeeplink} from './deepLink';
import {parseOcpScan, type OcpScan} from './opencryptopay';

// --- what else a scanned code could be ------------------------------------------------------------
// The Pay camera's only question used to be "is this a 132-byte wire request?", and its only answer
// on `no` was "This isn't a dpay payment code". That made two legitimate codes dead ends:
//
//   • a printed PAYMENT LINK — the shareable format `deepLink.ts` exists to produce, which until now
//     only worked when the OS delivered it as an App Link. Scanned with dpay's own camera it failed.
//   • a plain wallet ADDRESS — what every receive QR contains, dpay's own "My address" screen
//     included. The wallet could show you an address it could not then read back.
//   • an OPENCRYPTOPAY till code — the static LNURL a real merchant's till displays. It is not a
//     dpay artefact at all; recognising it is what lets dpay pay a shop that never heard of dpay.
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
  /** An OpenCryptoPay merchant till code. It carries the PARSE RESULT, not just the success, because
   *  a damaged or `http` LNURL is still that merchant's code: saying "your code is scuffed, ask for
   *  it again" needs the refusal, and the camera's generic shrug would throw it away. Only a string
   *  with no LNURL in it at all falls through to the checks below. */
  | {kind: 'opencryptopay'; ocp: OcpScan}
  /** Nothing claimed it. The caller's honest "not a payment code" error stands. */
  | {kind: 'unknown'};

/**
 * Classify a scanned string the rail's payment codec could not read.
 *
 * Link before OpenCryptoPay before address — each test is stricter than the one after it, so a
 * looser matcher can never steal a string a stricter one owns:
 *   • a link is an EXACT path match (`/wallet/pay/`) or an exact scheme (`dpay:pay/`);
 *   • an OCP code is an `lnurl1…` bech32 string, or a URL carrying one in a `lightning` parameter;
 *   • an address is a loose shape regex — and an UPPERCASE `LNURL1…` is inside the base58 alphabet,
 *     so testing addresses first would classify a perfectly good till code as a Solana address and
 *     send the payer to a send form.
 *
 * A MALFORMED payment link still answers `link`, and a damaged LNURL still answers `opencryptopay`:
 * "it is X and part of it is broken" is a different, more useful statement than "unrecognised", and
 * each pipeline already names which part. Pure, total, never throws.
 */
export function classifyScan(raw: string): ScanFallback {
  const t = raw.trim();
  if (t.length === 0) return {kind: 'unknown'};
  if (parsePayLink(t) != null || decodeDeeplink(t) != null) return {kind: 'link'};
  // `not-lnurl` is the ONE refusal that means "this is somebody else's kind of code" rather than
  // "this OCP code is broken", so it alone falls through to the address check.
  const ocp = parseOcpScan(t);
  if (ocp.ok || ocp.reason !== 'not-lnurl') return {kind: 'opencryptopay', ocp};
  const shape = detectAddressShape(t);
  return shape === 'unknown' ? {kind: 'unknown'} : {kind: 'address', shape};
}
