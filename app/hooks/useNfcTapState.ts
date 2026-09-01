import {useCallback, useEffect, useRef, useState} from 'react';
import {NativeEventEmitter} from 'react-native';
import {SOL_RECEIPT_WAIT_MS} from '../config/constants';
import {M} from '../i18n';

// The terminal + transitional phases both NFC tap components track. Structurally identical to
// NfcPhaseName / SolNfcPhaseName (plus 'error') — the IC and SOL transports share the
// same status UI, which is precisely why the two components can share this hook. The one-press
// rule (founder directive 2026-08-24) removed the review park: a decoded payable request
// auto-signs, so the card-side 'awaitingApproval' maps to 'exchanging' (the merchant READER
// keeps 'awaitingApproval': its own "Waiting for the payer…" copy).
export type NfcTapPhase =
  | 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling'
  | 'success' | 'declined' | 'pending' | 'error';

// Helpers handed to each adapter's protocol callbacks. `finalize` is the one terminal-settling
// seam: the adapter calls it to drive the shared state machine to a terminal phase. The hook owns
// the first-terminal-wins + teardown guards so an adapter never has to reimplement them.
export type TapCtx = {
  finalize: (phase: NfcTapPhase, reason?: string) => void;
  isCurrent: () => boolean;
};

/**
 * The protocol seam an adapter fills. The hook owns the SHARED lifecycle (refs, `finalize`,
 * `markActive`, the subscribe→arm→cleanup effect, and the `error`/`phase`/`request`/`done`/
 * `payment` event skeleton); the adapter owns ONLY the money-moving logic that genuinely differs
 * per rail and MUST stay separate:
 *   - IC:  prepareTransfer (envelope sign) + /api/v2 submitTransfer + read_state poll + optimistic
 *          balance deduction
 *   - SOL: `signSolPayment`/`signSplPayment` (offline) + RPC broadcast + rid/sig receipt matching
 *
 * `onSubmit` covers BOTH the IC `'done'` event (merchant reassembles + submits the wire) and the
 * SOL `'payment'` event (merchant broadcasts the solpay) — only one fires per rail, so a single
 * slot is correct. The seam event names (`'DpayNfcEvent'` / `'DpaySolNfcEvent'`) and native modules
 * (`DpayNfc` / `DpaySolNfc`, different Kotlin AIDs) are correctly distinct and stay that way.
 */
export type NfcTapAdapter<E> = {
  eventName: string;
  nativeModule: unknown;
  armCard: () => Promise<void>;
  disarmCard: () => Promise<void>;
  startReader: (payload: string) => Promise<void>;
  stopReader: () => Promise<void>;
  waitsForReceipt?: boolean;
  receiptWaitMs?: number;
  onSettling?: () => void;
  onRequest: (e: E, ctx: TapCtx) => void;
  onSubmit: (e: E, ctx: TapCtx) => void;
  onReceipt?: (e: E, ctx: TapCtx) => void;
  onConfirmed?: (e: E, ctx: TapCtx) => void;
};

/**
 * Shared state machine + lifecycle for one NFC tap (IC `NfcTap` + SOL `SolNfcTap`). Owns the phase
 * state, the `finalize`/`markActive`/settle-timer machinery, and the subscribe→arm→cleanup effect.
 * The `error`/`phase`/`request`/`done`/`payment`/`receipt` event dispatch skeleton is shared; each
 * adapter supplies the protocol-specific sign/submit/receipt callbacks (and an optional `onSettling`
 * for the IC-only optimistic deduction). Returns `{phase, reason, activeRef}` for the adapter to
 * render via `<NfcTapView>`.
 */
