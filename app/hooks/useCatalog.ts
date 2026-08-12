import {useEffect, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {type CurrencyDescriptor, catalogCacheKey, BUNDLED_CATALOG, fetchCurrencies} from '../config/catalog';

/**
 * The currency catalog — the runtime source of truth for which assets exist + how to display/fund
 * them. AsyncStorage cache first (instant), then refreshed from the relay (GET /currencies). Re-runs
 * when the relay URL changes (a relay switch may expose a different asset set). Returns the bundled
 * default on a cold first load so the UI renders before the live fetch lands.
 *
 * Extracted verbatim from Wallet.tsx (Effect A) — behavior byte-identical: the cache-miss swallow,
 * the `fresh !== prior` identity guard (avoids a needless re-render when the relay returns the same
 * array reference `fetchCurrencies` handed it as the `prior` fallback), and the `alive` teardown
 * guard all move in unchanged. The ckBTC currency id and the display/history currency-id memos stay
 * in the consumer (derived from the returned `catalog`).
 */
export function useCatalog(relayUrl: string): CurrencyDescriptor[] {
  const [catalog, setCatalog] = useState<CurrencyDescriptor[]>(BUNDLED_CATALOG);
  useEffect(() => {
    let alive = true;
    (async () => {
      let prior = BUNDLED_CATALOG;
      try {
        const cached = await AsyncStorage.getItem(catalogCacheKey(relayUrl));
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length) { prior = parsed as CurrencyDescriptor[]; if (alive) setCatalog(prior); }
        }
      } catch { /* cache miss is fine — the bundled default + live fetch cover it */ }
      const fresh = await fetchCurrencies(relayUrl, prior);
      if (alive && fresh !== prior) setCatalog(fresh);
    })();
    return () => { alive = false; };
  }, [relayUrl]);
  return catalog;
}
