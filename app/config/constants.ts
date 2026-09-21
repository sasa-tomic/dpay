export const EXPIRY_WINDOW = 900; // request valid 15 min (U-F3: a payer who opens a shared request link and creates a wallet — 24-word mnemonic entry — must not land on an expired request) — still kills stale replays
// NFC is an immediate physical exchange. The online merchant stamps its request from certified IC
// time so an offline payer can sign without a clock/network call. The paired read_state envelope gets
// another 60s in prepareNfcTransfer, remaining inside the IC ingress window.
export const NFC_UPDATE_AHEAD_S = 240;
// PR23 — named timeouts for the remaining bare fetch literals. The value is the SAME the inline
// constants carried; only the name is new. BALANCE_TIMEOUT_MS bounds every "fast read" poll
// (balance/history/receipt/catalog + the onboarding best-effort fund). FAUCET_TIMEOUT_MS bounds
// the user-initiated top-up. DEPOSIT_TIMEOUT_MS bounds the initial deposit-info load +
// the ckERC20 onramp-params fetch.
export const BALANCE_TIMEOUT_MS = 4000;
// History walks are the relay's SLOWEST read (icrc3 probe + backwards page walk per currency,
// bounded server-side by its own walk deadline). The 4s fast-read timeout aborted every slow
// currency on mainnet (the "AbortError: Aborted" fan-out noise, 2026-08-21); history gets its
// own ample bound so a full-but-slow page still lands. The interval below is also lengthened —
// history changes only when a payment settles, and the relay now TTL-caches walks anyway.
export const HISTORY_TIMEOUT_MS = 10000;
export const FAUCET_TIMEOUT_MS = 6000;
// DEPOSIT_TIMEOUT_MS bounds the best-effort deposit-info load + the ckERC20 onramp-params fetch.
// DEPOSIT_ADDRESS_TIMEOUT_MS bounds the CRITICAL deposit-address fetch on its OWN controller: the
// address is an IC update call (relay → facade → ckBTC minter, ~5–7s observed on mainnet), so it
// gets ample headroom AND is decoupled from the slower deposit_info (a read-only update that proxies
// the minter's get_minter_info, observed at 7–15s). Sharing one controller let the slow info abort
// the ready address at 8s → "Couldn't load your deposit address." (fixed 2026-08-03).
export const DEPOSIT_TIMEOUT_MS = 20000;
export const DEPOSIT_ADDRESS_TIMEOUT_MS = 20000;
// SOL payer NFC: maximum wait for the merchant's broadcast receipt.
export const SOL_RECEIPT_WAIT_MS = 20000;
export const STORAGE_KEY = 'dpay.identity.v1';
// A wallet that has been GENERATED but whose 24 recovery words have not been acknowledged yet.
// `create()` writes the keypair here and `finishCreate()` promotes it to STORAGE_KEY (and deletes
// this) the moment the user ticks the backup box, so the identity above only ever names a wallet
// whose owner has seen their words. Before this key existed the keypair was written to STORAGE_KEY
// at Create and an app killed with the words on screen came back with an identity — and Onboarding
// renders only when there is none, so the backup screen was skipped FOREVER for a wallet nobody
// could recover. A resume reads this key and shows the SAME words (they are derived from the seed,
// so they are the same 24 either way). Nothing but Onboarding reads it.
export const PENDING_IDENTITY_STORAGE_KEY = 'dpay.identity.pending.v1';
// LEGACY single-relay choice from before the R1 address list: nothing writes it anymore. It is
// read ONCE at load and migrated to a one-entry RELAY_LIST_STORAGE_KEY list (see
// services/relayAddresses.ts). The user-chosen relay ADDRESSES persist across reloads
// (AsyncStorage, like identity + the currency catalog) so changing networks in Settings survives
// an app restart; the list default is `relayConfig`'s value when no persisted choice exists (the
// harness passes ?relay=; prod codegens the real URL).
export const RELAY_STORAGE_KEY = 'dpay.relay.v1';
// R1 (spec 2026-09-09 §"Direction 2") — the operator's ordered relay address LIST, JSON array of
// http(s) URLs, first entry = preferred. One entry is a valid list (an operator with one relay
// sees no behavior change). A LEGACY single value under RELAY_STORAGE_KEY above migrates to a
// one-entry list at load (see services/relayAddresses.ts); nothing writes the legacy key anymore.
export const RELAY_LIST_STORAGE_KEY = 'dpay.relays.v1';
// Whether the user has unhid testnet currencies in the Balances sheet. Defaults to false (testnet
// assets are hidden by default per the founder decision); persisted so the choice survives a
// restart. Mirrors the identity/relay AsyncStorage pattern.
export const SHOW_TESTNET_STORAGE_KEY = 'dpay.showTestnet';
// Wave 7 — manual theme choice ('light' | 'dark'; absent = follow the OS scheme) so the user can
// pin light/dark regardless of the OS scheme. Same AsyncStorage pattern as identity/relay/showTestnet.
export const THEME_STORAGE_KEY = 'dpay.theme.v1';
// The manual language choice ('en' | 'de' | 'fr' | 'es'; absent = follow the device locale). Same
// AsyncStorage pattern, and the same two-tier shape as the theme: the device decides until the user
// says otherwise, and there is always an explicit way back to Auto.
export const LOCALE_STORAGE_KEY = 'dpay.locale.v1';
// The HOME CURRENCY — the one currency the wallet is "in" ('CHF' | 'USD' | 'EUR'). Same
// AsyncStorage pattern as identity/relay/theme/locale, with ONE deliberate difference: there is no
// "auto" value and no default. Absent means NOT YET CHOSEN, and the wallet asks — picking a
// currency for someone who never said so is a worse failure than one extra tap. See
// app/config/currency.ts for why, and for the rail resolution it drives.
export const HOME_CURRENCY_STORAGE_KEY = 'dpay.homeCurrency.v1';
// The asset the wallet was last left on. Remembering it is the least-astonishing behaviour — you
// come back to the account you were using — and it is what makes a page reload or a cold start
// resume rather than reset. Absent means "never chosen an asset", and the HOME CURRENCY's rail
// seeds it (app/config/currency.ts); the home currency is the FIRST answer, not the permanent one.
export const SELECTED_ASSET_STORAGE_KEY = 'dpay.selectedAsset.v1';
// Trip Ready J1 — the journey/stamp store (app/lib/journey.ts): which milestones the user has hit
// (walkthroughDone, recoverySaved, …). Same AsyncStorage pattern as identity/relay/theme; persisted
// so the first-run walkthrough shows exactly once and later waves' passport survives relaunch.
export const JOURNEY_STORAGE_KEY = 'dpay.journey.v1';
// The canonical public origin of the dpay web wallet. Independent of the user-editable relay
// endpoint (an operator may point the app at their own relay; a link they SHARE must still open
// for a recipient who has never heard of that relay). Used for the privacy URL and — on native,
// where there is no `location.origin` to read — as the origin of a shared payment link. The
// Android App Link filter (app/android/app/src/main/AndroidManifest.xml) and the relay's
// `/.well-known/assetlinks.json` are pinned to this same host.
export const WALLET_ORIGIN = 'https://dpay.kalaj.org';
// Google Play requires the public privacy policy to be reachable from inside the app as well as the
// store listing. This is the stable website URL, independent of the user-editable relay endpoint.
export const PRIVACY_URL = `${WALLET_ORIGIN}/privacy`;

