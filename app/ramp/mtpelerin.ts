// Mt Pelerin widget link builder — the on/off-ramp entry point's PURE half: asset/delivery-chain
// routing, the per-address validation-code derivation, and the prefilled widget URL. No network,
// no React, no storage — the AsyncStorage salt store lives in codeSalts.ts, the signing primitive
// in evm/personalSign.ts. Facts pinned from developers.mtpelerin.com (2026-10-12):
//
//   • Widget URL: https://widget.mtpelerin.com/ with query parameters. Direct links are self-serve
//     (no `_ctkn` needed — that key only gates iframe/popup embedding); the builder still accepts
//     an optional `ctkn` so the R0 key can ride the same link once issued.
//   • Buy prefill: `bsc` (source FIAT code, e.g. CHF), `bdc` (destination CRYPTO code, e.g. ZCHF),
//     `bsa`/`bda` (source/destination amount, numbers per their docs — dpay serialises them as
//     plain decimal strings: dot separator, no grouping, no symbol), `dnet` (destination network),
//     `net` (default network). `bsa` wins over `bda` when both are present (their rule).
//   • Network names: Ethereum = `mainnet`, Arbitrum One = `arbitrum_mainnet` (their general-
//     parameters doc).
//   • Address validation rides the same URL: `addr` (the receiving address, unique per user),
//     `code` (4 digits, 1000-9999, MUST differ per address — re-use is rejected), `hash`
//     (base64 of the raw personal_sign bytes over `MtPelerin-{code}`, URL-encoded: `+` → %2B,
//     `/` → %2F, `=` → %3D). Their docs require this per address; the deterministic derivation
//     below is per-address by construction but cannot guarantee distinct codes, so the caller
//     drives the collision check and persists a salt (codeSalts.ts) when two of its addresses
//     ever derive the same code.
//   • Asset/delivery fit: ZCHF → Ethereum only (their service does not list ZCHF on Arbitrum);
//     USDC → Arbitrum One or Ethereum; bought ETH is NOT a ramp row (it lands as the wallet's gas
//     balance) and the builder refuses it — there is no `ETH` entry in the table to route to.
//
// Parameter spelling/casing is copied VERBATIM from their parameter docs and pinned by tests.

import {keccak256} from '../evm/keccak';
import {utf8ToBytes} from '../lib/base64url';

/** The widget origin (their ready-to-use URLs, how-to-test page). */
export const MTP_WIDGET_BASE = 'https://widget.mtpelerin.com/';

/** The EVM chains dpay wires that Mt Pelerin serves on mainnet: Ethereum and Arbitrum One.
 *  (Testnet/dev chain ids are deliberately absent — their widget is mainnet-only.) */
export type MtpDeliveryChainId = 1 | 42161;

/** dpay chain id → their `net`/`dnet` parameter value (their general-parameters doc, verbatim). */
const MTP_NETWORK_NAME: Record<MtpDeliveryChainId, string> = {
  1: 'mainnet',
  42161: 'arbitrum_mainnet',
};

export type MtpBuyAsset = 'ZCHF' | 'USDC';

/** The ramp-able asset codes (their `bdc` crypto codes, verbatim) and the delivery chains each is
 *  listed on. Bought ETH has no entry here: it renders as the gas balance, never as a buy row. */
export const MTP_ASSET_DELIVERY: Readonly<Record<MtpBuyAsset, readonly MtpDeliveryChainId[]>> = {
  ZCHF: [1],
  USDC: [42161, 1],
};

/** The delivery chains a buyable asset can land on, fail-closed (an unknown asset has NONE). */
export function mtpDeliveryChains(asset: MtpBuyAsset): readonly MtpDeliveryChainId[] {
  return MTP_ASSET_DELIVERY[asset] ?? [];
}

/**
 * The deterministic per-address validation code: `(first 4 bytes of keccak256(lowercase address)
 * as uint32 mod 9000) + 1000` → 1000..9999. The preimage is the 40-char lowercase hex body
 * WITHOUT the 0x prefix (the same preimage EIP-55 checksums over). `salt` (optional) is prepended
 * to the preimage and exists ONLY as the collision fallback: when two of a user's addresses
 * derive the same code, the caller persists a fresh random salt for one of them (codeSalts.ts)
 * and re-derives — validation binds (addr, code, hash), so a salted address still validates with
 * its own code. PURE: same inputs, same code, always.
 */
export function deriveValidationCode(address: string, salt?: string): number {
  const body = address.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`not a 20-byte EVM address: ${address}`);
  const digest = keccak256(utf8ToBytes((salt ?? '') + body));
  const head = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return (head % 9000) + 1000;
}

/** The exact message personal_sign signs for a validation code — their "message to sign" doc:
 *  always `MtPelerin-{code}`, on every chain. */
export function validationMessage(code: number): string {
  return `MtPelerin-${code}`;
}

