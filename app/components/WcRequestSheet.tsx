import {useMemo} from 'react';
import {ActivityIndicator, Pressable, ScrollView, Text, View} from 'react-native';
import {AppModal} from './AppModal';
import {S} from '../styles';
import {C} from '../config/palette';
import {M} from '../i18n';
import {formatMonthDayYear} from '../i18n/intl';
import {bytesToHex, hexToBytes, rawToDecimal} from '../lib/format';
import {bytesToBase64, base64ToBytes} from '../lib/base64';
import bs58 from 'bs58';
import {deriveEvmKeypair} from '../evm/identity';
import {EVM_CHAINS, type EvmChainId} from '../evm/chains';
import {evmRpcUrls} from '../evm/endpoints';
import {signEip1559Tx, signLegacyTx, toHex0x} from '../evm/tx';
import {signPersonal} from '../evm/personalSign';
import {isTypedDataError, signTypedData, typedDataDigest, type TypedData} from '../evm/typedData';
import {deriveSolanaKeypair} from '../solana/identity';
import {signVenueSwapTx} from '../solana/tx';
import {ed25519} from '@noble/curves/ed25519';
import {
  decodeWcSolanaTx,
  SOLANA_METHODS_OUTSIDE_V1,
  type WcSolanaInstruction,
} from '../solana/wcDecode';
import type {WcProposal, WcRequest, WcResponse, WcSdkError} from '../walletkit';

// WcRequestSheet - the ONE WalletConnect review surface (plan W1 step 3): every session proposal
// and every reviewable session request a dApp sends lands here, and NOTHING answers the dApp
// except this sheet's buttons (approve/reject; the plan's "respondSessionRequest reachable only
// via sheet approve"). The sheet is the security boundary of the whole wallet side: it renders
// the requester (metadata name + url), the chain, and a human review of exactly what would be
// signed or sent - message text, EIP-712 fields, decoded ERC-20 calldata, or raw hex behind an
// explicit warning. Read-only methods (eth_accounts/eth_chainId) never open it (the request
// handler answers them directly); a request arriving while it is open is answered USER_REJECTED
// by the one-review-at-a-time law (also here, as the handler factory).
//
// SEAM: this module must not statically import `@reown/*`/`@walletconnect/*` (only `walletkit.ts`
// does) - it reaches WC types TYPE-ONLY (erased), and the SDK error objects arrive injected
// (Wallet passes `walletkit.wcUserRejected()`/`wcUnsupportedChains()` through). The network
// module for the eth_sendTransaction param-fill is lazily imported inside the broadcast function
// and gated on a non-empty endpoint URL (the `evm.ts` seam rule) - the offline inner loop never
// loads it.
//
// SUBMITTED, NOT SETTLED: an approved eth_sendTransaction reports the broadcast hash to the dApp
// and shows it here with the pending-settlement note - the send path's honest-unknown shape. No
// receipt poll on this path (the dApp can poll; dpay's own sends keep theirs).
//
// SOLANA (plan Track S): the same sheet is venue-neutral - solana_signMessage renders the message
// (base58 in, UTF-8 preview with a raw-bytes fallback note), solana_signTransaction and
// solana_signAndSendTransaction render the decodeWcSolanaTx review rows (transfers, SPL, memo,
// fee payer + required signers always shown) behind the SAME unknown-calldata law: anything not
// decoded exactly renders raw behind an explicit warning, never auto-approved. The sign itself is
// signVenueSwapTx with its DEFAULT options: the device must be a required signer, and a tx
// needing other signatures is refused WHOLE (never silently co-signed); only the device's own
// slot is written, all other bytes preserved. signAndSendTransaction alone broadcasts - through
// the app's own submitRawSolTx seam, lazily imported - and its base58 signature is the
// submitted-not-settled terminal (no receipt poll). solana_signAllTransactions is outside v1 and
// refused by name.

/** The requester as the sheet shows it: the dApp's WalletConnect metadata. */
export interface WcSheetDapp {
  readonly name: string;
  readonly url: string;
}

/** One decoded ERC-20 calldata argument. `key` is the display-label key (M.pay.wc). */
export type WcCallRowKey = 'to' | 'spender' | 'owner' | 'amount' | 'value' | 'deadline';
export interface WcCallRow {
  readonly key: WcCallRowKey;
  readonly value: string;
}

/** One free-form `name: value` line of the typed-data review (domain or message field). */
export type WcFieldRow = readonly [string, string];

/** One venue-neutral review row of a decoded Solana transaction. */
export type WcSolanaRowKey = 'from' | 'to' | 'owner' | 'amount' | 'mint' | 'memo' | 'program' | 'data';
export interface WcSolanaRow {
  readonly key: WcSolanaRowKey;
  readonly value: string;
}

/** Why the sheet shows what it shows - one variant per reviewable shape (plan W1 step 3). */
export type WcReview =
  /** personal_sign: the message as reviewable text when printable, else its hex. */
  | {kind: 'message'; text: string | null; hex: string | null; signerMismatch: boolean}
  /** eth_signTypedData_v4: domain + primary type + message fields, humanly. `malformed` is
   *  non-null for a payload that cannot hash as EIP-712 - the handler rejects it with a typed
   *  error BEFORE any sheet opens, and approve re-refuses (never raw-signs). */
  | {
      kind: 'typedData';
      domain: readonly WcFieldRow[];
      primaryType: string;
      message: readonly WcFieldRow[];
      data: TypedData | null;
      malformed: string | null;
      signerMismatch: boolean;
    }
  /** eth_sendTransaction: the request's own fields plus the decoded calldata rows; an unknown
   *  selector renders raw hex behind `unknownCall` (the explicit warning line). */
  | {
      kind: 'tx';
      to: string | null;
      valueWei: string | null;
      data: string;
      rows: readonly WcCallRow[];
      unknownCall: boolean;
      chainId: number | null;
      /** Non-null when the params name a chain the session is not on (or an unparseable one):
       *  the request is refused before the sheet - what the user reviews must be the chain the
       *  bytes move on. */
      chainDivergence: string | null;
      signerMismatch: boolean;
    }
  /** wallet_switchEthereumChain: the requested chain and whether dpay serves it. */
  | {kind: 'switchChain'; chain: string; wired: boolean}
  /** solana_signMessage: the base58 message bytes as text when printable UTF-8, else hex (the
   *  raw-bytes fallback note rides the hex). `hex` is ALWAYS the exact sign source. */
  | {kind: 'solanaMessage'; text: string | null; hex: string | null; signerMismatch: boolean}
  /** solana_signTransaction / solana_signAndSendTransaction: the decodeWcSolanaTx review.
   *  `malformed` (undecodable bytes) keeps the sheet open behind the raw-base64 display + the
   *  explicit warning; approve re-refuses. A params `feePayer` that names a DIFFERENT payer than
   *  the wire (`feePayerHidden`) is a dishonest display - refused. */
  | {
      kind: 'solanaTx';
      send: boolean;
      feePayer: string | null;
      signers: readonly string[];
      externalFeePayer: boolean;
      deviceSigns: boolean;
      coSigned: boolean;
      feePayerHidden: boolean;
      rows: readonly WcSolanaRow[];
      unknown: boolean;
      malformed: string | null;
      rawBase64: string;
    }
  /** Anything else (or a contract-creation tx): fail closed, the handler answers -32601. */
  | {kind: 'unsupported'; method: string};