// The NATIVE ICP ledger canister. Pinned here — not merely read off the selected catalog row —
// because two rails ask questions only an identity can answer, and in both the principal IS the
// capability:
//   • the send rail — "does this ledger expose the LEGACY `transfer` method?", i.e. can it be paid
//     at a 64-hex account identifier. That method exists on this canister and on no other ICRC-1
//     ledger;
//   • the OpenCryptoPay submission — this ledger's block indexes are reported BARE and every other
//     ledger's are reported `<ledger>:<index>` (`ocpIcTxId`, `lib/opencryptopay.ts`).
// The relay pins its own copy (`crates/dpay-relay/src/catalog.rs` ICP_LEDGER_PRINCIPAL) and both
// sides are drift-checked against `dfx/catalog_truth.json` (`principals.icp_ledger`) by tests.
export const ICP_LEDGER_PRINCIPAL = 'ryjl3-tyaaa-aaaaa-aaaba-cai';

// Poll intervals — read once at module load. The e2e harness injects a shortened override via
// `window.__DPAY_TEST_POLL` (driver.mjs evaluateOnNewDocument, before the bundle evaluates) so the
// suite isn't paced by production cadence. In a shipped build that global is never set → every `??`
// falls through to the prod default, so this is prod-safe (RN sets no such global).
export const POLL = (() => {
  const t = (globalThis as unknown as {__DPAY_TEST_POLL?: Record<string, number>}).__DPAY_TEST_POLL;
  return {
    balance:    t?.balance    ?? 2500,
    history:    t?.history    ?? 15000,
    deposit:    t?.deposit    ?? 10000,
    receiptPay: t?.receiptPay ?? 2500,
    receiptRcv: t?.receiptRcv ?? 1500,
    // The open-request settlement poll (founder decision 2026-09-12): while a request QR is on
    // screen, watch the ledger for the transfer that pays it. The link's `ref` = the request
    // nonce = the on-chain memo, so a camera-scanned link payment confirms the screen with no
    // scan-back. Slower than receiptRcv on purpose — this runs for the request's whole life.
    request: t?.request ?? 4000,
    // The IDLE cadences — what the SOL rail polls at when nothing is happening. `balance`/`history`
    // above are the ACTIVE cadences, kept for the seconds around a money flow (a send just
    // confirmed, the user pressed "Check again", the wallet just opened); outside that window the
    // rail reads at these instead, and while the app is backgrounded it reads at nothing at all.
    //
    // Why they exist: an idle wallet issued 128 requests a minute at the active cadence, which is
    // how a month of provider quota went in five and a half days and took the EUR rail down with
    // it. The arithmetic, and what one wallet costs at each cadence, is in
    // `docs/specs/2026-09-08-solana-rpc-plan.md`. They are SEPARATE keys, deliberately: `balance`
    // is shared with the IC rail (`hooks/useBalancePoll.ts`), so re-timing it here would silently
    // re-time a second rail against a different provider.
    balanceIdle: t?.balanceIdle ?? 30000,
    historyIdle: t?.historyIdle ?? 60000,
  };
})();
// How many CONSECUTIVE failed balance polls read as offline (F4, 2026-09-20): ONE failed
// poll is a blip, not a fact about reachability — a single dropped response must never
// replace a mid-flow form with the offline panel. Three misses at the 2.5 s active cadence
// is ≈ 7.5 s of silence before the dot flips gray; ONE success recovers instantly (the
// recovery direction was never the problem). The test override mirrors POLL's seam.
export const BALANCE_OFFLINE_AFTER_FAILURES =
  (globalThis as unknown as {__DPAY_TEST_BALANCE_OFFLINE_AFTER?: number}).__DPAY_TEST_BALANCE_OFFLINE_AFTER ?? 3;
