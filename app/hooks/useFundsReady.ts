// useFundsReady — awards the `fundsReady` journey stamp ONCE, at the single place the wallet's
// per-asset balance map changes (Trip Ready J5b). Mounted by Wallet directly after the
// `buildAssetBalances` memo; `decideFundsReady` (pure) is the truth — DEMO funds count, `—`
// unknowns do not. The ref gate keeps the 2.5s balance poll from spam-persisting: after the
// first award (or after seeing the stamp already present), the effect is inert forever.
import {useEffect, useRef} from 'react';
import {JOURNEY_STAMPS, hasStamp, useJourney} from '../lib/journey';
import {decideFundsReady} from '../lib/readiness';
import type {BalanceView} from '../lib/assetBalances';
import type {AssetId} from '../lib/types';

export function useFundsReady(balances: Record<AssetId, BalanceView>): void {
  const {journey, award} = useJourney();
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (hasStamp(journey, JOURNEY_STAMPS.fundsReady)) {
      settledRef.current = true;
      return;
    }
    if (decideFundsReady(balances)) {
      settledRef.current = true;
      award(JOURNEY_STAMPS.fundsReady);
    }
  }, [journey, balances, award]);
}