export interface WcRequestSummary {
  readonly method: string;
  /** CAIP-2 chain the review names: the request's own, else the session's active chain. */
  readonly chain: string;
  readonly review: WcReview;
}

const NO_OUTCOME: WcApproveOutcome = {submittedHash: null, switchedTo: null};

/** The v1 session surface (plan W1 step 3): `walletkit.ts` WC_SUPPORTED_CHAINS restated for the
 *  switch-chain gate. The conformance suite pins both arms, so drift goes red there too. */
const WIRED_CHAIN_IDS: ReadonlyArray<number> = [1, 42161];

// --- small pure parsers -----------------------------------------------------------------------------

/** A 0x + 40-hex string, else null - the "which param is the address" test. */
function addressLike(v: unknown): string | null {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
}

function paramsArray(params: unknown): unknown[] {
  return Array.isArray(params) ? params : [params];
}

/** UTF-8 decode for the review line: null when the bytes are not valid UTF-8 or carry control
 *  characters a human cannot review as text (the sheet then shows hex instead). Pure JS, no
 *  TextDecoder (the RN blind-spot rule; the same rationale as typedData.ts's encoder). */
function utf8Printable(bytes: Uint8Array): string | null {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    let cp: number;
    let size: number;
    if (b0 < 0x80) {
      cp = b0;
      size = 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = bytes[i + 1];
      if (b1 === undefined || (b1 & 0xc0) !== 0x80) return null;
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      size = 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (b1 === undefined || b2 === undefined || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) return null;
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      size = 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (b1 === undefined || b2 === undefined || b3 === undefined || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return null;
      cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      size = 4;
    } else {
      return null; // a continuation byte as a leader (or 0xc0/0xc1/0xf5+): not valid UTF-8
    }
    if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f) return null;
    out += String.fromCodePoint(cp);
    i += size;
  }
  return out;
}

/** Full UTF-8 bytes of a string, astral plane included - the exact bytes a raw (non-hex)
 *  personal_sign message signs. Local for the same reason `utf8Printable` is: the shared
 *  lib/base64url codec is deliberately 3-byte-max (QR payloads), which would corrupt emoji. */
function fullUtf8Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i) as number;
    if (c > 0xffff) i++;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

/** personal_sign params: the address-looking entry is the signer, the other one the message
 *  (MetaMask's order is [data, address]; accepting either order costs one regex and matches the
 *  ecosystem). Returns both facts the review + approve need. */
function personalSignParams(params: unknown): {messageRaw: unknown; signer: string | null} {
  const arr = paramsArray(params);
  const signerEntry = arr.find((p) => addressLike(p) != null);
  const signer = signerEntry != null ? (addressLike(signerEntry) as string) : null;
  const messageRaw = arr.find((p) => p !== signerEntry) ?? '';
  return {messageRaw, signer};
}

/** The review text for a personal_sign message: a hex string decodes to text when printable
 *  (hex kept as the exact sign source), a raw string is shown as-is (signed as its UTF-8 bytes),
 *  anything else is JSON for the review and refused at sign time by the string check. */
function decodeMessage(raw: unknown): {text: string | null; hex: string | null} {
  if (typeof raw !== 'string') {
    return {text: null, hex: null};
  }
  if (/^0x([0-9a-fA-F]{2})*$/.test(raw)) {
    const text = utf8Printable(hexToBytes(raw));
    return {text, hex: raw};
  }
  return {text: raw, hex: null};
}

/** A typed-data display row: strings/numbers verbatim, nested structures JSON. */
function fieldRow(name: string, v: unknown): WcFieldRow {
  const value = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v) ?? '';
  return [name, value] as const;
}

function fieldRows(obj: Readonly<Record<string, unknown>>): readonly WcFieldRow[] {
  return Object.entries(obj).map(([k, v]) => fieldRow(k, v));
}

/** Parse + FULLY validate an eth_signTypedData_v4 payload: the EIP-712 encoder's own refusal
 *  (typedDataDigest) is the parse - a payload that cannot hash cannot be reviewed, and it can
 *  never reach signTypedData. Returns the parsed data for the approve path. */
function parseTypedData(raw: unknown): {data: TypedData; malformed: null} | {data: null; malformed: string} {
  let json: unknown = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      return {data: null, malformed: 'not JSON'};
    }
  }
  if (typeof json !== 'object' || json === null) return {data: null, malformed: 'not an object'};
  const d = json as Partial<TypedData>;
  if (d.types === undefined || typeof d.types !== 'object') return {data: null, malformed: 'types missing'};
  if (typeof d.primaryType !== 'string') return {data: null, malformed: 'primaryType missing'};
  if (typeof d.domain !== 'object' || d.domain === null) return {data: null, malformed: 'domain missing'};
  if (typeof d.message !== 'object' || d.message === null) return {data: null, malformed: 'message missing'};
  const data = d as TypedData;
  try {
    typedDataDigest(data);
    return {data, malformed: null};
  } catch (e) {
    const detail = isTypedDataError(e) ? (e as {message: string}).message : 'not EIP-712 data';
    return {data: null, malformed: detail};
  }
}

/** The eth_sendTransaction request object (the params are an array of one, or the object). */
function txParams(params: unknown): Record<string, string | null> | null {
  const raw = paramsArray(params)[0];
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof t[k] === 'string' ? (t[k] as string) : null);
  return {
    from: str('from'),
    to: str('to'),
    value: str('value'),
    data: str('data') ?? str('input'),
    gas: str('gas') ?? str('gasLimit'),
    gasPrice: str('gasPrice'),
    maxFeePerGas: str('maxFeePerGas'),
    maxPriorityFeePerGas: str('maxPriorityFeePerGas'),
    nonce: str('nonce'),
    chainId: str('chainId'),
  };
}

// ERC-20 `transfer(address,uint256)`, ERC-20 `approve(address,uint256)`, EIP-2612
// `permit(address,uint256,uint256,uint8,bytes32,bytes32)` - the shapes dpay's own rail knows.
const ERC20_TRANSFER_SELECTOR = 'a9059cbb';
const ERC20_APPROVE_SELECTOR = '095ea7b3';
const EIP2612_PERMIT_SELECTOR = 'd505accf';

/** Decode calldata the review can structure: the two ERC-20 actions and EIP-2612 permit render
 *  as labeled rows; ANYTHING else (selector unknown, args short) is `known: false` - the sheet
 *  then shows the raw hex behind the explicit unknown-call warning. Never guesses. */