// How long a money flow keeps the SOL rail at its ACTIVE cadence. Started by the wallet opening
// and by every targeted refresh (a confirmed send, a "Check again" tap) — the events that mean a
// number on screen is about to change and the user is watching for it.
export const SOL_ACTIVE_POLL_WINDOW_MS =
  ((globalThis as unknown as {__DPAY_TEST_SOL_ACTIVE_WINDOW_MS?: number}).__DPAY_TEST_SOL_ACTIVE_WINDOW_MS ?? 30000);
// Bounded unknown-budget for the Receive settlement poll (F2, 2026-08-20): how many 'unknown'
// read_state results we accept before stopping with actionable copy. NOT poll-interval-scaled —
// a count budget keeps the wall-clock bound proportional to POLL.receiptRcv (45s at prod cadence,
// ~4.5s under the e2e POLL override) so the offline suite stays fast.
export const PROOF_POLL_BUDGET = 30;
// WalletConnect v2 project id (from cloud.walletconnect.com, free). Required by the dApp-side
// `EthereumProvider.init` for the native (Android) ckERC20 onramp — the only WalletConnect entry
// point in dpay. PRODUCTION ID IS BAKED HERE: the capstone (showQrModal:false + display_uri QR)
// makes WC's built-in @reown/appkit modal path RUNTIME-UNREACHABLE (ethereum-provider only
// dynamic-imports the modal when showQrModal is true; we render the pairing URI ourselves via a
// custom on-brand <QRCode>). So a non-empty projectId is now SAFE to ship. The test override
// `__DPAY_TEST_WALLETCONNECT_PROJECT_ID=''` DISABLES WC for the offline inner loop (e2e/jest/web):
// jest.setup.js sets it globally to '' (so no jest test triggers WC); the e2e harness injects a
// test id via driver.mjs; prod never sets the global → every `??` falls through to the baked id.
// Mirrors the POLL override seam exactly.
export const WALLETCONNECT_PROJECT_ID =
  ((globalThis as unknown as {__DPAY_TEST_WALLETCONNECT_PROJECT_ID?: string}).__DPAY_TEST_WALLETCONNECT_PROJECT_ID ?? '648afbc757419fa381f77ba0c900bc85');

