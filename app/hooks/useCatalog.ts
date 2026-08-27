import {useEffect, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {type NetworkSection, catalogCacheKey, BUNDLED_NETWORKS, fetchCurrencies, parseNetworkCatalog} from '../config/catalog';

/**
 * The currency catalog — the runtime source of truth for which assets exist + how to display/fund
 * them. AsyncStorage cache first (instant), then refreshed from the relay (GET /currencies). Re-runs
 * when the relay URL changes (a relay switch may expose a different asset set). Returns the bundled
 * default on a cold first load so the UI renders before the live fetch lands.
 *
 * Catalog v2 (2026-08-27): the state is the network-first `NetworkSection[]` (icp mainnet + icp
 * testnet + solana sections) — ONE shape for the cache, the live response, and the bundled
 * fallback, all through the same `parseNetworkCatalog`. Consumers derive what they need
 * (`icpCatalogOf` for the flat IC catalog, `solanaAssetsOf` for the SOL display facts) so the IC
 * and Solana rows are catalog-driven from a single source. The cache read validates through the
 * parser (a stale/foreign entry falls back to bundled instead of rendering garbage); the
 * `fresh !== prior` identity guard (avoids a needless re-render when the relay returns the same
 * array reference `fetchCurrencies` handed it as the `prior` fallback) and the `alive` teardown
 * guard are unchanged from the pre-split hook.
 */
export function useCatalog(relayUrl: string): NetworkSection[] {
  const [networks, setNetworks] = useState<NetworkSection[]>(BUNDLED_NETWORKS);
  useEffect(() => {
    let alive = true;
    (async () => {
      let prior = BUNDLED_NETWORKS;
      try {
        const cached = await AsyncStorage.getItem(catalogCacheKey(relayUrl));
        if (cached) {
          const parsed = parseNetworkCatalog(JSON.parse(cached));
          if (parsed) { prior = parsed; if (alive) setNetworks(prior); }
        }
      } catch { /* cache miss is fine — the bundled default + live fetch cover it */ }
      const fresh = await fetchCurrencies(relayUrl, prior);
      if (alive && fresh !== prior) setNetworks(fresh);
    })();
    return () => { alive = false; };
  }, [relayUrl]);
  return networks;
}