export function decodeEvmCallData(data: string): {rows: readonly WcCallRow[]; known: boolean} {
  const hex = data.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]*$/.test(hex) || hex.length < 8) return {rows: [], known: false};
  const selector = hex.slice(0, 8);
  const args = hex.slice(8);
  const word = (i: number): string | null => {
    const w = args.slice(i * 64, (i + 1) * 64);
    return w.length === 64 && /^[0-9a-f]+$/.test(w) ? w : null;
  };
  const addressOf = (w: string): string => `0x${w.slice(24)}`;
  const uintOf = (w: string): bigint => BigInt(`0x${w}`);
  const w0 = word(0);
  if (w0 == null) return {rows: [], known: false};
  if (selector === ERC20_TRANSFER_SELECTOR || selector === ERC20_APPROVE_SELECTOR) {
    const amount = word(1);
    if (amount == null) return {rows: [], known: false};
    return {
      rows: [
        {key: selector === ERC20_TRANSFER_SELECTOR ? 'to' : 'spender', value: addressOf(w0)},
        {key: 'amount', value: uintOf(amount).toString(10)},
      ],
      known: true,
    };
  }
  if (selector === EIP2612_PERMIT_SELECTOR) {
    const w1 = word(1);
    const w2 = word(2);
    const w3 = word(3);
    if (w1 == null || w2 == null || w3 == null) return {rows: [], known: false};
    const deadline = uintOf(w3);
    // A sane unix-seconds deadline renders as a date; anything else stays the raw number.
    const deadlineText = deadline > 1_000_000_000n ? formatMonthDayYear(new Date(Number(deadline) * 1000)) : deadline.toString(10);
    return {
      rows: [
        {key: 'owner', value: addressOf(w0)},
        {key: 'spender', value: addressOf(w1)},
        {key: 'value', value: uintOf(w2).toString(10)},
        {key: 'deadline', value: deadlineText},
      ],
      known: true,
    };
  }
  return {rows: [], known: false};
}

// --- the Solana branch (plan Track S) ---------------------------------------------------------------

/** The Solana methods this sheet IMPLEMENTS - the honest bound the namespace approval may never
 *  exceed (the advertised<=implemented law; the conformance suite pins advertised == this ==
 *  SOLANA_V1_METHODS). `solana_signAllTransactions` is deliberately absent (batches are outside
 *  v1; wcDecode.ts SOLANA_METHODS_OUTSIDE_V1 carries the plan's reason). */
export const SOLANA_IMPLEMENTED_METHODS = [
  'solana_getAccounts',
  'solana_requestAccounts',
  'solana_signMessage',
  'solana_signTransaction',
  'solana_signAndSendTransaction',
] as const;

/** solana_signMessage params: the documented shape is `{pubkey, message}` (both base58); a
 *  two-string array is read as `[pubkey, message]`, a single string as the bare message. */
function solanaSignMessageParams(params: unknown): {pubkey: string | null; messageB58: string | null} {
  const arr = paramsArray(params);
  const first = arr[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as Record<string, unknown>;
    return {
      pubkey: typeof o.pubkey === 'string' ? o.pubkey : null,
      messageB58: typeof o.message === 'string' ? o.message : null,
    };
  }
  if (arr.length >= 2 && typeof arr[0] === 'string' && typeof arr[1] === 'string') {
    return {pubkey: arr[0], messageB58: arr[1]};
  }
  if (arr.length === 1 && typeof arr[0] === 'string') return {pubkey: null, messageB58: arr[0]};
  return {pubkey: null, messageB58: null};
}

/** solana_signTransaction / signAndSendTransaction params: `{transaction}` base64 (canonical;
 *  a `message` string is accepted as the same bytes). The instruction-array shape is deprecated
 *  upstream and not our contract - detected by name so the refusal is explicit, never a parse
 *  accident. */
function solanaTxParams(params: unknown): {txB64: string | null; claimedFeePayer: string | null; instructionArray: boolean} {
  const first = paramsArray(params)[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as Record<string, unknown>;
    if (Array.isArray(o.instructions)) return {txB64: null, claimedFeePayer: null, instructionArray: true};
    return {
      txB64: typeof o.transaction === 'string' ? o.transaction : typeof o.message === 'string' ? o.message : null,
      claimedFeePayer: typeof o.feePayer === 'string' ? o.feePayer : null,
      instructionArray: false,
    };
  }
  if (typeof first === 'string') return {txB64: first, claimedFeePayer: null, instructionArray: false};
  return {txB64: null, claimedFeePayer: null, instructionArray: false};
}

/** The venue-neutral review rows for the decoded instructions (never a guess: the raw fallback
 *  renders program + data hex behind the unknown warning). Native SOL amounts render in SOL (the
 *  9-decimals split is protocol constant); SPL amounts in the mint's decimals when the wire names
 *  them (transferChecked), raw units otherwise. */
export function solanaTxRows(instructions: readonly WcSolanaInstruction[]): readonly WcSolanaRow[] {
  const rows: WcSolanaRow[] = [];
  for (const ix of instructions) {
    switch (ix.kind) {
      case 'systemTransfer':
        rows.push({key: 'from', value: ix.from}, {key: 'to', value: ix.to}, {key: 'amount', value: `${rawToDecimal(ix.lamports.toString(10), 9)} SOL`});
        break;
      case 'splTransfer':
        rows.push({key: 'from', value: ix.source}, {key: 'to', value: ix.destination}, {key: 'owner', value: ix.owner}, {key: 'amount', value: tokenAmount(ix.amount.toString(10))});
        break;
      case 'splTransferChecked':
        rows.push({key: 'from', value: ix.source}, {key: 'to', value: ix.destination}, {key: 'owner', value: ix.owner}, {key: 'mint', value: ix.mint}, {key: 'amount', value: rawToDecimal(ix.amount.toString(10), ix.decimals)});
        break;
      case 'memo':
        rows.push({key: 'memo', value: ix.text ?? ix.dataHex});
        break;
      case 'unknown':
        rows.push({key: 'program', value: ix.programId ?? M.pay.wc.lookupTableProgram}, {key: 'data', value: ix.dataHex});
        break;
    }
  }
  return rows;
}

/** Build the solanaTx review from the request's params (pure; the approve path re-reads the same
 *  fields). Malformed bytes keep the sheet open behind the raw display + warning - the EVM
 *  unknown-calldata law - and approve re-refuses with a typed error. */
function solanaTxReview(params: unknown, chain: string, method: string, solanaAddress: string | null): WcRequestSummary {
  const {txB64, claimedFeePayer, instructionArray} = solanaTxParams(params);
  if (instructionArray) {
    // The deprecated upstream shape: refused by name before any sheet (plan §2.4).
    return {method, chain, review: {kind: 'unsupported', method: `${method} (instruction-array shape)`}};
  }
  const malformed = (reason: string): WcRequestSummary => ({
    method,
    chain,
    review: {
      kind: 'solanaTx', send: method === 'solana_signAndSendTransaction', feePayer: null, signers: [],
      externalFeePayer: false, deviceSigns: false, coSigned: false,
      feePayerHidden: claimedFeePayer != null,
      rows: [], unknown: true, malformed: reason,
      rawBase64: typeof txB64 === 'string' ? txB64 : '',
    },
  });
  if (txB64 == null) return malformed('no transaction in the request');
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(txB64);
  } catch {
    return malformed('not valid base64');
  }
  const decoded = decodeWcSolanaTx(bytes);
  if (decoded == null) return malformed('undecodable transaction');
  const deviceSigns = solanaAddress != null && decoded.signers.includes(solanaAddress);
  return {
    method,
    chain,
    review: {
      kind: 'solanaTx',
      send: method === 'solana_signAndSendTransaction',
      feePayer: decoded.feePayer,
      signers: [...decoded.signers],
      externalFeePayer: solanaAddress == null || decoded.feePayer !== solanaAddress,
      deviceSigns,
      coSigned: decoded.requiredSignatures > 1,
      // A params feePayer that names a different payer than the wire hides the real one - the
      // display would lie, so the request is refused rather than shown dishonestly.
      feePayerHidden: claimedFeePayer != null && claimedFeePayer !== decoded.feePayer,
      rows: solanaTxRows(decoded.instructions),
      unknown: decoded.hasUnknown,
      malformed: null,
      rawBase64: txB64,
    },
  };
}

