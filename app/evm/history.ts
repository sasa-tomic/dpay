// EVM token history via `eth_getLogs` Transfer-topic paging. NETWORK module — reached only
// through `evm/service.ts` (which the seam `app/evm.ts` dynamically imports); never under the
// offline inner loop. The `solana/history.ts` shape is the spec: rows newest-first, direction
// from the wallet's own side, individually unreadable rows logged + counted in `dropped` —
// never an exception that blanks the whole list.
//
// # Why getLogs (D9)
// ERC-20 transfers leave exactly one fact on chain: the token's `Transfer(address,address,
// uint256)` log. Filtering by (token contract, topic0, OR-of-{wallet as from, wallet as to})
// is the whole read; `decodeTransferLog` (evm/abi.ts) does the parsing and answers null for
// anything that is not a standard ERC-20 Transfer (an ERC-721 shape, a foreign topic) — those
// are the dropped rows.
//
// # Paging + the cursor (D9/R4)
// Providers cap the `eth_getLogs` block RANGE (commonly 1k-10k blocks), so the walk pages in
// `LOG_PAGE_SIZE` chunks from the tip backwards, never asking for more than one page at a
// time. THE PAGE SIZE IS A PERFORMANCE KNOB, NEVER A CORRECTNESS ONE (D9): correctness depends
// only on (a) every page being a contiguous range and (b) the walk stopping at its cap — both
// independent of the constant's value. A persisted cross-restart cursor is the hooks' job
// (next wave); this module walks a bounded recent window per call, which is what the history
// poll needs.
//
// Failed transactions are NOT a history gap on this rail: a reverted tx emits no Transfer log,
// so it has no row here — failed sends surface through the receipt poll (D9's own note).

import {decodeTransferLog} from './abi';
import {ethBlockNumber, ethGetBlockByNumber, ethGetLogs} from './rpc';
import {
  EVM_HISTORY_MAX_PAGES,
  EVM_HISTORY_MAX_ROWS,
  EVM_HISTORY_MAX_TIMESTAMPS,
  EVM_LOG_PAGE_SIZE,
} from './constants';

// The paging/cap constants live in the PURE module `evm/constants.ts` (imported above) so the
// seam can re-export them without statically importing THIS network module.

/** One decoded movement of the token. `amount` is the exact raw smallest-unit decimal STRING
 *  (uint256 routinely exceeds 2^53 — never through JS number). `ts` is unix seconds when the
 *  block timestamp was readable, null otherwise (the caller sorts by blockNumber). */
export interface EvmHistoryRow {
  readonly txHash: string;      // 0x-prefixed tx hash — the receipt/annotation handle
  readonly blockNumber: number; // the sort key after ts
  readonly dir: 'in' | 'out';
  readonly counterparty: string; // the OTHER side's 0x address (lowercase)
  readonly amount: string;       // raw units, decimal-digit string
  readonly ts: number | null;    // unix seconds, or null when the block header was unavailable
}

export interface EvmHistory {
  readonly rows: readonly EvmHistoryRow[]; // newest-first
  readonly dropped: number;                // unreadable/foreign logs, counted not thrown
}

const hexToBig = (hex: string): bigint => BigInt('0x' + (hex.toLowerCase().replace(/^0x/, '') || '0'));

function pageRange(tip: number, page: number): {fromBlock: number; toBlock: number} {
  // page 0 = [tip-size+1, tip]; page 1 = the range below it; clamped at 1 (block 0 exists).
  const toBlock = Math.max(1, tip - page * EVM_LOG_PAGE_SIZE);
  const fromBlock = Math.max(1, toBlock - EVM_LOG_PAGE_SIZE + 1);
  return {fromBlock, toBlock};
}