// ── The Solana RPC endpoint for the native device-key SOL rail (balances, history, send) ────────
//
// ONE getter — `solanaRpcUrl()` — in one place, with one way to change it at runtime. Every
// Solana read and broadcast already calls it per use, and R2 changed ZERO call sites: what
// changed is the DEFAULT (spec 2026-09-09-relay-ha-and-solana-proxy §"Direction 1 — the
// proxy"). Until 2026-09-10 a provider URL + API key was baked right here, so the key shipped
// in every client bundle and its death (HTTP 401/429, measured 2026-09-08/09) was a multi-day
// outage. The default is now DERIVED from the ACTIVE relay address —
// `${relayBase}/api/v1/solana/rpc`, the relay's Solana JSON-RPC proxy — and the provider key
// lives in relay configuration (the deploy environment), never in the app bundle, never in git.
//
// The precedence, top wins (the code in `solanaRpcUrls()` below is the authority):
//   1. the OPERATOR override — `setSolanaRpcUrl`, persisted under `SOLANA_RPC_STORAGE_KEY`,
//      read at boot in App.tsx, editable in Settings ▸ Advanced. This is the escape hatch
//      that keeps docs/REGULATORY.md §4 constraint 2 answerable: an operator (or a user who
//      does not want dpay in their Solana path) points the wallet at ANY Solana endpoint and
//      the relay leaves the path entirely — a single candidate, nothing to walk. `''` CLEARS
//      it — follow the relay again, NOT an offline switch.
//   2. `__DPAY_TEST_SOLANA_RPC_URL` — the test override, captured at module load exactly as
//      the old baked literal was. jest.setup.js sets '' (SOL is OFF for the offline inner
//      loop: an empty URL makes the balance seam no-op and the SOL rows render `—`); the e2e
//      driver injects '' or 'stub' (harness/driver.mjs) or a harness relay's proxy URL
//      (flow 165); prod never sets the global. A single candidate: the derivation never
//      fights it.
//   3. the relay-derived list — `setRelayBaseForSolana` holds the ACTIVE relay bases (the
//      R1 list; App.tsx re-points them synchronously whenever the list resolves or changes),
//      each base + `SOLANA_RPC_PROXY_PATH`, deduplicated, in list order — the multi-home
//      walk. Constants cannot import services (layering), so the bases arrive through that
//      setter; before any wiring the list is `[WALLET_ORIGIN]` — the same
//      https://dpay.kalaj.org the shipped relay list defaults to (relayConfig.ts), reused
//      rather than duplicated.
const SOLANA_RPC_TEST_OVERRIDE: string | undefined =
  (globalThis as unknown as {__DPAY_TEST_SOLANA_RPC_URL?: string}).__DPAY_TEST_SOLANA_RPC_URL;

/** The relay route every Solana RPC call is proxied through when no operator override is set
 *  (R2). Exported for the pins in `__tests__/solana-rpc-config.test.ts`; the fixed contract the
 *  relay serves and `scripts/check-prod-sol.mjs` probes before any ship. */
export const SOLANA_RPC_PROXY_PATH = '/api/v1/solana/rpc';

// The relay bases the default list derives from, in walk order. WALLET_ORIGIN is the
// PRE-WIRING fallback only: App calls `setRelayBaseForSolana` with the live relay list at
// mount and on every list change (synchronously in the same tick that installs the list —
// see App.tsx), so this value serves module-load-time reads and jest suites that never mount
// App. Trailing slashes are stripped and duplicates dropped on the way in (a `?relay=` entry
// may carry one verbatim, and `…//api/…` would 404 — the same normalization `base` in
// lib/format.ts applies to walk addresses; inlined here because constants.ts imports nothing
// by design).
let relayBasesForSolana: string[] = [WALLET_ORIGIN];