// --- the request summarizer (review model) ----------------------------------------------------------
/** The chain the request names, else the session's active chain (plan W1 step 3: chainId
 *  defaults from session state). */
function chainOf(request: WcRequest, activeChain: string): string {
  const c: unknown = (request.params as {chainId?: unknown} | undefined)?.chainId;
  return typeof c === 'string' && c !== '' ? c : activeChain;
}

function signerMismatchOf(signer: string | null, evmAddress: string): boolean {
  return signer != null && signer.toLowerCase() !== evmAddress.toLowerCase();
}

/** Turn a raw session request into the review model the sheet renders (and the approve path
 *  re-reads). Pure, total, never throws - a payload it cannot structure becomes an honest
 *  `unsupported`/`malformed` variant the handler refuses with a typed error. `solanaAddress` is
 *  the wallet's solana identity (null = none): every solana review names the device's relation to
 *  the request (fee payer, required signer) against it. */
export function summarizeWcRequest(request: WcRequest, ctx: {activeChain: string; evmAddress: string; solanaAddress?: string | null}): WcRequestSummary {
  const method: string = (request.params as {request?: {method?: unknown}} | undefined)?.request?.method as string | undefined ?? '';
  const chain = chainOf(request, ctx.activeChain);
  const params: unknown = (request.params as {request?: {params?: unknown}} | undefined)?.request?.params;
  const solanaAddress = ctx.solanaAddress ?? null;
  switch (method) {
    case 'personal_sign': {
      const {messageRaw, signer} = personalSignParams(params);
      const {text, hex} = decodeMessage(messageRaw);
      return {method, chain, review: {kind: 'message', text, hex, signerMismatch: signerMismatchOf(signer, ctx.evmAddress)}};
    }
    case 'eth_signTypedData_v4': {
      const arr = paramsArray(params);
      const jsonEntry = arr.find((p) => typeof p === 'string' ? p.trimStart().startsWith('{') : typeof p === 'object' && p !== null);
      const addrEntry = arr.find((p) => addressLike(p) != null);
      const parsed = parseTypedData(jsonEntry);
      const domain = parsed.data != null ? fieldRows(parsed.data.domain) : [];
      const message = parsed.data != null ? fieldRows(parsed.data.message) : [];
      return {
        method,
        chain,
        review: {
          kind: 'typedData',
          domain,
          primaryType: parsed.data?.primaryType ?? '',
          message,
          data: parsed.data,
          malformed: parsed.malformed,
          signerMismatch: signerMismatchOf(addrEntry != null ? (addressLike(addrEntry) as string) : null, ctx.evmAddress),
        },
      };
    }
    case 'eth_sendTransaction': {
      const tx = txParams(params);
      if (tx == null || tx.to == null) {
        // No recipient = contract creation: not on the v1 surface, refused by name.
        return {method, chain, review: {kind: 'unsupported', method: 'eth_sendTransaction (contract creation)'}};
      }
      const data = tx.data ?? '';
      const decoded = decodeEvmCallData(data);
      const paramChain = tx.chainId != null && /^0x[0-9a-fA-F]+$/.test(tx.chainId) ? Number(BigInt(tx.chainId)) : null;
      const envelopeChainId = Number(chainHexOf(chain).slice(2));
      const chainDivergence =
        tx.chainId != null && paramChain == null
          ? 'chainId is not a hex quantity'
          : paramChain != null && paramChain !== envelopeChainId
            ? `chainId ${paramChain} does not match the session chain ${envelopeChainId}`
            : null;
      return {
        method,
        chain,
        review: {
          kind: 'tx',
          to: tx.to,
          valueWei: tx.value != null && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value).toString(10) : null,
          data,
          rows: decoded.rows,
          unknownCall: !decoded.known,
          chainId: paramChain,
          chainDivergence,
          signerMismatch: signerMismatchOf(tx.from, ctx.evmAddress),
        },
      };
    }
    case 'wallet_switchEthereumChain': {
      const raw = paramsArray(params)[0] as {chainId?: unknown} | string | undefined;
      const cid = typeof raw === 'object' && raw !== null ? raw.chainId : raw;
      const n = typeof cid === 'string' && /^0x[0-9a-fA-F]+$/.test(cid) ? Number(BigInt(cid)) : NaN;
      return {method, chain, review: {kind: 'switchChain', chain: Number.isNaN(n) ? chain : `eip155:${n}`, wired: WIRED_CHAIN_IDS.includes(n)}};
    }
    case 'solana_signMessage': {
      const {pubkey, messageB58} = solanaSignMessageParams(params);
      let bytes: Uint8Array | null = null;
      try {
        bytes = messageB58 != null ? bs58.decode(messageB58) : null;
      } catch {
        bytes = null; // not base58: the review shows nothing to sign and approve refuses typed
      }
      return {
        method,
        chain,
        review: {
          kind: 'solanaMessage',
          text: bytes != null ? utf8Printable(bytes) : null,
          hex: bytes != null ? bytesToHex(bytes) : null,
          signerMismatch: pubkey != null && solanaAddress != null && pubkey !== solanaAddress,
        },
      };
    }
    case 'solana_signTransaction':
    case 'solana_signAndSendTransaction':
      return solanaTxReview(params, chain, method, solanaAddress);
    default: {
      // An explicitly excluded Solana method (e.g. solana_signAllTransactions) is refused BY NAME
      // with the plan's reason attached - it is never advertised, and a stray request meets an
      // honest refusal, not a generic unknown.
      const outside = SOLANA_METHODS_OUTSIDE_V1.find((m) => m.method === method);
      return {method, chain, review: {kind: 'unsupported', method: outside != null ? `${method} (${outside.reason})` : method}};
    }
  }
}

// --- display helpers --------------------------------------------------------------------------------

/** 'eip155:1' -> 'Ethereum', the Solana mainnet id -> 'Solana'; an unknown CAIP-2 id renders as
 *  itself. */
export function wcChainName(caip: string): string {
  if (/^solana:/.test(caip)) return 'Solana';
  const m = /^eip155:(\d+)$/.exec(caip);
  const n = m ? Number(m[1]) : NaN;
  return EVM_CHAINS[n as EvmChainId]?.name ?? caip;
}

/** 'eip155:1' -> '0x1' - the eth_chainId answer shape. */
export function chainHexOf(caip: string): string {
  const m = /^eip155:(\d+)$/.exec(caip);
  return m ? `0x${Number(m[1]).toString(16)}` : '0x0';
}

// --- the approve / reject paths ---------------------------------------------------------------------

export interface WcApproveOutcome {
  /** eth_sendTransaction: the hash the network accepted - SUBMITTED, NOT SETTLED. */
  readonly submittedHash: string | null;
  /** wallet_switchEthereumChain: the CAIP-2 chain the session moved to. */
  readonly switchedTo: string | null;
}

export interface WcApproveArgs {
  readonly request: WcRequest;
  readonly secretHex: string;
  readonly evmAddress: string;
  /** The wallet's solana address (the device seed's m/44'/501' key), null when the wallet has no
   *  solana identity: every solana branch refuses typed rather than sign blind. */
  readonly solanaAddress: string | null;
  /** The session's active CAIP-2 chain (the caller's map; chainId defaults come from it). */
  readonly activeChain: string;
  /** The SDK's UNSUPPORTED_CHAINS error (Wallet passes `walletkit.wcUnsupportedChains()`). */
  readonly unsupportedChains: WcSdkError;
  readonly respond: (topic: string, response: WcResponse) => Promise<void>;
}

