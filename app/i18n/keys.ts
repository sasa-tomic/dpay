/**
 * i18n/keys.ts — the SHAPE of the message catalog. This type is the contract every locale must
 * satisfy in full.
 *
 * WHY A TYPE AND NOT A RUNTIME LOOKUP: `const de: Messages = {…}` fails `tsc` if a single key is
 * missing or misspelled, so a half-translated locale cannot be committed, let alone shipped. That
 * makes a runtime fallback (`de.x ?? en.x`) unnecessary — and a fallback is precisely what lets a
 * German screen silently render one English line forever. There is ONE path: the catalog is
 * complete or the build fails. `just typecheck` (inside `just check`) already gates this for free.
 *
 * INTERPOLATION IS A FUNCTION, NEVER A '{{placeholder}}' STRING. A translator needs to move the
 * value within the sentence — German pushes the verb last, Japanese marks the topic first, Arabic
 * reads right-to-left. A typed function lets each locale write its own word order with the
 * arguments applied wherever they belong, and `tsc` checks the arity and types at every call site.
 * It also means no template parser, no format-string DSL, and no new dependency.
 *
 * NO PLURALIZATION MACHINERY. There is no variable-count copy in the app today (the only count is
 * BIP-39's fixed "24 words"), and `Intl.PluralRules` is ABSENT from Hermes — code written against
 * it would pass the headless browser suite and throw on the phone. If variable-count copy is ever
 * introduced, add a per-locale function that takes the count and decides, in that locale's own
 * rules, what to say. Do not reach for a plural library.
 */

import type {DepositMessages, WithdrawMessages} from './domains/en/deposit';
import type {ErrorMessages} from './domains/en/errors';
import type {PayMessages, ReceiveMessages} from './domains/en/pay';
import type {OnboardingMessages, SettingsMessages} from './domains/en/settings';
import type {EducationMessages, WalletMessages} from './domains/en/wallet';
import type {ConvertMessages} from './domains/en/convert';
import type {ReceiptMessages} from './domains/en/receipt';
import type {EvmMessages} from './domains/en/evm';

/**
 * The per-domain contracts, re-exported from the ONE module every locale already imports for
 * `Messages`. A translated domain file writes `import type {PayMessages} from '../../keys'` — it
 * never reaches into `domains/en/`, so no locale depends on another locale's module.
 *
 * The types are DECLARED next to the English values because English is the reference copy (see
 * en.ts): a new key is written once, in the place it is authored, and `tsc` then reports every
 * locale that lacks it.
 */
export type {DepositMessages, WithdrawMessages, InstrRun} from './domains/en/deposit';
export type {ErrorMessages} from './domains/en/errors';
export type {PayMessages, ReceiveMessages} from './domains/en/pay';
export type {OnboardingMessages, SettingsMessages, CopyWordsCopy} from './domains/en/settings';
export type {
  EducationMessages, WalletMessages,
  WalkthroughSceneCopy, CoachTipCopy, PassportStampCopy,
} from './domains/en/wallet';
export type {ConvertMessages} from './domains/en/convert';
export type {ReceiptMessages} from './domains/en/receipt';
export type {EvmMessages} from './domains/en/evm';

/** Title + sub-line for one NFC tap phase, as rendered by the shared tap status view. */
export type NfcPhaseCopy = {title: string; sub: string};

/** The NFC phases that carry copy. Mirrors `NfcTapPhase` in hooks/useNfcTapState. */
export type NfcPhaseKey =
  | 'listening' | 'linking' | 'exchanging' | 'awaitingApproval'
  | 'settling' | 'success' | 'declined' | 'pending' | 'error';

export type Messages = {
  /** Copy that appears on more than one screen. Keep this small — it is not a dumping ground. */
  common: {
    done: string;
    cancel: string;
  };

  /**
   * Relative-day prefixes wrapped around an already-formatted clock time. The TIME ITSELF is built
   * by `Intl.DateTimeFormat` — 12h vs 24h, the separator, and the digits are all the locale's
   * business, and none of them belong in a catalog. Only the word and WHERE IT SITS live here,
   * which is why each takes the finished time rather than returning a bare "Today".
   */
  time: {
    today: (time: string) => string;
    yesterday: (time: string) => string;
  };

  /** The Settings sheet, and the create/restore/backup onboarding flow. */
  settings: SettingsMessages;
  onboarding: OnboardingMessages;

  /** The wallet shell + asset surfaces, and everything that teaches the dpay model. */
  wallet: WalletMessages;
  education: EducationMessages;

  /** The two payment screens on both rails: scan/sign/hand off, and request/scan/confirm. */
  pay: PayMessages;
  receive: ReceiveMessages;

  /** Money in and money out: the "My address" deposit sheets and the "Send to address" sheets. */
  deposit: DepositMessages;
  withdraw: WithdrawMessages;

  /** The delegated-conversion surface (spec 2026-09-07): venue quote, disclosure, §4 states. */
  convert: ConvertMessages;

  /** The transaction receipt — the merchant-reconciliation and dispute surface (X6). */
  receipt: ReceiptMessages;

  /** The EVM rail's screens: receive address + request/settle, pay scan/sign, send with the gas
   *  honesty gate. Chain names and ETH are proper nouns — never translated. */
  evm: EvmMessages;

  nfc: {
    /** Why tap-to-pay is unavailable. Each ends with the honest fallback that QR always works. */
    reason: {off: string; unsupported: string; unknown: string};
    phase: Record<NfcPhaseKey, NfcPhaseCopy>;
    /** Terminal success titles — the payer's phone says "Paid", the merchant's says "Received". */
    paidAmount: (amount: string) => string;
    receivedAmount: (amount: string) => string;
    settled: string;
    /** In-flight sub-line. `network` is null for DEMO (internal) and SOL — no "on …" suffix. */
    paying: (amount: string, network: string | null) => string;
    collecting: (amount: string, network: string | null) => string;
    /** Payer-side nudge while the bundle is on the wire. */
    holdToSend: string;
  };

  /** Decoded ICRC TransferError variants. These name what the LEDGER refused, in the user's terms. */
  rail: {
    insufficientFunds: string;
    badFee: (detail: string) => string;
    badBurn: (detail: string) => string;
    tooOld: string;
    createdInFuture: string;
    temporarilyUnavailable: string;
    declined: (detail: string) => string;
  };

  /** Solana RPC failure classes a user can actually act on. Unknown errors stay verbatim. */
  sol: {
    noRecordOfCredit: string;
    timedOut: string;
    /** The send path's lazily-loaded network module never arrived within its deadline
     *  (solana.ts loadRpcForSend — the served web build fetches `rpc-*.js` as a chunk, and a
     *  stalled origin fetch stalled three live sends there). Actionable: connection + reopen. */
    engineLoad: string;
    insufficient: string;
    rentExempt: string;
    blockhash: string;
    /** Generic tap fallback — the NFC status view never renders a raw exception (A2). */
    tapFailed: string;
  };

  /** Copy that is THROWN and then rendered verbatim (`setErr(e.message)`, the tap status sub-line). */
  errors: ErrorMessages;
};