/** Normalize one relay base for the derivation: trimmed, trailing `/`s stripped. */
function normalizedSolanaBase(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** Where the operator's chosen endpoint persists. Same AsyncStorage pattern as identity/relay. */
export const SOLANA_RPC_STORAGE_KEY = 'dpay.solanaRpc.v1';

// null = no operator choice — follow the relay-derived default.
let operatorSolanaRpc: string | null = null;

/**
 * The CANDIDATE LIST every Solana read and broadcast walks, in order (R2 multi-home, the
 * same policy R1 gave the IC surfaces: one pass, ordered, transport-trouble → next). The
 * precedence, one winner:
 *   1. the OPERATOR override — a single URL; the operator removed dpay from the path
 *      entirely, so there is nothing to walk to (no second home was chosen).
 *   2. the test override — likewise a single candidate: '' means the rail is OFF (the list
 *      is `['']`, and the seam's empty-head gate no-ops), 'stub' or a URL is the whole list.
 *   3. the relay-derived list — every relay base + `SOLANA_RPC_PROXY_PATH`, de-duplicated,
 *      in the relay list's own order (the first relay is the preferred home; the rest are
 *      failovers).
 * A function, not a constant, because every input changes after module load (the operator's
 * choice from storage or Settings, the relay bases from the R1 list). Call it per use.
 */
export function solanaRpcUrls(): string[] {
  if (operatorSolanaRpc !== null) return [operatorSolanaRpc];
  if (SOLANA_RPC_TEST_OVERRIDE !== undefined) return [SOLANA_RPC_TEST_OVERRIDE];
  return relayBasesForSolana.map((base) => `${base}${SOLANA_RPC_PROXY_PATH}`);
}

/** The public Solana mainnet RPC — the broadcast failover TAIL (attempt-#6, 2026-09-21). The
 *  derived list's HEAD is the relay's Solana proxy, which fronts whatever provider the RELAY's
 *  deploy environment names — and that provider's send-preflight is what refused a valid
 *  signed deposit 8/8 while the byte-exact replay to THIS endpoint was accepted + finalized.
 *  A constant by design: a public, keyless, mainnet-beta endpoint is the one failover home that
 *  needs no configuration, no key in any bundle, and no trust decision beyond the cluster guard
 *  the wallet already runs (`SOL_GENESIS_HASH`). Reads never walk here — the 2.5s balance poll
 *  must not burn a shared public quota the money path may need in the same minute; the tail
 *  exists for BROADCASTS (see `solanaBroadcastRpcUrls`). */
export const SOLANA_RPC_PUBLIC_FAILOVER_URL = 'https://api.mainnet-beta.solana.com';

/**
 * The CANDIDATE LIST every Solana BROADCAST walks — `solanaRpcUrls()` with the public failover
 * tail appended (the attempt-#6 fix: a head send-preflight refusal must have somewhere to go).
 * Deterministic order: every derived home in relay-list order, then the tail, always LAST.
 * The override slots are deliberately NOT extended:
 *   • the OPERATOR override stays a single candidate — the operator chose ONE home and
 *     explicitly removed dpay (and every default) from the path; silently adding a third
 *     party's endpoint to it would betray that choice.
 *   • the TEST override stays a single candidate — the jest/e2e harness override is the
 *     offline loop's isolation contract and must never touch the real internet.
 *   • a devnet/testnet-shaped derivation stays single-homed — a mainnet tail behind a test
 *     cluster would mix clusters, a fund-loss class (mirrors `setSolanaRpcUrl`'s refusal).
 */
export function solanaBroadcastRpcUrls(): string[] {
  if (operatorSolanaRpc !== null) return [operatorSolanaRpc];
  if (SOLANA_RPC_TEST_OVERRIDE !== undefined) return [SOLANA_RPC_TEST_OVERRIDE];
  const list = relayBasesForSolana.map((base) => `${base}${SOLANA_RPC_PROXY_PATH}`);
  if (!list.includes(SOLANA_RPC_PUBLIC_FAILOVER_URL) && !isSolanaDevnet()) {
    list.push(SOLANA_RPC_PUBLIC_FAILOVER_URL);
  }
  return list;
}

/** The endpoint every Solana read and broadcast uses RIGHT NOW: the HEAD of the candidate
 *  list — the preferred home, the one availability checks (the seam's rail gate,
 *  `isSolanaRpcAvailable`, `isSolanaDevnet`) read. The walk itself lives in
 *  `solana/rpc.ts` over `solanaRpcUrls()`; nothing outside the seam needs the tail. A
 *  function, not a constant, for the same reason as the list: never capture it at module
 *  scope, or a rotation would need a restart. */
export function solanaRpcUrl(): string {
  return solanaRpcUrls()[0] ?? '';
}

/** Re-point the DERIVED default list at the ACTIVE relay list (R2). App.tsx calls this
 *  synchronously in the same tick that installs a relay list (the boot effect's initial
 *  wiring, the persisted-list load, and the Settings list mutator) — ONE mechanism, so the
 *  derivation can never lag a re-point the way a derived useEffect could (child effects run
 *  before a parent's, so the first balance poll of a re-pointed wallet reads the OLD base
 *  under that design; the synchronous call reads the new one). Accepts one base or the
 *  whole list; empty/duplicate entries are dropped, trailing slashes stripped. An operator's
 *  explicit endpoint always wins over this (see `solanaRpcUrls`); an all-empty input is
 *  ignored rather than corrupting the derivation. */
export function setRelayBaseForSolana(base: string | readonly string[]): void {
  const input = typeof base === 'string' ? [base] : base;
  const bases: string[] = [];
  for (const entry of input) {
    const trimmed = normalizedSolanaBase(entry);
    if (trimmed === '' || bases.includes(trimmed)) continue;
    bases.push(trimmed);
  }
  if (bases.length === 0) return;
  relayBasesForSolana = bases;
}

/**
 * Point this device at a different Solana endpoint. `''` clears the choice: the wallet follows
 * the relay-derived default again (never an offline switch).
 *
 * THROWS, with an actionable message, on anything it will not accept — the caller (Settings, or
 * the boot loader reading the persisted value) shows or logs it. Two refusals, both fail-closed:
 *   • not an `https:` URL. A Solana endpoint can lie about a balance or a blockhash; over plain
 *     http anyone on the path can. The cluster-identity check (`SOL_GENESIS_HASH`) catches a wrong
 *     CHAIN, not a wrong ANSWER.
 *   • a devnet/testnet host. `isSolanaDevnet()` below is derived from the EFFECTIVE endpoint so
 *     that the "DEVNET" badge and the wrong-cluster warnings stay honest without every screen
 *     having to re-derive them; refusing a non-mainnet override is what keeps that derivation
 *     true. Devnet remains selectable the way it always was — via the
 *     `__DPAY_TEST_SOLANA_RPC_URL` override in a dev/test build.
 */
export function setSolanaRpcUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed === '') {
    operatorSolanaRpc = null;
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: "${trimmed}". Paste the full endpoint your provider gave you, including https://`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`The Solana endpoint must start with https:// (got "${parsed.protocol}//"). An endpoint on plain http can be read and rewritten in transit.`);
  }
  if (/devnet|testnet/i.test(parsed.host)) {
    throw new Error(`"${parsed.host}" is a devnet/testnet endpoint. This wallet holds mainnet funds; a test cluster would show none of them. Use your provider's mainnet endpoint.`);
  }
  operatorSolanaRpc = trimmed;
}

