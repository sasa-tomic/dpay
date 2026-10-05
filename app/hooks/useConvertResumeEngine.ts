/**
 * hooks/useConvertResumeEngine — mount the conversion record-advancement engine for THIS wallet
 * (multi-venue readiness V6). Wallet calls it once per session; from then on every live convert
 * record is driven whether or not a Convert screen is open (app/convertResume.ts owns the
 * drivers, the cadence bounds, and the terminal rules). `onTerminal` is Wallet's ledger refresh
 * plus the post-action rail decision: the record rides the callback so the wallet can arm the
 * bounded Solana re-poll when the payout lands on the Solana rail — a conversion landing is
 * account activity, same as any payment.
 */
import {useEffect} from 'react';
import type {Identity} from '../lib/types';
import type {ConvertRecord} from '../convert/types';
import {startConvertResumeEngine} from '../convertResume';

export function useConvertResumeEngine(args: {identity: Identity; relayUrl: string; onTerminal?: (rec: ConvertRecord) => void}): void {
  const {identity, relayUrl, onTerminal} = args;
  // String deps only (the useTransactionHistory pattern): the engine restarts when the WALLET
  // it drives changes, not when the parent re-renders with a fresh callback identity.
  const secretHex = identity.secretHex;
  const publicHex = identity.publicHex;
  useEffect(() => {
    const stop = startConvertResumeEngine({secretHex, publicHex, relayUrl, onTerminal});
    return () => {
      stop();
    };
  }, [secretHex, publicHex, relayUrl, onTerminal]);
}