export async function fetchEvmHistory(
  urls: readonly string[],
  chainId: number,
  address: string,
  tokenAddress: string,
  opts?: {signal?: AbortSignal},
): Promise<EvmHistory> {
  const signal = opts?.signal;
  // The wallet address as an EVENT TOPIC: a topic is a 32-byte word, so the 20-byte address is
  // left-padded — an unpadded topic matches nothing (a silent empty ledger, the worst failure
  // shape for a history reader).
  const walletTopic = '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const wallet = address.toLowerCase();
  const token = tokenAddress.toLowerCase();
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const tip = Number(hexToBig(await ethBlockNumber(urls, {signal})));
  if (!Number.isFinite(tip) || tip < 1) {
    throw new Error(`evm history: eth_blockNumber answered ${tip} for chain ${chainId}`);
  }

  const seen = new Set<string>();
  const rows: EvmHistoryRow[] = [];
  const pendingTs = new Set<number>();
  let dropped = 0;

  for (let page = 0; page < EVM_HISTORY_MAX_PAGES && rows.length < EVM_HISTORY_MAX_ROWS; page++) {
    const {fromBlock, toBlock} = pageRange(tip, page);
    const range = {
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + toBlock.toString(16),
      address: token,
    };
    // "from == wallet OR to == wallet" is TWO filters — a topic position is ANDed across
    // positions, OR-ed within an array, and there is no single shape for an OR across two
    // positions. Both legs of one page, then the dedupe below.
    const logs = (await Promise.all([
      ethGetLogs(urls, {...range, topics: [TRANSFER_TOPIC, walletTopic, null]}, {signal}),
      ethGetLogs(urls, {...range, topics: [TRANSFER_TOPIC, null, walletTopic]}, {signal}),
    ])).flat();
    for (const log of logs) {
      // Identity: (txHash, logIndex) — a transfer event is unique by its position in the tx.
      const key = `${String(log.transactionHash ?? '').toLowerCase()}:${String(log.logIndex ?? '')}`;
      if (seen.has(key)) continue;
      const decoded = decodeTransferLog(String(log.data ?? ''), [...(log.topics ?? [])]);
      if (decoded === null || !/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash ?? ''))) {
        dropped++;
        continue;
      }
      seen.add(key);
      const from = decoded.from;
      const to = decoded.to;
      // The filter already constrains one side to the wallet; the guard keeps an honest row
      // even if a node answers loosely. A self-transfer (from == to == wallet) reads 'in'.
      const dir: 'in' | 'out' = to === wallet ? 'in' : 'out';
      const counterparty = dir === 'in' ? from : to;
      const blockNumber = Number(hexToBig(String(log.blockNumber ?? '0x0')));
      if (rows.length < EVM_HISTORY_MAX_ROWS) {
        if (blockNumber > 0 && pendingTs.size < EVM_HISTORY_MAX_TIMESTAMPS) pendingTs.add(blockNumber);
        rows.push({
          txHash: String(log.transactionHash).toLowerCase(),
          blockNumber,
          dir,
          counterparty,
          amount: decoded.amount.toString(10),
          ts: null, // filled below, best-effort
        });
      }
    }
    if (fromBlock <= 1) break; // reached chain start
  }

  // Block timestamps, best-effort: a header that cannot be read leaves ts=null (the row still
  // sorts by blockNumber). Failures here never fail the read.
  const tsByBlock = new Map<number, number>();
  for (const blockNumber of pendingTs) {
    try {
      const header = await ethGetBlockByNumber(urls, '0x' + blockNumber.toString(16), {signal});
      const ts = header === null ? NaN : Number(hexToBig(String(header.timestamp ?? '0x0')));
      if (Number.isFinite(ts) && ts > 0) tsByBlock.set(blockNumber, ts);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  const withTs = rows.map((r) => (tsByBlock.has(r.blockNumber) ? {...r, ts: tsByBlock.get(r.blockNumber)!} : r));
  // Newest-first: by ts when present, else by blockNumber; equal keys by tx hash for a stable order.
  withTs.sort((a, b) => {
    const ta = a.ts ?? a.blockNumber;
    const tb = b.ts ?? b.blockNumber;
    if (ta !== tb) return tb - ta;
    return a.txHash < b.txHash ? 1 : a.txHash > b.txHash ? -1 : 0;
  });
  return {rows: withTs, dropped};
}