// Whether the SOL rail runs on a devnet/testnet cluster. Derived from the EFFECTIVE endpoint —
// the operator override if set, else the default (test override or relay-derived). Pre-R2 this
// read the baked literal, which nothing could change at runtime; the endpoint is runtime state
// now, so the badge reads it live. The realistic true cases are a dev build's test override
// naming a devnet host and a relay base whose host does; the money-critical cluster guard
// remains `SOL_GENESIS_HASH` (getGenesisHash fail-closes on mismatch) — this badge is the
// naming heuristic that warns BEFORE a send. Used to badge SOL screens ("DEVNET") and warn on
// the receive-address sheet — mainnet SOL sent to a devnet key is a real fund-loss risk.
export function isSolanaDevnet(): boolean {
  return /devnet|testnet/i.test(solanaRpcUrl());
}

// ── The IC /api/v2 gateway base (where the app-signed envelopes submit) ─────────────────────────
//
// The production gateway is icp-api.io. There was no way to point the wallet anywhere else: the
// app signs IC request envelopes locally and posts them DIRECTLY to `{base}/api/v2/canister/…`
// (services/icp.ts), so a demo against a local dfx replica (`just demo`) — where the ledger lives
// at 127.0.0.1:4943, not on the real boundary — could never settle (OPEN_ISSUES demo bullet, F2,
// measured 2026-09-07). This override is the operator escape hatch, mirroring the Solana RPC
// override above (R2, 2026-09-10) but SIMPLER, because the IC gateway is a single base URL, not a
// list to walk. The precedence, top wins:
//   1. the OPERATOR override — `setIcGatewayUrl`, persisted under `IC_GATEWAY_STORAGE_KEY`, read
//      at boot in App.tsx, editable in Settings ▸ Advanced. If set, the /api/v2 gateway base IS
//      that URL. `''` CLEARS it — icp-api.io again. This is for demos and testing (a local
//      replica); a wallet that never sets it is indistinguishable from today's prod behavior.
//   2. `__DPAY_TEST_IC_GATEWAY` — the e2e/jest seam, read PER CALL (not module load) so the
//      harness can retarget or kill the gateway mid-session (flow 22's airplane-mode stage).
//      Fresh jest/e2e contexts never set the operator override, so the seam behaves exactly as
//      before; compose, don't replace.
//   3. `IC_GATEWAY_DEFAULT`.
export const IC_GATEWAY_STORAGE_KEY = 'dpay.icpGateway.v1';
export const IC_GATEWAY_DEFAULT = 'https://icp-api.io';

