// The EVM rail's numeric constants (paging, caps) — PURE (records only, no fetch, no globals)
// so the seam `app/evm.ts` can re-export them WITHOUT statically importing a NETWORK module
// (the isolation contract: loading the seam must never load `evm/rpc.ts`, `evm/service.ts` or
// `evm/history.ts` — the offline inner loop pins that with a trip-wire).
//
// These are the history walk's knobs. THE PAGE SIZE IS A PERFORMANCE KNOB, NEVER A CORRECTNESS
// ONE (D9/R4): correctness depends only on every page being a contiguous range and the walk
// stopping at its caps — both independent of the values.

/** Blocks per `eth_getLogs` page — deliberately conservative (free-tier range limits commonly
 *  bind between 1k and 10k blocks; 2k sits safely under every known cap). One constant. */
export const EVM_LOG_PAGE_SIZE = 2000;

/** Page count cap for one history read: 10 × 2000 = a ~20k-block recent window per poll —
 *  bounded request volume per tick (the POLL-budget rule), and the cap is what keeps a
 *  spam-blocked wallet from paging forever. */
export const EVM_HISTORY_MAX_PAGES = 10;

/** Row cap per read: the wallet shows a recent list, never an unbounded walk. */
export const EVM_HISTORY_MAX_ROWS = 50;

/** Block-timestamp lookups per read (deduped by block): each is one cached read
 *  (`eth_getBlockByNumber` rides the relay's TTL cache), and the cap bounds the fan-out a big
 *  page can cause. Rows beyond the cap carry ts=null and sort by block. */
export const EVM_HISTORY_MAX_TIMESTAMPS = 25;