function respondError(args: WcApproveArgs, code: number, message: string): Promise<void> {
  return args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', error: {code, message}});
}

/** Approve one reviewed request: build the response per method and answer the dApp. This is the
 *  ONLY code that turns a sheet button press into a dApp-visible result. Refusals that are
 *  properties of the REQUEST (a different signer, malformed typed data, an unwired chain, an
 *  unsupported method) answer with typed JSON-RPC errors; RPC/transport failures THROW (the
 *  sheet stays open with the error and the user still holds Reject). */
export async function approveWcRequest(args: WcApproveArgs): Promise<WcApproveOutcome> {
  const summary = summarizeWcRequest(args.request, {activeChain: args.activeChain, evmAddress: args.evmAddress, solanaAddress: args.solanaAddress});
  const kp = deriveEvmKeypair(args.secretHex);
  switch (summary.review.kind) {
    case 'message': {
      if (summary.review.signerMismatch) {
        await respondError(args, -32603, 'Request asks a different address to sign');
        return NO_OUTCOME;
      }
      // Re-refused at sign time (the handler gates the sheet, approve is the last gate): a
      // message that decodes to nothing is never signed as empty bytes.
      if (summary.review.hex != null ? hexToBytes(summary.review.hex).length === 0 : (summary.review.text ?? '').length === 0) {
        await respondError(args, -32603, 'Malformed personal_sign: no message');
        return NO_OUTCOME;
      }
      // The EXACT bytes the dApp sent: hex when it sent hex, UTF-8 when it sent a string.
      const message = summary.review.hex != null ? hexToBytes(summary.review.hex) : fullUtf8Bytes(summary.review.text ?? '');
      const sig = signPersonal(kp.privateKey, message);
      await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: `0x${bytesToHex(sig.serialized)}`});
      return NO_OUTCOME;
    }
    case 'typedData': {
      if (summary.review.malformed != null) {
        // Never raw-sign a payload that cannot hash as EIP-712 (the plan's hard rule).
        await respondError(args, -32603, `Malformed typed data: ${summary.review.malformed}`);
        return NO_OUTCOME;
      }
      if (summary.review.signerMismatch || summary.review.data == null) {
        await respondError(args, -32603, 'Request asks a different address to sign');
        return NO_OUTCOME;
      }
      const sig = signTypedData(kp.privateKey, summary.review.data);
      await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: sig.serialized});
      return NO_OUTCOME;
    }
    case 'tx': {
      if (summary.review.signerMismatch) {
        await respondError(args, -32603, 'Request asks a different account to send');
        return NO_OUTCOME;
      }
      const hash = await broadcastFilledTx(args, summary.review, kp.privateKey);
      await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: hash});
      return {submittedHash: hash, switchedTo: null};
    }
    case 'switchChain': {
      if (summary.review.wired) {
        await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: null});
        return {submittedHash: null, switchedTo: summary.review.chain};
      }
      await respondError(args, args.unsupportedChains.code, args.unsupportedChains.message);
      return NO_OUTCOME;
    }
    case 'solanaMessage': {
      if (args.solanaAddress == null) {
        await respondError(args, -32603, 'No Solana account');
        return NO_OUTCOME;
      }
      const messageBytes = summary.review.hex != null ? hexToBytes(summary.review.hex) : null;
      if (messageBytes == null) {
        await respondError(args, -32603, 'Malformed Solana message');
        return NO_OUTCOME;
      }
      if (summary.review.signerMismatch) {
        await respondError(args, -32603, 'Request asks a different Solana address to sign');
        return NO_OUTCOME;
      }
      // Plain ed25519 over the EXACT bytes the dApp sent (base58 in, base58 out - plan §2.4).
      const seed = deriveSolanaKeypair(args.secretHex).seed;
      const sig = ed25519.sign(messageBytes, seed);
      await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: {signature: bs58.encode(sig)}});
      return NO_OUTCOME;
    }
    case 'solanaTx': {
      if (args.solanaAddress == null) {
        await respondError(args, -32603, 'No Solana account');
        return NO_OUTCOME;
      }
      if (summary.review.malformed != null) {
        await respondError(args, -32603, `Malformed transaction: ${summary.review.malformed}`);
        return NO_OUTCOME;
      }
      if (summary.review.feePayerHidden) {
        await respondError(args, -32603, 'Request names a different fee payer than the transaction');
        return NO_OUTCOME;
      }
      if (!summary.review.deviceSigns) {
        // The displayed-else-refuse law, refusal half: a tx this wallet need not sign is not a
        // tx it signs (sponsored or third-party-owned flows refuse whole).
        await respondError(args, -32603, 'This wallet is not a required signer of the transaction');
        return NO_OUTCOME;
      }
      if (summary.review.coSigned) {
        // DEFAULT refusal (never silently co-sign): a tx needing other signatures is refused
        // whole - the device's slot would otherwise be written into someone else's ceremony.
        await respondError(args, -32603, 'Transaction needs other signers');
        return NO_OUTCOME;
      }
      const solKp = deriveSolanaKeypair(args.secretHex);
      // signVenueSwapTx with DEFAULT options re-checks both guards above at the byte level
      // (defense in depth) and writes ONLY the device's slot, every other byte preserved.
      const signed = signVenueSwapTx(base64ToBytes(summary.review.rawBase64), solKp.seed);
      if (signed == null) {
        await respondError(args, -32603, 'Transaction refused');
        return NO_OUTCOME;
      }
      if (!summary.review.send) {
        // solana_signTransaction: the serialized signed tx back, base64, canonical. NO broadcast.
        await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: bytesToBase64(signed.raw)});
        return NO_OUTCOME;
      }
      // solana_signAndSendTransaction: broadcast through the app's OWN send path (the relay
      // pipe's broadcast posture). The returned signature is SUBMITTED, not settled - no receipt
      // poll here (the dApp can poll; dpay's own sends keep theirs).
      const sol = await import('../solana');
      const sig58 = await sol.submitRawSolTx(signed.raw);
      await args.respond(args.request.topic, {id: args.request.id, jsonrpc: '2.0', result: sig58});
      return {submittedHash: sig58, switchedTo: null};
    }
    default:
      await respondError(args, -32601, `Unsupported method: ${summary.review.method}`);
      return NO_OUTCOME;
  }
}

/** Param-fill + sign + broadcast one approved transaction through the relay's EVM proxy (the
 *  SAME pipe the send path uses): nonce/fee/gas filled from the chain when the dApp omitted
 *  them, chainId from the request else the session chain, EIP-1559 unless the dApp set gasPrice
 *  (then legacy). Returns OUR hash (keccak of the signed bytes) - submitted, not settled; no
 *  receipt poll on this path. */