// null = no operator choice — the test seam / default resolves the gateway.
let operatorIcGateway: string | null = null;

/** The /api/v2 gateway base every IC envelope submit, query, and read_state uses RIGHT NOW.
 *  A function, not a constant, because the operator's choice lands after module load (boot
 *  storage read, Settings apply) and the test seam can flip at runtime. Call it per use. */
export function icGatewayUrl(): string {
  if (operatorIcGateway !== null) return operatorIcGateway;
  return (globalThis as unknown as {__DPAY_TEST_IC_GATEWAY?: string}).__DPAY_TEST_IC_GATEWAY ?? IC_GATEWAY_DEFAULT;
}

/** Is this host loopback or RFC1918 private space? Plain-http gateways are accepted ONLY for
 *  these — the demo case (`http://10.0.2.2:4943`, the emulator's alias for the host's loopback
 *  replica). A PUBLIC host must be https for the same transit-tamper reason the Solana override
 *  refuses it: a gateway on the value path can lie about a query reply. */
function isLocalIcGatewayHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // IPv6 brackets, if any
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Point this wallet's IC /api/v2 gateway at a different base. `''` clears the choice: icp-api.io
 * again. THROWS, with an actionable message, on anything it will not accept — the caller
 * (Settings, or the boot loader reading the persisted value) shows or logs it. One refusal,
 * fail-closed like the Solana twin: a non-https URL on a PUBLIC host. Plain http is accepted
 * only for loopback/RFC1918 addresses — the local-replica demo case, where the transit-tamper
 * concern does not apply and https is not served. Trailing slashes are stripped so the base
 * composes cleanly into `{base}/api/v2/…`.
 */
export function setIcGatewayUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    operatorIcGateway = null;
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Not a valid URL: "${trimmed}". Paste the gateway's full base URL — for a local replica demo, e.g. http://10.0.2.2:4943`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalIcGatewayHost(parsed.hostname))) {
    throw new Error(`The IC gateway must start with https:// (got "${parsed.protocol}//"). Plain http is accepted only for local addresses, e.g. a local replica demo at http://10.0.2.2:4943`);
  }
  operatorIcGateway = trimmed;
}

// SOL native send: getLatestBlockhash + sendTransaction + confirmTransaction (which polls up to
// CONFIRM_TIMEOUT_MS=30s). 60s gives headroom over the full confirm path so a slow-but-finalising
// transfer is never reported as a false failure.
export const SOL_SEND_TIMEOUT_MS = 60000;
// The send path's module-load deadline (solana.ts `loadRpcForSend`). The network module is a lazy
// chunk in the served web build (`rpc-*.js`), and a module load carries NO abort signal — the one
// await in the send chain the caller's deadline cannot cut. 2026-09-21: three live EURC sends died
// exactly there (stalled origin fetches stalled the chunk; the sheet hung in `submitting`, nothing
// broadcast), so the money path now races the import against this bound and fails with honest,
// actionable copy (`M.sol.engineLoad`) instead of hanging. Generous over the slowest real 3G load —
// the normal path never sees it, because the sheet preloads the module at mount (minutes before a
// click) and the balance poll loads it at boot.
export const SOL_RPC_IMPORT_DEADLINE_MS = 10000;
// SOL merchant broadcast: getLatestBlockhash + sendTransaction + confirmTransaction, with headroom
// for the merchant↔payer round trip. 2× the native send timeout. Single source — the offline-pay
// broadcast path (solana.ts) and the merchant NFC path (SolNfcTap) reference this instead of
// inlining SOL_SEND_TIMEOUT_MS * 2 at each site.
export const SOL_BROADCAST_TIMEOUT_MS = SOL_SEND_TIMEOUT_MS * 2;

