import {useCallback, useEffect, useRef, useState} from 'react';
import {NativeEventEmitter} from 'react-native';
import {RECEIPT_WAIT_MS} from '../config/constants';

// The terminal + transitional phases both NFC tap components track. Structurally identical to
// NfcPhaseName / SolNfcPhaseName (plus 'error') — the IC and SOL transports share the same
// 9-phase status UI, which is precisely why the two components can share this hook.
export type NfcTapPhase =
  | 'listening' | 'linking' | 'exchanging' | 'awaitingApproval' | 'settling'
  | 'success' | 'declined' | 'pending' | 'error';

// Helpers handed to each adapter's protocol callbacks. `finalize` is the one terminal-settling
// seam: the adapter calls it to drive the shared state machine to a terminal phase. The hook owns
// the first-terminal-wins + teardown guards so an adapter never has to reimplement them.
export type TapCtx = {
  finalize: (phase: NfcTapPhase, reason?: string) => void;
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
  onSettling?: () => void;
  onRequest: (e: E, ctx: TapCtx) => void;
  onSubmit: (e: E, ctx: TapCtx) => void;
  onReceipt: (e: E, ctx: TapCtx) => void;
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
} {
  const {
    role, readerPayload, onActive,
    eventName, nativeModule, armCard, disarmCard, startReader, stopReader,
    onSettling, onRequest, onSubmit, onReceipt,
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
  const adapterRef = useRef({armCard, disarmCard, startReader, stopReader, onSettling, onRequest, onSubmit, onReceipt});
  adapterRef.current = {armCard, disarmCard, startReader, stopReader, onSettling, onRequest, onSubmit, onReceipt};
  const [phase, setPhase] = useState<NfcTapPhase>('listening');
  const [reason, setReason] = useState<string | null>(null);
  const finalized = useRef(false);
  const activeRef = useRef(false);
  const committed = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const finalize = useCallback((p: NfcTapPhase, r?: string) => {
    if (finalized.current || !aliveRef.current) return; // first terminal wins; ignore after teardown
    finalized.current = true;
    clearSettleTimer();
    setReason(r ?? null);
    setPhase(p);
  }, [clearSettleTimer]);

  useEffect(() => {
    // Re-set on every effect re-run (readerPayload change / remount): the cleanup below sets
    // aliveRef.current=false, and without resetting it here finalize would stay blocked forever.
    aliveRef.current = true;
    const adapter = () => adapterRef.current;
    const ctx: TapCtx = {finalize};
    const emitter = new NativeEventEmitter(nativeModule as any);
    const sub = emitter.addListener(eventName, (e: any) => {
      if (e.role !== role) return;
      if (e.type === 'error') {
        markActive();
        // Once the payment is in flight to settlement, a transport error says nothing about whether
        // the ledger settled — the outcome is owned by onSubmit / the receipt path. Don't let it
        // overwrite a decided (or about-to-be-decided) outcome with a false failure.
        if (finalized.current || committed.current) return;
        finalize('error', e.reason);
        return;
      }
      if (finalized.current) return; // terminal reached; ignore late phase/confirmed events
      if (e.type === 'phase') {
        if (e.phase !== 'listening') markActive();
        // The payer's wire/solpay has left the phone: from here the outcome depends on the receipt.
        // Arm a timeout so we never spin on "Confirming…" forever if the receipt never arrives.
        if (role === 'card' && e.phase === 'settling') {
          committed.current = true;
          adapterRef.current.onSettling?.();
          if (!settleTimer.current) {
            settleTimer.current = setTimeout(() => {
              finalize('pending', 'Couldn’t confirm — check your balance when back online');
            }, RECEIPT_WAIT_MS);
          }
        }
        setPhase(e.phase);
      } else if (e.type === 'request') {
        markActive();
        setPhase('exchanging');
        adapterRef.current.onRequest(e as E, ctx);
      } else if (e.type === 'done' || e.type === 'payment') {
        markActive();
        committed.current = true;
        adapterRef.current.onSubmit(e as E, ctx);
      } else if (e.type === 'receipt') {
        adapterRef.current.onReceipt(e as E, ctx);
      }
      // 'confirmed' (reader): the receipt reached the payer; the merchant already finalized on submit.
    });
    if (role === 'card') {
      adapter().armCard().catch((e: unknown) => finalize('error', e instanceof Error ? e.message : String(e)));
    } else if (readerPayload) {
      adapter().startReader(readerPayload).catch((e: unknown) => finalize('error', e instanceof Error ? e.message : String(e)));
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
  }, [
    role, readerPayload, eventName, nativeModule, finalize, markActive, clearSettleTimer,
  ]);

  return {phase, reason, activeRef};
}