export function useNfcTapState<E>(args: {
  role: 'card' | 'reader';
  readerPayload?: string;
  onActive?: () => void;
} & NfcTapAdapter<E>): {
  phase: NfcTapPhase;
  reason: string | null;
  activeRef: React.MutableRefObject<boolean>;
  /** Adapter-driven FORWARD phase move (auto-sign → exchanging). Not terminal, so
   * `finalize` stays armed for the real outcome; guards mirror it (no-op after terminal/teardown). */
  advance: (p: NfcTapPhase) => void;
} {
  const {
    role, readerPayload, onActive,
    eventName, nativeModule, armCard, disarmCard, startReader, stopReader,
    waitsForReceipt = true, receiptWaitMs = SOL_RECEIPT_WAIT_MS, onSettling, onRequest, onSubmit, onReceipt, onConfirmed,
  } = args;
  // The adapter callbacks live in a ref, NOT in the effect deps. NfcTap/SolNfcTap pass inline
  // arrows (`armCard: () => DpayNfc.armCard()`, `onRequest: (e, ctx) => …`) — fresh identity every
  // render. Mid-tap re-renders are guaranteed (every phase event calls setPhase; the payer also
  // setDisclosure in autoSign), so keying the effect on those identities re-ran it MID-TAP: the
  // cleanup called disarmCard/stopReader while the phones were still coupled — disableReaderMode
  // killed the RF field, IsoDep.transceive threw TagLostException ("Phones moved apart"), and the
  // re-armed reader re-detected the still-present payer → every tap died at its first phase
  // transition, over and over (the 2026-08-13 fcd2afd regression; invisible to e2e/jest/ondevice,
  // which all bypass the live RN session). Reading through the ref keeps the LATEST callbacks
  // without ever tearing the session down.
  const adapterRef = useRef({armCard, disarmCard, startReader, stopReader, onSettling, onRequest, onSubmit, onReceipt, onConfirmed});
  adapterRef.current = {armCard, disarmCard, startReader, stopReader, onSettling, onRequest, onSubmit, onReceipt, onConfirmed};
  const [phase, setPhase] = useState<NfcTapPhase>('listening');
  const [reason, setReason] = useState<string | null>(null);
  const finalized = useRef(false);
  const activeRef = useRef(false);
  const committed = useRef(false);
  // True once the adapter has fired the auto-sign (advance → exchanging). The SOL transport
  // re-pushes the solreq on every re-tap (no requestSent latch), so a duplicate 'request' event
  // can arrive AFTER the payment is already signed — the signed payment owns the UI from there;
  // a late request must not re-trigger validation/sign.
  const signed = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  // Mirror of `phase` readable inside the long-lived subscription effect (its closure would
  // otherwise see the mount-time 'listening' forever). Drives the review-sticky rule below.
  const phaseRef = useRef<NfcTapPhase>('listening');
  // False once the tap view is torn down (user hit Cancel/Done). An in-flight submit/sign promise
  // that resolves after that must not touch state — it would warn and, worse, could flip a screen
  // the user already left.
  const aliveRef = useRef(true);
  // Keep onActive in a ref so markActive has a stable identity (the effect must not re-subscribe /
  // re-arm on every parent render just because an inline callback changed).
  const onActiveRef = useRef(onActive);
  onActiveRef.current = onActive;

  const markActive = useCallback(() => {
    if (!activeRef.current) { activeRef.current = true; onActiveRef.current?.(); }
  }, []);

  const clearSettleTimer = useCallback(() => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
  }, []);

  const setPhaseTracked = useCallback((p: NfcTapPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const finalize = useCallback((p: NfcTapPhase, r?: string) => {
    if (finalized.current || !aliveRef.current) return; // first terminal wins; ignore after teardown
    finalized.current = true;
    clearSettleTimer();
    setReason(r ?? null);
    setPhaseTracked(p);
  }, [clearSettleTimer, setPhaseTracked]);

  /** Adapter-driven FORWARD phase move (auto-sign → exchanging). Not terminal, so
   * `finalize` stays armed for the real outcome; guards mirror it (no-op after terminal/teardown). */
  const advance = useCallback((p: NfcTapPhase) => {
    if (finalized.current || !aliveRef.current) return;
    signed.current = true;
    setPhaseTracked(p);
  }, [setPhaseTracked]);

  useEffect(() => {
    // Re-set on every effect re-run (readerPayload change / remount): the cleanup below sets
    // aliveRef.current=false, and without resetting it here finalize would stay blocked forever.
    aliveRef.current = true;
    const generation = ++generationRef.current;
    const adapter = () => adapterRef.current;
    const isCurrent = () => aliveRef.current && generationRef.current === generation;
    const ctx: TapCtx = {
      finalize: (p, r) => { if (isCurrent()) finalize(p, r); },
      isCurrent,
    };
    const emitter = new NativeEventEmitter(nativeModule as any);
    const sub = emitter.addListener(eventName, (e: any) => {
      if (!isCurrent()) return;
      if (e.role !== role) return;
      if (e.type === 'error') {
        markActive();
        // Once the payment is in flight to settlement, a transport error says nothing about whether
        // the ledger settled — the outcome is owned by the adapter's submit/poll or receipt path.
        // Don't overwrite a decided (or about-to-be-decided) outcome with a false failure.
        if (finalized.current || committed.current) return;
        finalize('error', e.reason);
        return;
      }
      if (finalized.current) return; // terminal reached; ignore late phase/confirmed events
      if (e.type === 'phase') {
        if (e.phase !== 'listening') markActive();
        // The payer's wire/solpay has left the phone: from here settlement owns the outcome.
        // Receipt-based adapters (currently SOL) arm a timeout so they cannot spin forever.
        if (role === 'card' && e.phase === 'settling') {
          committed.current = true;
          adapterRef.current.onSettling?.();
          if (waitsForReceipt && !settleTimer.current) {
            settleTimer.current = setTimeout(() => {
              finalize('pending', M.errors.tap.couldntConfirmOffline);
            }, receiptWaitMs);
          }
        }
        // Native transports report "request held, awaiting payer decision" as 'awaitingApproval'
        // (IC uiPhase; SOL cardPhaseName) — with auto-sign the card has no decision park, so it
        // maps straight to 'exchanging' (the sign is already running by the time the transport
        // reports it). The READER keeps it (its role-aware "Waiting for the payer…" copy).
        const mapped: NfcTapPhase = e.phase === 'awaitingApproval' && role === 'card' ? 'exchanging' : e.phase;
        // Transport re-tap chatter must not drag the payer backwards: a re-coupled reader
        // re-emits 'linking' (SELECT) — once the auto-sign has fired it's physics interrupting
        // the sign/send. Only 'settling' and terminal phases (reachable once the wire actually
        // flows) pass through that window.
        const chatter = mapped === 'linking' || mapped === 'exchanging';
        if (chatter && signed.current && phaseRef.current !== 'listening') return;
        setPhaseTracked(mapped);
      } else if (e.type === 'request') {
        // Duplicate requests (SOL re-tap re-push) after the sign fired are dropped at the hook:
        // the signed payment owns the UI. A fresh request reaches the adapter, which validates
        // (fail-closed auto-decline for unsupported/expired) and fires the auto-sign — there is
        // no parked-decision state anymore.
        if (signed.current) return;
        markActive();
        adapterRef.current.onRequest(e as E, ctx);
      } else if (e.type === 'done' || e.type === 'payment') {
        markActive();
        committed.current = true;
        adapterRef.current.onSubmit(e as E, ctx);
      } else if (e.type === 'receipt' || e.type === 'result') {
        adapterRef.current.onReceipt?.(e as E, ctx);
      } else if (e.type === 'confirmed') {
        adapterRef.current.onConfirmed?.(e as E, ctx);
      }
    });
    if (role === 'card') {
      adapter().armCard().catch((e: unknown) => ctx.finalize('error', e instanceof Error ? e.message : String(e)));
    } else if (readerPayload) {
      adapter().startReader(readerPayload).catch((e: unknown) => ctx.finalize('error', e instanceof Error ? e.message : String(e)));
    }
    return () => {
      aliveRef.current = false;
      clearSettleTimer();
      sub.remove();
      if (role === 'card') adapter().disarmCard().catch((e: unknown) => console.warn('disarmCard failed (cleanup)', e));
      else adapter().stopReader().catch((e: unknown) => console.warn('stopReader failed (cleanup)', e));
    };
    // Adapter callbacks are deliberately ABSENT: they're read through adapterRef (see its comment),
    // so inline-arrow identities from NfcTap/SolNfcTap can never re-run this effect mid-tap.
    // `setPhaseTracked` IS listed: it is a `useCallback([])`, so it is one identity for the whole
    // mount and adds zero re-runs — and leaving it out is what would let a future edit turn it into
    // a changing identity without the rule saying so, which is the exact mid-tap teardown the
    // adapterRef comment above exists to prevent.
  }, [
    role, readerPayload, eventName, nativeModule, waitsForReceipt, receiptWaitMs, finalize, markActive, clearSettleTimer, setPhaseTracked,
  ]);

  return {phase, reason, activeRef, advance};
}