async function broadcastFilledTx(args: WcApproveArgs, tx: Extract<WcReview, {kind: 'tx'}>, privateKey: Uint8Array): Promise<string> {
  // BigInt parses the hex quantity ('0x7a69' -> 31337); Number alone would read the hex digits
  // as decimal and NaN on any chain id carrying a hex letter (Arbitrum 0xa4b1, anvil 0x7a69).
  const chainId = tx.chainId ?? Number(BigInt(chainHexOf(chainOf(args.request, args.activeChain))));
  const urls = evmRpcUrls(chainId);
  if (urls[0] === '') throw new Error(`EVM is not configured (chain ${chainId})`);
  const to = tx.to as string;
  const valueWei = tx.valueWei != null ? BigInt(tx.valueWei) : 0n;
  const dataBytes = tx.data !== '' ? hexToBytes(tx.data) : undefined;

  // The wrong-chain guard (D10/D12): the endpoint must PROVE its chain identity before anything
  // spend-shaped happens - the same gate dpay's own sends pass.
  const service = await import('../evm/service');
  await service.ensureChain(chainId, urls);
  const rpc = await import('../evm/rpc');

  const gasGiven = txGasField(args, 'gas');
  const gasLimit = gasGiven ?? await estimateGasWithHeadroom(rpc, urls, args.evmAddress, to, tx.data, valueWei);
  // The tx builder's nonce field is a number (nonces are small; the send path does the same).
  const nonceRaw = txGasField(args, 'nonce') ?? BigInt(await rpc.ethGetTransactionCount(urls, args.evmAddress));
  const nonce = Number(nonceRaw);

  const price = txGasField(args, 'gasPrice');
  const signed = price != null
    ? signLegacyTx({chainId, nonce, gasPrice: price, gasLimit, to, value: valueWei, data: dataBytes}, privateKey)
    : await signEip1559Filled(rpc, urls, args, privateKey, gasLimit, nonce, to, valueWei, dataBytes, chainId);

  const localHash = toHex0x(signed.txHash);
  const accepted = await rpc.ethSendRawTransaction(urls, toHex0x(signed.raw));
  // The node's hash for OUR bytes must BE our hash - a mismatch is not a verdict (the signed
  // bytes are valid); the send path's discipline verbatim.
  if (accepted.toLowerCase() !== localHash.toLowerCase()) {
    console.warn(`wc send: node answered ${accepted} for locally-signed ${localHash}`);
  }
  return localHash;
}

/** One request gas field (gas/gasLimit, nonce, gasPrice, maxFeePerGas, maxPriorityFeePerGas),
 *  parsed as a JSON-RPC hex quantity or null when absent. */
function txGasField(args: WcApproveArgs, key: 'gas' | 'nonce' | 'gasPrice' | 'maxFeePerGas' | 'maxPriorityFeePerGas'): bigint | null {
  const params = txParams((args.request.params as {request?: {params?: unknown}} | undefined)?.request?.params);
  const raw = params != null ? params[key] : null;
  if (raw == null) return null;
  if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`Request carried a malformed ${key}`);
  return BigInt(raw);
}

/** The chain's own gas arithmetic over the reviewed inputs, +20% headroom +1 (the send path's
 *  formula): a pending-state shift between estimate and inclusion must not kill a valid tx. */
async function estimateGasWithHeadroom(
  rpc: typeof import('../evm/rpc'),
  urls: readonly string[],
  from: string,
  to: string,
  data: string,
  valueWei: bigint,
): Promise<bigint> {
  const est = BigInt(await rpc.ethEstimateGas(urls, {
    from,
    to,
    data: data !== '' ? data : undefined,
    value: valueWei > 0n ? `0x${valueWei.toString(16)}` : undefined,
  }));
  return est + (est * 20n) / 100n + 1n;
}

/** EIP-1559 fees: the dApp's maxFee/maxPriority when both are present, else the chain's own
 *  arithmetic (priority-fee suggestion or 0, base fee x2 + priority - the send path's formula).
 *  A one-sided request fills BOTH from the chain rather than mixing a dApp number with a live
 *  one (an incoherent fee pair is how sends get stuck). */
async function signEip1559Filled(
  rpc: typeof import('../evm/rpc'),
  urls: readonly string[],
  args: WcApproveArgs,
  privateKey: Uint8Array,
  gasLimit: bigint,
  nonce: number,
  to: string,
  valueWei: bigint,
  dataBytes: Uint8Array | undefined,
  chainId: number,
): Promise<ReturnType<typeof signEip1559Tx>> {
  const givenMaxFee = txGasField(args, 'maxFeePerGas');
  const givenPriority = txGasField(args, 'maxPriorityFeePerGas');
  let maxFee: bigint;
  let priority: bigint;
  if (givenMaxFee != null && givenPriority != null) {
    maxFee = givenMaxFee;
    priority = givenPriority;
  } else {
    const priorityHex = await rpc.ethMaxPriorityFeePerGas(urls);
    priority = priorityHex === null ? 0n : BigInt(priorityHex);
    const baseFee = BigInt(await rpc.ethGasPrice(urls));
    maxFee = baseFee * 2n + priority;
  }
  return signEip1559Tx(
    {chainId, nonce, maxPriorityFeePerGas: priority, maxFeePerGas: maxFee, gasLimit, to, value: valueWei, data: dataBytes},
    privateKey,
  );
}

/** Reject a reviewed request - the sheet's Reject button and NOTHING else. Answers with the
 *  SDK's USER_REJECTED (5000) the caller passed in (the seam law: no WC imports here). */
export async function rejectWcRequest(request: WcRequest, userRejected: WcSdkError, respond: (topic: string, response: WcResponse) => Promise<void>): Promise<void> {
  await respond(request.topic, {id: request.id, jsonrpc: '2.0', error: userRejected});
}

// --- the request/proposal handler factories (the one-review-at-a-time law) ---------------------------

export interface WcRequestHandlerDeps {
  readonly evmAddress: string;
  /** The wallet's solana address, null when there is no solana identity: solana reads refuse
   *  typed (never an empty success) and solana signing requests never open the sheet. */
  readonly solanaAddress: string | null;
  /** True while the sheet shows anything (proposal or request). */
  readonly isOpen: () => boolean;
  /** The session's active chain for a topic (the caller's map, seeded at approve). */
  readonly activeChainOf: (topic: string) => string;
  readonly respond: (topic: string, response: WcResponse) => Promise<void>;
  /** The SDK's USER_REJECTED error (Wallet passes `walletkit.wcUserRejected()`). */
  readonly userRejected: WcSdkError;
  readonly openRequest: (request: WcRequest) => void;
}

/** The `session_request` dispatch (plan W1 step 3 + Track S):
 *  1. eth_accounts / eth_chainId answer DIRECTLY from the paired session state - read-only, no
 *     UI (the plan's explicit decision); solana_getAccounts / solana_requestAccounts are the
 *     solana reads and answer the same way (no identity = a typed refusal, never an empty
 *     success);
 *  2. any other request while the sheet is open answers USER_REJECTED 5000 immediately - ONE
 *     review at a time in v1, nothing queues;
 *  3. an unsupported method (solana_signAllTransactions among them, by name), a malformed
 *     typed-data payload, or a solana signing request with no solana identity answers a typed
 *     error without opening the sheet (fail closed, never raw-sign);
 *  4. everything else opens the review sheet - the only path to an approve. */