export interface MtpWidgetLink {
  /** The asset the user buys (their `bdc` crypto code). */
  readonly asset: MtpBuyAsset;
  /** The chain the bought asset is delivered on (their `net`/`dnet` value); must be listed for
   *  `asset` in MTP_ASSET_DELIVERY — refused otherwise (fail-closed, never a dead prefill). */
  readonly deliveryChain: MtpDeliveryChainId;
  /** The receiving address (EIP-55 or lowercase 0x-hex) — passed through verbatim. */
  readonly address: string;
  /** The per-address validation code (deriveValidationCode). */
  readonly code: number;
  /** base64 of the raw personal_sign bytes over `MtPelerin-{code}` (signPersonalBase64). */
  readonly hash: string;
  /** Buy source fiat code (default CHF — dpay's home currency). */
  readonly fiat?: string;
  /** Prefilled amounts: plain decimal strings (dot separator, no grouping, no symbol). At most
   *  one should be set in practice — when both are, their widget takes the source amount. */
  readonly sourceAmount?: string;
  readonly destAmount?: string;
  /** Their integration key, once R0's review lands. Direct links do NOT need it; it only gates
   *  iframe/popup embedding. Never bake a default here. */
  readonly ctkn?: string;
}

const PLAIN_DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Build the prefilled buy widget URL. Every value is encodeURIComponent'd (their docs: `+`, `/`
 *  and `=` in the base64 hash MUST arrive as %2B/%2F/%3D — encodeURIComponent is exactly that).
 *  Parameter order is fixed so the output is byte-stable for the golden-vector tests. */
export function buildMtpWidgetLink(link: MtpWidgetLink): string {
  if (!EVM_ADDRESS.test(link.address)) throw new Error(`not an EVM address: ${link.address}`);
  if (!Number.isInteger(link.code) || link.code < 1000 || link.code > 9999) {
    throw new Error(`validation code must be 1000-9999, got ${link.code}`);
  }
  if (link.hash.length === 0) throw new Error('hash (base64 personal_sign) is required');
  if (!mtpDeliveryChains(link.asset).includes(link.deliveryChain)) {
    throw new Error(`asset ${link.asset} is not delivered on chain ${link.deliveryChain}`);
  }
  const net = MTP_NETWORK_NAME[link.deliveryChain];
  const fiat = link.fiat ?? 'CHF';
  if (!/^[A-Z]{3}$/.test(fiat)) throw new Error(`fiat must be a 3-letter code, got "${fiat}"`);
  for (const [name, amount] of [
    ['bsa', link.sourceAmount],
    ['bda', link.destAmount],
  ] as const) {
    if (amount !== undefined && !PLAIN_DECIMAL.test(amount)) {
      throw new Error(`${name} must be a plain decimal string, got "${amount}"`);
    }
  }

  const parts: string[] = [
    `net=${encodeURIComponent(net)}`,
    `dnet=${encodeURIComponent(net)}`,
    `bsc=${encodeURIComponent(fiat)}`,
    `bdc=${encodeURIComponent(link.asset)}`,
  ];
  if (link.sourceAmount !== undefined) parts.push(`bsa=${encodeURIComponent(link.sourceAmount)}`);
  if (link.destAmount !== undefined) parts.push(`bda=${encodeURIComponent(link.destAmount)}`);
  parts.push(
    `addr=${encodeURIComponent(link.address)}`,
    `code=${encodeURIComponent(String(link.code))}`,
    `hash=${encodeURIComponent(link.hash)}`,
  );
  if (link.ctkn !== undefined) parts.push(`_ctkn=${encodeURIComponent(link.ctkn)}`);
  return `${MTP_WIDGET_BASE}?${parts.join('&')}`;
}

/**
 * The SELL widget link (the cash-out handoff, 2026-10-13). The venue's API tier for dpay is
 * CLOSED (order creation happens in the USER'S OWN widget session), and dpay never learns a
 * deposit address programmatically: the address (and the bank details) exist only inside
 * that session, so the widget collects them.
 *
 * What this builder deliberately does NOT do: invent parameters. The repo's pinned parameter
 * facts (the plan's §2.2, sourced from developers.mtpelerin.com's ON-RAMP parameter docs,
 * fetched 2026-10-12) document BUY-side prefill only (`net`/`dnet`/`bsc`/`bdc`/`bsa`/`bda`/
 * `curs`/`crys`/`addr`/`code`/`hash`/`rfr`/`_ctkn`); NO sell-side currency/amount parameter
 * and NO free-form correlation (`oid`) parameter is documented anywhere in the repo's
 * fetched docs. The sell link is therefore the widget's documented bare base URL - the
 * user picks the sell flow (and types the amount/IBAN) in the venue's own UI. Because
 * nothing of ours can ride the link, the conversion webhook's `external_id` cannot be
 * correlated to dpay's order id from here: deliveries for widget-created orders answer
 * Unmatched (200, logged, no mutation) until the venue documents a correlation parameter
 * (the founder ask, OPEN_ISSUES). PURE: no network, no React.
 */
export function buildMtpSellWidgetLink(): string {
  return MTP_WIDGET_BASE;
}