// Phase 3 — Solana v2 recent-blockhash payment freshness constants. The merchant fetches a fresh
// blockhash + cluster identity immediately before showing a request, then strictly verifies +
// freshness-checks the offline-signed tx before broadcasting. These three values are frozen by the
// v2 protocol (see 2026-08-12-solana-recent-blockhash-rewrite-plan.md "Freshness rules"):
//   • SOL_PAYMENT_COMMITMENT — every freshness RPC call + preflight runs at 'confirmed'.
//   • SOL_GENESIS_HASH — the immutable mainnet-beta cluster id; mismatch fail-closes the request.
//   • SOL_PAYMENT_MAX_WINDOW_SECONDS — the codec's frozen max request lifetime (iat..exp ≤ 90s).
// The genesis hash accepts a `__DPAY_TEST_SOL_GENESIS_HASH` override so a unit test can mutate the
// expected cluster identity (mirrors the Solana-RPC + POLL override seams).
export const SOL_PAYMENT_COMMITMENT = 'confirmed' as const;
export const SOL_GENESIS_HASH =
  ((globalThis as unknown as {__DPAY_TEST_SOL_GENESIS_HASH?: string}).__DPAY_TEST_SOL_GENESIS_HASH ??
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
export const SOL_PAYMENT_MAX_WINDOW_SECONDS = 90;
// ── The first-run practice payment (docs/specs/2026-09-08-first-run-redesign.md §3) ─────────────
// The ONE currency practice may ever pay: DEMO, the faucet-minted play dollar. `DEMO_ASSET_ID`
// (config/assets.ts) is spelled from it, so "which rail is the practice rail" is one fact.
export const PRACTICE_CURRENCY = 0;
// The practice payee: a 32-byte Ed25519 PUBLIC key, generated once from a secret that was never
// written down and no longer exists anywhere. It is KEYLESS on purpose — a distinct, real account
// nobody can spend from — because the alternatives were worse: the facade refuses `from == to`, so
// a literal self-payment would rest on ledger behaviour production has never demonstrated, and one
// phone cannot scan its own screen.
//
// The ∂1.00 every first run sends here is therefore STRANDED, and that is acceptable for exactly
// one reason: DEMO is valueless by construction and the faucet re-mints it on demand. It stays
// acceptable only while `PRACTICE_CURRENCY` gates the payment — `practiceRefusal`
// (components/Practice.tsx) refuses to run on anything else, and that guard is the whole thing
// standing between this constant and a burn address for real money.
export const PRACTICE_PAYEE_PUBKEY = 'e1f9e51a7fdabc25b131dbb2939ace78a0062c1d02e2c89d96a46a1d9b95ce19';
// What practice pays: ∂1.00, in DEMO's raw minor units (2 decimals).
export const PRACTICE_AMOUNT_RAW = '100';

// Mirrors the canister's fixed FAUCET_AMOUNT ($100.00 = 10_000 cents). The demo top-up POSTs this
// amount to /api/v1/faucet; the real canister mints the fixed amount regardless of the request. MC1
// units 2-4: a decimal-digit STRING (raw u64) — the relay accepts string-OR-number at the JSON seam.
export const TOP_UP_CENTS = '10000';

// PR24 — single source of truth for the QR code render size. QR_SIZE is the standard signed-QR /
// request-QR / WC-pairing-QR card (244px, the long-shipped value); QR_SIZE_SMALL is the deposit-
// address QR (200px — slightly smaller so a long native address QR scans reliably at high density).
export const QR_SIZE = 244;
export const QR_SIZE_SMALL = 200;