export function makeWcRequestHandler(deps: WcRequestHandlerDeps): (request: WcRequest) => void {
  const safeRespond = (topic: string, response: WcResponse): Promise<void> =>
    deps.respond(topic, response).catch((e: unknown) => {
      console.warn(`wc respond failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  return (request) => {
    const method: string = (request.params as {request?: {method?: unknown}} | undefined)?.request?.method as string | undefined ?? '';
    if (method === 'eth_accounts') {
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', result: [deps.evmAddress]});
      return;
    }
    if (method === 'eth_chainId') {
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', result: chainHexOf(deps.activeChainOf(request.topic))});
      return;
    }
    if (method === 'solana_getAccounts' || method === 'solana_requestAccounts') {
      if (deps.solanaAddress == null) {
        void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32603, message: 'No Solana account'}});
      } else {
        void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', result: [deps.solanaAddress]});
      }
      return;
    }
    if (deps.isOpen()) {
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: deps.userRejected});
      return;
    }
    if (method === 'solana_signMessage' || method === 'solana_signTransaction' || method === 'solana_signAndSendTransaction') {
      if (deps.solanaAddress == null) {
        // No solana identity: refuse typed BEFORE any sheet - the wallet cannot sign these, and
        // an approve button that can only refuse is not a review.
        void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32603, message: 'No Solana account'}});
        return;
      }
    }
    const summary = summarizeWcRequest(request, {activeChain: deps.activeChainOf(request.topic), evmAddress: deps.evmAddress, solanaAddress: deps.solanaAddress});
    if (summary.review.kind === 'unsupported') {
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32601, message: `Unsupported method: ${summary.review.method}`}});
      return;
    }
    if (summary.review.kind === 'typedData' && summary.review.malformed != null) {
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32603, message: `Malformed typed data: ${summary.review.malformed}`}});
      return;
    }
    if (summary.review.kind === 'tx' && summary.review.chainDivergence != null) {
      // The reviewed chain must BE the chain the bytes move on: a tx naming another chain is
      // refused typed, never shown behind a review of the session's chain.
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32603, message: `Wrong chain in request: ${summary.review.chainDivergence}`}});
      return;
    }
    if (summary.review.kind === 'message' && (summary.review.hex != null ? hexToBytes(summary.review.hex).length === 0 : (summary.review.text ?? '').length === 0)) {
      // A message that decodes to nothing (non-string params, message==signer collapse, 0x) is
      // malformed, not signable: never empty-byte-sign on approve.
      void safeRespond(request.topic, {id: request.id, jsonrpc: '2.0', error: {code: -32603, message: 'Malformed personal_sign: no message'}});
      return;
    }
    deps.openRequest(request);
  };
}

export interface WcProposalHandlerDeps {
  readonly isOpen: () => boolean;
  readonly open: (proposal: WcProposal) => void;
  readonly reject: (proposal: WcProposal) => Promise<void>;
}

/** The `session_proposal` dispatch: the sheet shows one connection ask at a time; a proposal
 *  arriving while it is open is refused with rejectSession (the SDK's USER_REJECTED 5000). */
export function makeWcProposalHandler(deps: WcProposalHandlerDeps): (proposal: WcProposal) => void {
  return (proposal) => {
    if (deps.isOpen()) {
      void deps.reject(proposal).catch((e: unknown) => {
        console.warn(`wc proposal reject failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }
    deps.open(proposal);
  };
}

// --- requester extractors ---------------------------------------------------------------------------

export function proposalDapp(proposal: WcProposal): WcSheetDapp {
  const md = (proposal.params as {proposer?: {metadata?: {name?: unknown; url?: unknown}} | undefined} | undefined)?.proposer?.metadata;
  return {name: typeof md?.name === 'string' ? md.name : '', url: typeof md?.url === 'string' ? md.url : ''};
}

export function requestDapp(request: WcRequest): WcSheetDapp {
  const md = (request.params as {requester?: {metadata?: {name?: unknown; url?: unknown}} | undefined} | undefined)?.requester?.metadata;
  return {name: typeof md?.name === 'string' ? md.name : '', url: typeof md?.url === 'string' ? md.url : ''};
}

export function proposalChains(proposal: WcProposal): readonly string[] {
  const namespaces = (proposal.params as {requiredNamespaces?: Record<string, {chains?: unknown}>} | undefined)?.requiredNamespaces;
  const chains: string[] = [];
  for (const ns of ['eip155', 'solana']) {
    const raw = namespaces?.[ns]?.chains;
    if (Array.isArray(raw)) chains.push(...raw.filter((c): c is string => typeof c === 'string'));
  }
  return chains;
}

// --- the sheet --------------------------------------------------------------------------------------

function rowLabel(key: WcCallRowKey): string {
  const wc = M.pay.wc;
  switch (key) {
    case 'to': return wc.toLabel;
    case 'spender': return wc.spenderLabel;
    case 'owner': return wc.ownerLabel;
    case 'amount': return wc.amountLabel;
    case 'value': return wc.amountLabel;
    case 'deadline': return wc.deadlineLabel;
  }
}

/** The venue-neutral Solana row labels (M.pay.wc; the same economy as the EVM rows). */
function solanaRowLabel(key: WcSolanaRowKey): string {
  const wc = M.pay.wc;
  switch (key) {
    case 'from': return wc.fromLabel;
    case 'to': return wc.toLabel;
    case 'owner': return wc.ownerLabel;
    case 'amount': return wc.amountLabel;
    case 'mint': return wc.mintLabel;
    case 'memo': return wc.memoLabel;
    case 'program': return wc.programLabel;
    case 'data': return wc.dataLabel;
  }
}

/** A decoded token amount is shown in RAW units - the sheet has no catalog, so no decimals, and
 *  pretending otherwise would misstate money. The label says so. */
function tokenAmount(raw: string): string {
  return M.pay.wc.rawUnits(raw);
}

export function WcRequestSheet({mode, dapp, chains, summary, chain, busy, err, submittedHash, onApprove, onReject, onDone}: {
  mode: 'proposal' | 'request';
  dapp: WcSheetDapp;
  /** Proposal mode: the chains the dApp asked for. */
  chains: readonly string[];
  /** Request mode: the summarized review (null in proposal mode). */
  summary: WcRequestSummary | null;
  /** Request mode fallback chain when the summary is absent. */
  chain: string;
  busy: boolean;
  err: string | null;
  submittedHash: string | null;
  onApprove: () => void;
  onReject: () => void;
  onDone: () => void;
}) {
  const review = summary?.review ?? null;
  const nativeSymbol = useMemo(() => {
    if (review?.kind !== 'tx') return 'ETH';
    const m = /^eip155:(\d+)$/.exec(summary?.chain ?? '');
    const n = m ? Number(m[1]) : NaN;
    return EVM_CHAINS[n as EvmChainId]?.nativeSymbol ?? 'ETH';
  }, [review, summary]);

  return (
    <AppModal onRequestClose={() => { /* Only the sheet's buttons answer - a dismissed-but-unanswered request would hang the dApp. */ }}>
      <View testID="wc-sheet" style={S.pickCard}>
        <ScrollView style={S.pickScroll}>
          <Text style={S.pickTitle}>{mode === 'proposal' ? M.pay.wc.connectTitle : M.pay.wc.requestTitle}</Text>

          <View style={S.receiptField}>
            <Text style={S.receiptLabel}>{M.pay.wc.appLabel}</Text>
            <Text testID="wc-dapp" style={S.receiptValueSans}>{dapp.name !== '' ? dapp.name : '-'}</Text>
            {dapp.url !== '' ? <Text style={S.dim2}>{dapp.url}</Text> : null}
          </View>

          {mode === 'proposal' ? (
            <>
              <Text style={S.depositStatusTitle}>{M.pay.wc.connectHeadline}</Text>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.chainsLabel}</Text>
                <Text testID="wc-chains" style={S.receiptValueSans}>{chains.length > 0 ? chains.map(wcChainName).join(', ') : '-'}</Text>
              </View>
            </>
          ) : null}

          {review?.kind === 'switchChain' ? (
            <Text style={S.depositStatusTitle}>{M.pay.wc.switchHeadline(wcChainName(review.chain))}</Text>
          ) : null}

          {review != null && review.kind !== 'switchChain' ? (
            <View style={S.receiptField}>
              <Text style={S.receiptLabel}>{M.pay.wc.chainLabel}</Text>
              <Text testID="wc-chain" style={S.receiptValueSans}>{wcChainName(summary?.chain ?? chain)}</Text>
            </View>
          ) : null}

          {review?.kind === 'message' ? (
            <View style={S.receiptField}>
              <Text style={S.receiptLabel}>{M.pay.wc.messageLabel}</Text>
              <Text testID="wc-review-message" style={S.receiptValue} selectable>{review.text ?? review.hex ?? '-'}</Text>
            </View>
          ) : null}

          {review?.kind === 'typedData' ? (
            <>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.domainLabel}</Text>
                {review.domain.map(([k, v]) => (
                  <Text key={`d-${k}`} style={S.receiptValue} selectable>{k}: {v}</Text>
                ))}
              </View>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.typeLabel}</Text>
                <Text testID="wc-review-type" style={S.receiptValueSans}>{review.primaryType}</Text>
              </View>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.fieldsLabel}</Text>
                {review.message.map(([k, v]) => (
                  <Text key={`m-${k}`} testID="wc-review-field" style={S.receiptValue} selectable>{k}: {v}</Text>
                ))}
              </View>
            </>
          ) : null}

          {review?.kind === 'tx' ? (
            <>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.toLabel}</Text>
                <Text testID="wc-review-to" style={S.receiptValue} selectable>{review.to}</Text>
              </View>
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.amountLabel}</Text>
                <Text testID="wc-review-amount" style={S.receiptValueSans}>
                  {review.valueWei != null ? `${rawToDecimal(review.valueWei, 18)} ${nativeSymbol}` : '-'}
                </Text>
              </View>
              {review.rows.length > 0 ? (
                <View style={S.receiptField}>
                  {review.rows.map((r) => (
                    <Text key={r.key} testID="wc-review-call-row" style={S.receiptValue} selectable>
                      {rowLabel(r.key)}: {r.key === 'amount' || r.key === 'value' ? tokenAmount(r.value) : r.value}
                    </Text>
                  ))}
                </View>
              ) : null}
              <View style={S.receiptField}>
                <Text style={S.receiptLabel}>{M.pay.wc.dataLabel}</Text>
                <Text testID="wc-review-data" style={S.receiptValue} selectable>{review.data !== '' ? review.data : '-'}</Text>
              </View>
              {review.unknownCall ? <Text testID="wc-warning" style={S.err}>{M.pay.wc.unknownCall}</Text> : null}
            </>
          ) : null}

          {review?.kind === 'solanaMessage' ? (
            <View style={S.receiptField}>
              <Text style={S.receiptLabel}>{M.pay.wc.messageLabel}</Text>
              <Text testID="wc-review-message" style={S.receiptValue} selectable>{review.text ?? review.hex ?? '-'}</Text>
              {review.text == null ? <Text testID="wc-raw-bytes-note" style={S.receiptNote}>{M.pay.wc.rawBytesNote}</Text> : null}
            </View>
          ) : null}

          {review?.kind === 'solanaTx' ? (
            <>
              {review.malformed != null ? (
                <>
                  <Text testID="wc-warning" style={S.err}>{M.pay.wc.unknownTx}</Text>
                  <View style={S.receiptField}>
                    <Text style={S.receiptLabel}>{M.pay.wc.dataLabel}</Text>
                    <Text testID="wc-review-raw" style={S.receiptValue} selectable>{review.rawBase64 !== '' ? review.rawBase64 : '-'}</Text>
                  </View>
                </>
              ) : (
                <>
                  <View style={S.receiptField}>
                    <Text style={S.receiptLabel}>{M.pay.wc.feePayerLabel}</Text>
                    <Text testID="wc-sol-fee-payer" style={S.receiptValue} selectable>{review.feePayer}</Text>
                    {review.externalFeePayer ? <Text testID="wc-external-fee-payer" style={S.err}>{M.pay.wc.externalFeePayer}</Text> : null}
                  </View>
                  <View style={S.receiptField}>
                    <Text style={S.receiptLabel}>{M.pay.wc.signersLabel}</Text>
                    <Text testID="wc-sol-signers" style={S.receiptValue} selectable>{review.signers.join(', ')}</Text>
                    {review.coSigned ? <Text testID="wc-cosign-note" style={S.err}>{M.pay.wc.coSignNote}</Text> : null}
                    {!review.deviceSigns ? <Text testID="wc-not-signer-note" style={S.err}>{M.pay.wc.notSignerNote}</Text> : null}
                  </View>
                  {review.rows.map((r, i) => (
                    <View key={`${r.key}-${i}`} style={S.receiptField}>
                      <Text style={S.receiptLabel}>{solanaRowLabel(r.key)}</Text>
                      <Text testID="wc-sol-row" style={S.receiptValue} selectable>{r.value}</Text>
                    </View>
                  ))}
                  {review.unknown ? <Text testID="wc-warning" style={S.err}>{M.pay.wc.unknownTx}</Text> : null}
                  {review.send ? <Text testID="wc-broadcast-note" style={S.receiptNote}>{M.pay.wc.broadcastNote}</Text> : null}
                </>
              )}
            </>
          ) : null}

          {submittedHash != null ? (
            <>
              <Text style={S.depositStatusTitle}>{M.pay.wc.submittedTitle}</Text>
              <Text style={S.receiptNote}>{M.pay.wc.submittedNote}</Text>
              <View style={S.receiptField}>
                <Text testID="wc-submitted-hash" style={S.receiptValue} selectable>{submittedHash}</Text>
              </View>
              <Pressable
                testID="btn-wc-done"
                style={S.primaryWide}
                onPress={onDone}
                accessibilityRole="button"
                accessibilityLabel={M.common.done}
                accessibilityState={{disabled: false}}>
                <Text style={S.primaryText}>{M.common.done}</Text>
              </Pressable>
            </>
          ) : (
            <>
              {err != null ? <Text testID="wc-err" style={S.err}>{err}</Text> : null}
              <Pressable
                testID="btn-wc-approve"
                style={[S.primaryWide, busy && S.dim]}
                onPress={onApprove}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={M.pay.wc.approve}
                accessibilityState={{disabled: busy}}>
                {busy ? <ActivityIndicator size="small" color={C.brandInk} /> : <Text style={S.primaryText}>{M.pay.wc.approve}</Text>}
              </Pressable>
              <Pressable
                testID="btn-wc-reject"
                style={S.ghostBtn}
                onPress={onReject}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={M.pay.wc.reject}
                accessibilityState={{disabled: busy}}>
                <Text style={S.ghostBtnText}>{M.pay.wc.reject}</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>
    </AppModal>
  );
}
