# EVM rail integration spec (ZCHF-first) — 2026-09-26

**Status:** spec, committed on branch `evm-rail` (worktree `~/projects/dpay/dpay-evm`). **Scope:** the
catalog rows, app module map, UI integration, offline permit flow, local env + e2e, and probes for the
generic ERC-20 custody rail. **Out of scope here (owned by already-running streams):** the relay's
`evm.rs` pure-pipe proxy (stream S1, in flight) and the pure crypto core
`app/evm/{identity,rlp,tx,abi,permit,chains}.ts` + golden-vector jest tests (stream S2, in flight).

**Invariants carried over unchanged from the SOL rail** (the mirror template; every decision below
preserves them):

- dpay holds no EVM key server-side; the device derives one secp256k1 key from the SAME
  `Identity.secretHex` seed the Solana rail uses (`app/solana/identity.ts` does SLIP-10 ed25519 at
  m/44'/501'/0'/0'; this rail does SLIP-10 secp256k1 at m/44'/60'/0'/0/0). One address across all
  EVM chains (the address is a function of the key, not the chain).
- The IC facade, wire and core are untouched. The chain is the ledger of record. The relay is
  transport + registry only (`crates/dpay-relay/src/solana.rs` is the precedent: pure pipe).
- dpay never pays and never quotes gas (`OPEN_ISSUES.md` § "EVM rail — generic ERC-20 custody",
  filed 2026-09-26). Gas is the user's own native ETH on the settlement chain.
- EVM never enters the ICRC catalog (`app/config/assets.ts` lines 12-17, the CRITICAL INVARIANT):
  no `CurrencyDescriptor`, no currency id, no ledger principal. Rows live in a separate catalog
  section shape, exactly as SOL rows do.

---

## 1. Catalog

### D1 — New section shape, NOT an IC-row variant: `NetworkAssets::Evm` + an `EvmAsset` struct

The SOL precedent is the answer to "new variants or reuse": SOL rows are NOT `CurrencyDescriptor`s —
they are a relay-level `SolanaAsset` struct (`crates/dpay-relay/src/catalog.rs` line ~1143) carried in
a dedicated `NetworkAssets::Solana` arm (~1166), parsed app-side into a dedicated `SolanaAsset` type
(`app/config/catalog.ts` lines 74-89) inside `protocol:'solana'` sections. Forcing a device-key rail
into the ICRC row shape would contaminate every catalog helper (`familyDisplay`, `isPayableAsset`, the
NFC disclosure — `app/config/catalog.ts` lines 496-531). EVM does exactly what SOL did:

- Relay: add a third `NetworkAssets::Evm(Vec<EvmAsset>)` variant to the untagged enum
  (`crates/dpay-relay/src/catalog.rs` ~1166) and an `EvmAsset` struct beside `SolanaAsset`.
- App: add an `EvmAsset` type + `parseEvmRow` beside `SolanaAsset`/`parseSolanaRow`
  (`app/config/catalog.ts` lines 74-89, 181-200) and an `evmAssetsOf(networks)` derivation beside
  `solanaAssetsOf` (lines 229-234).

```rust
/// One EVM asset row — a relay-level constant (the device-key rail never touches the IC, so
/// deliberately NOT a CurrencyDescriptor — the SolanaAsset precedent, same module).
#[derive(Serialize)]
pub(crate) struct EvmAsset {
    token: &'static str,        // 'ZCHF' — the link/registry token literal (linkToken app-side)
    symbol: &'static str,       // display symbol ('ZCHF'; the split exists for native ETH later)
    decimals: u8,               // 18 for ZCHF
    min_fraction_digits: Option<u8>, // Some(2) — unit-denominated, the VCHF/USDC display policy
    chain_id: u64,              // THE settlement chain (42161 | 1 | 421614 | 31337) — see D4
    address: &'static str,      // EIP-55 checksummed ERC-20 contract; null ONLY for a future
                                // native-ETH row (Option<&'static str> when that row lands)
    onramp: RampCapability,     // Unavailable — no fiat ramp; transfer-in still works (D20)
    offramp: RampCapability,    // Unavailable — same fiat-ramp honesty as every SOL row
    #[serde(skip_serializing_if = "Option::is_none")]
    liquidity: Option<LiquidityTier>, // None for ZCHF (no measured venue tier; do not invent one)
}
```

### D2 — The exact ZCHF rows and where they slot in

New named consts beside `SOLANA_EURC_MINT` (`crates/dpay-relay/src/catalog.rs` ~1028):

```rust
pub(crate) const ZCHF_ARBITRUM_ADDRESS: &str = "0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553";
pub(crate) const ZCHF_ETHEREUM_ADDRESS: &str = "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB";
pub(crate) const ZCHF_DECIMALS: u8 = 18;
pub(crate) const CHAIN_ID_ETHEREUM: u64 = 1;
pub(crate) const CHAIN_ID_ARBITRUM_ONE: u64 = 42161;
pub(crate) const CHAIN_ID_ARBITRUM_SEPOLIA: u64 = 421614;
pub(crate) const CHAIN_ID_ANVIL: u64 = 31_337;
```

A new `evm_network_sections()` provider beside `solana_network_section()` (~1034), appended to
`currencies_body()` AFTER the solana section (`crates/dpay-relay/src/catalog.rs` ~1081-1103; the
doc comments that say "exactly three sections in order" — `CurrenciesBody` ~1105 and the module
header ~47 — are updated to five):

```rust
fn evm_network_sections() -> Vec<NetworkBody> {
    // Arbitrum One FIRST: the recommended event rail (OPEN_ISSUES.md, triathlon measurement
    // 2026-09-26) and the section order IS the wallet row order (buildSelectableAssets
    // preserves section order — app/config/assets.ts:125-169).
    let mut sections = vec![
        NetworkBody { protocol: "evm", name: "Arbitrum One", environment: "mainnet",
            assets: NetworkAssets::Evm(vec![
                EvmAsset { token: "ZCHF", symbol: "ZCHF", decimals: ZCHF_DECIMALS,
                    min_fraction_digits: Some(2), chain_id: CHAIN_ID_ARBITRUM_ONE,
                    address: ZCHF_ARBITRUM_ADDRESS,
                    onramp: RampCapability::Unavailable, offramp: RampCapability::Unavailable,
                    liquidity: None },
            ]) },
        NetworkBody { protocol: "evm", name: "Ethereum", environment: "mainnet",
            assets: NetworkAssets::Evm(vec![
                EvmAsset { token: "ZCHF", symbol: "ZCHF", decimals: ZCHF_DECIMALS,
                    min_fraction_digits: Some(2), chain_id: CHAIN_ID_ETHEREUM,
                    address: ZCHF_ETHEREUM_ADDRESS,
                    onramp: RampCapability::Unavailable, offramp: RampCapability::Unavailable,
                    liquidity: None },
            ]) },
    ];
    sections.extend(dev_evm_sections()); // D3
    sections
}
```

Order on the wire, prod build (both dev envs unset): icp mainnet, icp testnet, solana mainnet,
evm "Arbitrum One" mainnet, evm "Ethereum" mainnet. `catalog_truth_tests` currently pins
`body.networks[2]` as the solana section (`crates/dpay-relay/src/catalog.rs` ~1430); the index
assert survives, and the EVM tests pin `networks[3]`/`networks[4]`.

### D3 — Dev rows (Arbitrum Sepolia + Anvil) are env-gated, never compiled addresses

There is no real ZCHF on Arbitrum Sepolia and nothing at all on a fresh Anvil; the brief pins mock
tokens deployed by the e2e harness. So the dev rows carry env-provided contract addresses and the
sections are OMITTED when the env is unset (fail-closed absence; prod wire bytes unchanged — the
same trick `demo_ledger_text()` uses for `DPAY_DEMO_LEDGER`, `crates/dpay-relay/src/catalog.rs`
lines 35-60: `OnceLock`, read once, shape-validated at startup in `main.rs` where it is cheap):

- `DPAY_EVM_SEPOLIA_TOKEN=<0x…>` set → append
  `{protocol:"evm", name:"Arbitrum Sepolia", environment:"testnet", assets:[ZCHF @ 421614, that address]}`.
- `DPAY_EVM_ANVIL_TOKEN=<0x…>` set → append
  `{protocol:"evm", name:"Anvil", environment:"testnet", assets:[ZCHF @ 31337, that address]}`.

Testnet-ness is the SECTION's `environment` (`app/config/catalog.ts` lines 20-26, 105-109: the app
stamps `testnet` from the owning section and never re-infers), so the existing app testnet-toggle
machinery (`isTestnetCurrency` on IC rows; the evm SelectableAsset arm carries the same stamped
field) hides both dev rows by default. Unit tests pin the DEFAULT (env-unset) shape: exactly five
sections, both dev sections absent. A builder fn taking the two `Option<String>`s keeps the
env-dependent code testable without process-env mutation.

### D4 — `dfx/catalog_truth.json` additions and chain_id semantics

Additions to the existing objects (no new top-level names beyond one):

```json
"erc20_contracts": {
  "ckusdc": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "zchf_arbitrum": "0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553",
  "zchf_ethereum": "0xB58E61C3098d85632Df34EecfB899A1Ed80921cB"
},
"decimals": { "…existing…", "zchf": 18 },
"chains": {
  "_doc": "EVM chain ids for the evm catalog sections. NEW SEMANTICS vs the IC rows: on an evm
           row, chain_id names the chain the money SETTLES on (the row IS money on that chain);
           on the IC chain-key rows, chain_id names the chain the asset is BACKED by (ckUSDC
           chain_id 1 = Ethereum). anvil exists for the local dev/e2e chain only and is never
           served by a prod relay (env-gated, catalog.rs dev_evm_sections).",
  "ethereum": 1,
  "arbitrum_one": 42161,
  "arbitrum_sepolia": 421614,
  "anvil": 31337
}
```

`erc20_contracts` already exists with the ckusdc entry (`dfx/catalog_truth.json`, pinned by both
drift alarms), so the ZCHF addresses slot into the precedented object; `eurc_mint`'s "base58 under
principals" rationale does not apply (these are hex contract addresses — the ckusdc precedent
governs). The chain-id semantics paragraph above is load-bearing: the same field name carries two
meanings across row families, and that is now written down where the drift alarms read it.

### D5 — The exact drift-alarm updates (both halves)

**Rust half** — inside `mod catalog_truth_tests` (`crates/dpay-relay/src/catalog.rs` ~1269):

1. In `named_consts_are_the_catalog_truth_values`: `ZCHF_ARBITRUM_ADDRESS ==
   truth["erc20_contracts"]["zchf_arbitrum"]`, same for `ZCHF_ETHEREUM_ADDRESS`/`zchf_ethereum`,
   `ZCHF_DECIMALS == truth["decimals"]["zchf"]`, and each `CHAIN_ID_*` const ==
   `truth["chains"][<key>]`.
2. New test `evm_rows_match_truth_and_locked_shape`: the evm sections carry exactly 2 rows in prod
   shape; row (42161) address == `zchf_arbitrum`, row (1) address == `zchf_ethereum`, both
   decimals == `decimals.zchf`, `min_fraction_digits == Some(2)`, ramps Unavailable, liquidity
   None, environment mainnet; section names exactly "Arbitrum One" then "Ethereum"; dev sections
   absent in the default (env-unset) build.
3. New wire byte-shape pins in `mod wire_byte_shape_tests` (~1889 `solana_rows_wire_byte_shape`
   precedent): literal JSON for both ZCHF rows, e.g.
   `{"token":"ZCHF","symbol":"ZCHF","decimals":18,"min_fraction_digits":2,"chain_id":42161,"address":"0xD4dD…","onramp":"Unavailable","offramp":"Unavailable"}` —
   any serializer regression (key order, casing, an accidental liquidity key) goes RED.

**Jest half** — inside the `BUNDLED_CATALOG vs dfx/catalog_truth.json (drift alarm)` describe
(`app/__tests__/catalog.test.ts` lines 793-960):

1. New its: the bundled evm Arbitrum row's `address === TRUTH.erc20_contracts.zchf_arbitrum`,
   decimals `=== TRUTH.decimals.zchf === 18`, `chainId === TRUTH.chains.arbitrum_one`; the Ethereum
   row likewise. Plus a SELF-VERIFYING checksum assertion both spellings must survive:
   `expect(eip55ChecksumBad(row.address)).toBe(false)` (`app/lib/eip55.ts` line 100). If the two
   address literals in circulation (OPEN_ISSUES.md EVM entry, vendored OISY env files) are not
   correctly EIP-55-checksummed, this goes RED and the truth file gets the verified-source
   spelling — the alarm is what reconciles them, not prose.
2. `parseNetworkCatalog` gains an evm-section fixture test (a well-formed evm section parses; a row
   with a checksum-BROKEN address, a non-hex address, or a missing chainId is skipped fail-closed;
   an unknown-protocol section is still skipped — `app/config/catalog.ts` lines 110-113, unchanged).
3. The `NO bundled row carries liquidity` loop (lines ~945-955) extends to the evm rows (all null).
4. A collision test: `chipLabel` renders `ZCHF·Arb` / `ZCHF·Eth` when both rows are visible
   (`SHORT_NETWORK_TAG` gains `Arbitrum One: 'Arb'`; `Ethereum: 'Eth'` already exists,
   `app/config/assets.ts` ~509).

### D6 — App-side parse, bundled rows, and payability

`app/config/catalog.ts`:

```ts
export type EvmAsset = {
  token: string;            // 'ZCHF' — the SelectableAsset token literal + linkToken
  symbol: string;
  decimals: number;
  min_fraction_digits: number | null;
  chainId: number;          // THE settlement chain
  address: string;          // EIP-55 checksummed contract (verified at parse)
  liquidity: 'deep' | 'thin' | null;
  onramp: RampCapability;   // fail-closed to 'Unavailable'
  offramp: RampCapability;
  testnet: boolean;         // stamped from the owning section's environment
};
```

`parseEvmRow` requires token/symbol/decimals/chainId/address and rejects the row when
`eip55ChecksumBad(address)` (`app/lib/eip55.ts`) — a mangled checksum on the wire is a money-routing
bug, not a display nit. `evmAssetsOf(networks)` mirrors `solanaAssetsOf` (lines 229-234).
`BUNDLED_NETWORKS` (lines 300-338) gains: `{protocol:'evm', name:'Arbitrum One', environment:'mainnet', assets:[ZCHF row]}`,
`{protocol:'evm', name:'Ethereum', environment:'mainnet', assets:[ZCHF row]}`, and an EMPTY
`{protocol:'evm', name:'Arbitrum Sepolia', environment:'testnet', assets:[]}` (the icp-testnet
empty-section convention: clients shouldn't infer from absence — lines 305-306). Addresses and
decimals are IMPORTED from `app/evm/chains.ts` (stream S2's module), never re-typed — the
`USDC_MINT_ADDRESS` precedent (`app/config/catalog.ts` line 8). Dev/Anvil rows are never bundled
(env-gated relay-side only, D3).

Payability: `isPayableAsset` stays IC-only (`app/config/catalog.ts` lines 496-531); an evm row's
payability is a property of its PARSE (fail-closed row shape ⇒ payable), the same way a SOL row is
payable by being parsed. `resolvePayLink`'s payability branch is already `protocol === 'ic'`-gated
(`app/config/assets.ts` lines 447-449), so no IC helper ever inspects an evm row.

### D7 — `SelectableAsset` third arm, ids, slugs, links

`app/config/assets.ts` gains the evm arm of the discriminated union (lines 60-100):

```ts
| {
    id: `evm:${number}:${string}`;   // `evm:42161:ZCHF` — chainId + token, both stable
    protocol: 'evm';
    token: string;                   // 'ZCHF'
    symbol: string;
    chainId: number;
    chainName: string;               // 'Arbitrum One' | 'Ethereum' — the section name, proper noun
    address: string;                 // the token contract
    linkToken: string | null;        // = token ('ZCHF'), never collides with IC 'VCHF' (tokenEq
                                     // is exact case-insensitive — app/config/assets.ts:440)
    networkLabel: string;            // 'ZCHF · Arbitrum One'
    network: string;                 // chainName (settlement chain, the SOL-arm convention)
    decimals: number;
    minFractionDigits: number;
    liquidity: 'deep' | 'thin' | null;
    onramp: RampCapability; offramp: RampCapability; rampPartner: string | null;
    visible: boolean; testKey: string;  // `evm-zchf-arbitrum` / `evm-zchf-ethereum`
    testnet: boolean;                // dev rows hidden behind the existing testnet toggle
  }
```

- `parseAssetId` (`app/config/assets.ts` lines 279-293) gains `/^evm:(\d+):([A-Z0-9]{2,10})$/`
  (shape-check only; membership is `reconcileSelectedAsset`'s job, unchanged).
- `linkNetworkOf` (lines 380-384) gains the evm arm: returns the chain SLUG — `42161 → 'arbitrum'`,
  `1 → 'ethereum'`, `421614 → 'arbitrum-sepolia'`, `31337 → 'anvil'` — the slugs live once in
  `app/evm/chains.ts` (`EVM_CHAINS`, stream S2) and are re-exported nowhere else.
- Payment links: `network=` stays REQUIRED and names the settlement chain (`app/lib/deepLink.ts`
  lines 26-27); `normaliseNetwork` (line 93) already lowercases+hyphenates, so a hand-typed
  `network=Arbitrum%20One` still mismatches the pinned slug `'arbitrum'` and is REFUSED
  (`wrong_network` — `app/config/assets.ts` lines 441-447). The canonical spellings for shared
  links are exactly `arbitrum` and `ethereum` (the founder's `?network=arbitrum` example), pinned
  by jest.
- `visibleEvmKeys(networks?)` mirrors `visibleSolanaMints` (lines 172-184): the `(chainId, token,
  address, decimals)` tuples the balance hook polls, so the rendered rows and the polled set can
  never drift (the stated invariant of the SOL helper).
- `buildSelectableAssets` (lines 125-169) appends the evm rows after the solana rows, gated on a new
  `opts.evmEnabled` flag (the `solanaEnabled` precedent, off under jest/e2e until a rail is
  configured — D11).

### D8 — Compatibility story

Old app + new relay: `parseNetworkCatalog` skips the unknown `'evm'` protocol whole
(`app/config/catalog.ts` lines 110-113) — EVM rows silently absent, nothing crashes, IC/SOL
untouched. New app + old relay: `evmAssetsOf` finds no evm sections; the evm arm never renders.
Both directions fail closed with zero migration. The frozen payment wire is untouched (catalog
metadata, not wire bytes — the catalog v2 precedent, lines 18-26).

---

## 2. App module map

### D9 — `app/evm/` file list (who owns what)

Owned by stream S2 (already running; golden-vector jest tests are its deliverable):

- `app/evm/identity.ts` — SLIP-10 secp256k1 at m/44'/60'/0'/0/0 over the `Identity.secretHex` seed;
  exports `deriveEvmKeypair(secretHex)`, `deriveEvmAddress(secretHex)` (EIP-55 checksummed),
  `isValidEvmAddress(addr)` (0x + 40 hex; well-formedness, not existence — the
  `isValidSolanaAddress` decode-the-answer discipline, `app/solana/identity.ts` lines 88-115), and
  `secp256k1Sign(msgHash)`. PURE.
- `app/evm/rlp.ts` — RLP encode/decode. PURE.
- `app/evm/tx.ts` — EIP-1559 (`type 2`) unsigned tx build + `signEvmTx(keypair, tx)` producing the
  raw bytes and the tx hash; legacy (type 0) build for Anvil-only fallback if ever needed. PURE.
- `app/evm/abi.ts` — the four selectors this rail needs, hand-pinned with golden vectors:
  `transfer(address,uint256)` = `0xa9059cbb`, `balanceOf(address)` = `0x70a08231`,
  `permit(address,address,uint256,uint256,uint8,bytes32,bytes32)` = `0xd505accf`,
  `transferFrom(address,address,uint256)` = `0x23b872dd`, plus `nonces(address)` = `0x7ecebe00` and
  `DOMAIN_SEPARATOR()` = `0x3644e515` for the permit read path. PURE.
- `app/evm/permit.ts` — the EIP-712 permit typed-structure builder + `signPermit(...)`: domain
  `{name, version, chainId, verifyingContract}` from the token registry entry, Permit
  `{owner, spender, value, deadline, nonce}`, 65-byte `r||s||v` signature. PURE.
- `app/evm/chains.ts` — the registry that makes "any ERC-20 = a registry entry" true:
  `EVM_CHAINS` (`{1: {slug:'ethereum', name:'Ethereum', nativeSymbol:'ETH', nativeDecimals:18,
  explorer:'https://etherscan.io', logPageSize:2000}, 42161: {slug:'arbitrum', name:'Arbitrum One',
  explorer:'https://arbiscan.io', logPageSize:10000}, 421614: {…'arbitrum-sepolia'…}, 31337:
  {slug:'anvil', name:'Anvil', explorer:null}}`) and `EVM_TOKENS` (`{'ZCHF': {decimals:18,
  permitName:'Frankencoin', permitVersion:'1', addresses: {1:'0xB58E…', 42161:'0xD4dD…'}}}`).
  `permitName`/`permitVersion` exist because the EIP-712 domain is a TOKEN fact, not a chain fact;
  the values are verified against the on-chain `DOMAIN_SEPARATOR()` by the §6 probe before any
  permit ships, and a new token joins by adding a row here + a catalog row (D1/D2) — no call-site
  changes. PURE.

New in this spec's streams:

- `app/evm/rpc.ts` — the JSON-RPC 2.0 client over `fetch` with the candidate walk, the bounded
  timeouts, the `dpayRelayError` marker classification and the honest failure taxonomy. NETWORK
  module (dynamic-import only, D10). Mirrors `app/solana/rpc.ts` (its header comment, lines 1-58,
  is the spec): transport failure → next candidate; 5xx or a `evm-upstream-unreachable`/
  `evm-unconfigured` marker body → next candidate; 429-cooldown skip; 4xx answers and stops;
  exhaustion precedence marker > relayed-5xx > cooldown > last-transport-error. Exposes:
  `ethChainId`, `ethGetBalance`, `ethCall(to, data)` (balanceOf/nonces/DOMAIN_SEPARATOR),
  `ethGasPrice`, `ethMaxPriorityFeePerGas`, `ethEstimateGas`, `ethBlockNumber`, `ethGetLogs`,
  `ethGetTransactionReceipt`, `ethSendRawTransaction` (NEVER cached, pass-through, no walk-worth
  re-sign — the `skipPreflight`/never-a-blind-re-sign posture of `app/solana.ts` lines 155-225
  carries: the same signed bytes may WALK to the next home, EVM nodes dedup by tx hash).
- `app/evm/qr.ts` — the offline wire codec (D21). PURE.
- `app/evm/claim.ts` — `decideEvmPayerReceipt` + the merchant settle sequence helpers (D24/D25).
  PURE over injected callables; network reached only through the seam.
- `app/evm/history.ts` — `fetchEvmHistory(chainId, address, token)`: `eth_getLogs` Transfer-topic
  paging per `EVM_CHAINS[chainId].logPageSize` with a persisted block cursor, direction from
  `(from|to == wallet)`, counterparty the OTHER topic, failed txs included (a reverted tx emits no
  Transfer log, so the EVM analog of "failed txs are included" is: the gas-only `eth_getBalance`
  delta row is out of scope iteration 1; failed sends surface via the receipt poll, not history).
  NETWORK module.

### D10 — The seam `app/evm.ts`, and `evmRpcUrl`/`evmRpcUrls`

`app/evm.ts` mirrors `app/solana.ts` exactly (isolation boundary; its header comment lines 1-33 is
the contract): static imports of ONLY the PURE modules (`evm/identity`, `evm/rlp`, `evm/tx`,
`evm/abi`, `evm/permit`, `evm/chains`, `evm/qr`); the network module reached via
`await import('./evm/rpc')` INSIDE async network functions, gated on a non-empty `evmRpcUrl(chainId)`
— with the URL empty (jest.setup.js + the e2e driver, D11) everything no-ops or throws and the
offline inner loop never imports the network module. Exported surface (name-by-name mirror of the
SOL seam's exports, `app/solana.ts` lines 65-62):

```ts
export {deriveEvmAddress, isValidEvmAddress} from './evm/identity';
export type {EvmHistory, EvmHistoryRow} from './evm/history';
export function preloadEvmRpc(): void;                     // mirror of preloadSolanaRpc (line 137)
export async function loadEvmRpcForSend(deadlineMs?, load?): Promise<…>;  // mirror, 10s bound (line 152)
export type EvmReadFailure = 'refused' | 'offline' | 'unreachable' | 'unreadable';  // same taxonomy
export type EvmTokenBalanceResult = {kind:'offline'} | {kind:'balance'; amount:string}
  | {kind:'error'; failure:EvmReadFailure};                // no 'absent' arm: an EVM balanceOf
                                                           // answers 0 for any address — measured
                                                           // behavior, unlike SOL's null account
export type EvmBalancesRead = {gas: Record<number, {kind:'offline'|'balance'|'error', wei?:string, failure?:EvmReadFailure}>,
                               tokens: Record<string, EvmTokenBalanceResult>};  // key `${chainId}:${token}`
export async function readEvmBalances(secretHex, keys: EvmKey[], signal?): Promise<EvmBalancesRead>;
export async function getEvmHistory(chainId, address, signal?): Promise<EvmHistoryResult>;
export async function quoteEvmFee(chainId, from, to, data): Promise<{maxFeeWei:string; baseFeeWei:string; gasUnits:string}>;
export async function sendErc20(secretHex, {chainId, tokenAddress, to, rawAmount}, signal?): Promise<{txHash:string}>;
export async function getEvmReceiptStatus(chainId, txHash, signal?): Promise<'included'|'pending'|'failed'|'unknown'>;
export function isEvmRpcAvailable(chainId: number): boolean;      // mirror of isSolanaRpcAvailable (line 965)
export function createEvmPaymentRequest(input): {req:EvmReqV1; uri:string};   // OFFLINE-capable (D21)
export function signEvmPermitClaim(secretHex, req: EvmReqV1): EvmPayV1;       // OFFLINE signer (D22)
export async function settleEvmClaim(secretHex, claim: EvmPayV1, signal?): Promise<EvmReceiptV1>;  // merchant
export function decideEvmPayerReceipt(receipt, expectedRid, expectedTxHash): EvmPayerOutcome;      // D25
export {encodeEvmReq, decodeEvmReq, encodeEvmPay, decodeEvmPay, generateRid} from './evm/qr';
```

Endpoint resolution lives in `app/config/constants.ts` beside the SOL machinery (lines 160-300):

```ts
export const EVM_RPC_PROXY_PATH = '/api/v1/evm/rpc';   // the relay route (crates/dpay-relay/src/evm.rs)
export function evmRpcUrls(chainId: number): string[]; // precedence, top wins:
export function evmRpcUrl(chainId: number): string;    // = evmRpcUrls(chainId)[0] ?? ''
```

Precedence (the `solanaRpcUrls` lines 178-244 pattern, verbatim structure):

1. OPERATOR override — persisted `dpay.evmRpc.v1` (Settings ▸ Advanced, D11), single candidate,
   `''` clears (follow the relay again, never an offline switch).
2. TEST override — `__DPAY_TEST_EVM_RPC_URL` captured at module load (jest.setup.js sets `''`;
   the e2e driver injects `'stub'`, an anvil URL, or deletes it for the relay-derived path —
   mirroring `e2e/harness/driver.mjs` lines 247-264). Single candidate; the offline loop's
   isolation contract.
3. Relay-derived — each active relay base + `/api/v1/evm/rpc/{chainId}` (the per-chain suffix,
   D12). LANDED FACT (2026-09-26, commit `9cecd64`): S1 shipped the bare single-route form
   (`POST /api/v1/evm/rpc`, one `DPAY_EVM_RPC_URL`), which serves chain 1 exactly. The per-chain
   suffix parse + `DPAY_EVM_RPC_URL_<CHAINID>` lookup is now a REQUIRED follow-up on that module
   (small: one `Path<String>` extractor and an env-name builder); until it lands, the app's
   candidate list for every non-1 chain resolves to the bare route and MUST be treated as
   unavailable (a 31337/42161 envelope sent to a chain-1 node is a wrong-chain send — the seam
   gates on `eth_chainId` matching the requested chainId before any send, D15).

`isEvmRpcAvailable(chainId)` = head of the list non-empty (line 965's mirror). The send-path
deadline table (module header lines 35-60) is restated for EVM: import load 10s; per-call rpcFetch
8s halving; `ethGetTransactionReceipt` poll 1.5s with a 60s confirm deadline; whole-sheet submit
60s via the same `abortable` wrapper (lines 74-97) — a send that outlives its deadline REJECTS
into the honest-unknown state.

### D11 — Settings ▸ Advanced override + e2e injection

`app/components/SettingsSheet.tsx` lines 238-268 seed, draft, apply and clear the SOL RPC override;
the EVM field clones that block exactly (one draft/applied state pair, one live readout), keyed on
`dpay.evmRpc.v1`. Because the override is per-DEVICE, not per-chain, the copy names what it
overrides: "EVM RPC endpoint (all chains)". E2e/jest injection: `app/jest.setup.js` line 23 gains
`globalThis.__DPAY_TEST_EVM_RPC_URL = '';` and `e2e/harness/driver.mjs` gains the evaluate/
re-point pair (lines 247, 263-264 mirror). Nothing in prod sets the global (the POLL seam's
guarantee, `app/config/constants.ts` lines 100-107).

### D12 — Chain multiplexing on the relay (coordination item with S1)

One JSON-RPC upstream serves ONE chain, so the relay must route by chain while staying a pure pipe.
Spec: the route accepts a path suffix — `POST /api/v1/evm/rpc/{chain_id}` — reads NOTHING from the
body for routing, and maps chain id → upstream env: `DPAY_EVM_RPC_URL_<CHAINID>` (e.g.
`DPAY_EVM_RPC_URL_42161`) first, `DPAY_EVM_RPC_URL` as the default-chain (1) upstream, and 503
`{"dpayRelayError":"evm-unconfigured","detail":"…"}` naming the exact missing env var for any chain
with no upstream. Transport death stays 504 `evm-upstream-unreachable` (the S1 markers, preserved
verbatim). The bare `/api/v1/evm/rpc` route == chain 1 so S1's in-flight single-route work remains
correct as-is; the suffix parse is the one addition to request from that stream. READ_METHOD_TTLS
gains (`crates/dpay-relay/src/solana.rs` lines 79-105 is the table and its reasoning):
`eth_call` 2s, `eth_getBalance` 2s, `eth_getTransactionReceipt` 5s, `eth_getLogs` 5s,
`eth_blockNumber` 2s, `eth_chainId` 3600s, `eth_gasPrice` 10s, `eth_maxPriorityFeePerGas` 10s;
`eth_estimateGas` and `eth_sendRawTransaction` pass through uncached (estimateGas is pending-state
dependent; sends are never cached anywhere, ever).

---

## 3. UI integration

### D13 — The IA hard rule governs: parameterize, never fork

CLAUDE.md ("every currency is handled through the SAME UI surfaces and flows"; a per-rail
special case in the wallet IA is a bug) is the binding constraint. The EVM rail slots into the
existing surfaces: the same Balances list + select, the same Pay/Receive tab structure, the same
Receive `[Request payment | My address]` and Pay `[Scan to pay | Send to address]` toggles. The
implementation shape: the evm SelectableAsset arm (D7) flows through `buildSelectableAssets` into
every selector, and the rail-specific ENGINE mounts per protocol the way `SolPayMode`/`SolReceiveMode`
already branch on `protocol === 'solana'` (`app/components/ReceiveMode.tsx` line 65). New engine
components are acceptable ONLY where the money mechanics differ (send gas gate, merchant settle) —
and even then the entry-point shape stays uniform.

### D14 — Receive ▸ My address: bare EIP-55 address QR

The EVM "My address" sub-mode renders the device's 0x address as EIP-55 checksummed text + QR +
copy + explorer link. QR payload = the bare checksummed address (`0x…`): it is Ethereum's de-facto
exchange/wallet standard, it is what OISY/etherscan display, and a scheme-less code is scannable by
generic wallets — no `ethereum:` URI (EIP-681 is NOT adopted here: no interchange need yet, and the
shareable request surface is the dpay pay LINK, per the founder decision of 2026-09-12 recorded in
CLAUDE.md). Copy + the explorer link reuse the `LinkRow` pattern
(`app/components/ConvertCrossRailStatePanel.tsx` line 300: `https://etherscan.io/tx/…`); the
account section shows ONE address with the chain note ("same address on Ethereum and Arbitrum
One" — the one-key-many-chains fact, stated because the address section names a chain today for
SOL/IC). Explorer absent (Anvil) ⇒ no link rendered, never a dead link. Funding instructions follow
the VCHF/ICP precedent (`IcrcDepositSheet`, CLAUDE.md "useful practical instructions" rule): name
the asset (ZCHF), the network (Arbitrum One), the address, and "no memo/reference needed".

### D15 — Send sheet: gas honesty is a gate, not a footnote

The EVM send path (Send-to-address sub-mode and link prefill) mirrors `SendSheet` + the SOL withdraw
shape (`app/components/SendSheet.tsx`, `app/components/SolanaWithdrawSheet.tsx`; flow 52's
route-disclosure-before-amount discipline):

1. Destination validated by `isValidEvmAddress` + `eip55ChecksumBad` warning on a wrong-checksum
   paste (warn + require explicit continue; a fully-lowercase/uppercase address is legal EVM but
   uncheckable — say so once, never block).
2. Fee quote BEFORE the amount is committed: `quoteEvmFee` = `eth_estimateGas` + baseFee +
   priority → `maxFeeWei` shown as "Fee ≈ <compact ETH>" (the founder fee-line rule; attribution
   "estimate" because dpay never quotes — this is the chain's own arithmetic over the user's own
   typed inputs).
3. THE GATE: read `eth_getBalance(from)`; if `maxFeeWei + 0 > gasBalance` (or amount+fee would
   zero the account below dust), the sheet REFUSES with the instructive failure: "You need ≈
   <X> ETH on <chain> for the network fee. Receive ETH at <your 0x…> (QR) — your ZCHF is ready
   to spend the moment the gas is there." (founder rule: every error path instructs).
4. Sign type-2 tx (`signEvmTx`), broadcast `eth_sendRawTransaction`, confirm by receipt poll
   (1-block soft inclusion ⇒ "Sent · seen on <chain>", never "finalized" — the confirm-UX policy
   pinned in OPEN_ISSUES.md's EVM entry).

The ckUSDC in-intent gas-fund offer does NOT carry over mechanically: that offer (flow 196,
`app/components/ConvertMode.tsx` lines 1682-1723) funds an EXTERNAL destination wallet through
in-wallet conversion legs — here the wallet IS the payer and its own gas source, and dpay wires no
ETH purchase path, so there is nothing to offer honestly. What DOES carry over is the machinery:
the MEASURED-have discipline (`fetchEthBalance`, `app/cctp.ts` lines 275-316 — unmeasurable is
unknown, never zero) and the fail-closed preflight. Iteration 1 gate = refuse + instruct (D15.3);
a gas-fund card arrives only with a real funding route into native ETH. Note: `fetchEthBalance`
dials publicnode DIRECTLY today; the EVM rail's own reads go through the relay pipe (D12) —
`cctp.ts` is a shipped flow and is left alone (a consolidation to the pipe is a separate, optional
cleanup, not this spec's change).

### D16 — Home list balance poll + history rows

- Balances: `useEvmBalances` (a twin of `app/hooks/useSolanaBalances.ts`) polls
  `readEvmBalances` over `visibleEvmKeys()` — one `eth_getBalance` per CHAIN the user has visible
  evm rows on (gas honesty needs it even at zero tokens) + one `eth_call balanceOf` per visible
  token row, at the shared active/idle cadence machinery (`POLL.balance` 2.5s active /
  `POLL.balanceIdle` 30s idle, `app/config/constants.ts` lines 109-135; backgrounded = zero
  requests, the flow-160 budget rule). Five states stay distinct exactly as SOL's do
  (`app/solana.ts` lines 246-294) minus `absent` (D10). Wallet renders the evm rows through the
  SAME `CurrencyRow`/balance-view path.
- Permit nonces piggyback: every 5th tick (≈12.5s active, 150s idle) the poll also reads
  `nonces(owner)` per (chain, token) into the claim queue's nonce cache (D22). One extra
  `eth_call` per token, amortized.
- History: `useEvmHistory` (twin of `app/hooks/useSolanaHistory.ts`) drives `getEvmHistory` per
  (chain, token) at `POLL.history`/`historyIdle`; rows render through the existing
  `HistoryRow`/`useTransactionHistory` merge with `assetId: 'evm:<chainId>:<TOKEN>'`; tx-notes
  annotation rides the existing `app/services/txNotes.ts` keyed by tx hash (flow 172's
  name-the-log discipline).

### D17 — Pay links: `?asset=ZCHF&network=arbitrum`

`resolvePayLink` (D7) resolves `(ZCHF, arbitrum)` onto the evm asset; the link opens the
Send-to-address form PREFILLED with destination + amount and the route disclosed before the amount
is committed (the SOL link behavior, flow 176: "SOL pre-fills Send-to-address with the NETTED
wire"). A link is never auto-signed; the full 0x destination renders; a `ZCHF` link with
`network=internet-computer` or `network=solana` refuses `wrong_network` naming both the asset and
the chain (`app/config/assets.ts` lines 441-452). `app/lib/destination.ts` already classifies a
`0x…` as the `'evm'` namespace (line 30, `RE_EVM` line 70) — the send route now has a rail to
OFFER that namespace: with an evm asset selected, a 0x destination routes to the EVM send; on an
IC/SOL asset the existing refusal copy stays.

### D18 — Request auto-confirm: offline-claim settle confirms the screen; direct link payments do NOT

The `POLL.request` precedent (flow 176) auto-confirms an IC request when the link's `ref` (= the
request nonce = the on-chain memo) shows up in the ledger. On EVM there is NO memo channel: ERC-20
`transfer`/`transferFrom` carry no reference field, and matching on `(to, amount, recency)` would
false-confirm the fixed-price case (two customers paying the same menu price in one window). So,
SOL-parity (`ref: null`, OPEN_ISSUES 2026-09-12 record): EVM link payments do NOT auto-confirm the
open request screen. The offline claim path is the exception, and it is deterministic: the request
was MINTED on this merchant device with a `rid` (D21), the claim ECHOES the `rid`, and the settle
action (D24) flips the matching open request to Received on success. The screen states what is
true: "You'll see it here the moment it settles; dpay links confirm on settlement, dpay offline
claims confirm on the tap's receipt."

### D19 — Native ETH gas visibility without a selectable ETH row

Iteration 1 ships ZCHF rows only, but the gas gate (D15) and the receive sheet need the native ETH
balance visible. The evm balance read carries the per-chain `gas` leg (D10) and the send sheet +
receive address section render it ("Gas: 0.00013 ETH"). A selectable native-ETH asset row is a
fast-follow that the schema already supports (`address: null`, the SOL `mint: null` precedent,
`crates/dpay-relay/src/catalog.rs` ~1049) — deliberately deferred (YAGNI; no ETH payment story
until someone asks for one).

### D20 — Funding honesty: Unavailable ramps, working transfer-in

`onramp: Unavailable`/`offramp: Unavailable` on every EVM row (D2) means no Add money / Cash out
buttons (the VCHF/ICP fiat-ramp-honesty precedent, CLAUDE.md). DepositMechanism for an evm row is
`'send-to-address'` — a rail property asserted at the EVM surface, the SOL precedent
(`app/config/catalog.ts` lines 336-349), so the funding-routes card says: get ZCHF from any wallet
or exchange that supports Frankencoin, send on Arbitrum One/Ethereum to YOUR 0x address shown
below, no memo; keep a little ETH on the same address for gas when you want to pay it onward.

---

## 4. Offline permit flow (iteration-1 REQUIRED)

### D21 — The wire: `evmreq:v1?` / `evmpay:v1?` (QR; NFC later, same bytes)

Mirrors `app/solana/qr.ts` (schemas frozen, golden-tested; the HARD CANONICAL INVARIANT
`encode(decode(raw)) === raw`; decode never trims, reorders, pads or accepts trailing bytes; all
decode failures are typed errors). Size caps: name/memo ≤ 32 UTF-16 units (parity); URI ≤ 2000
chars. The request window: `iat < exp ≤ iat + 600` (600s, not SOL's 90s: replay protection is the
ON-CHAIN permit nonce, not a short client window, so generosity costs nothing — the settle-first-wins
model and the on-chain nonce are what make replay impossible; D24).

```ts
// evmreq:v1?<base64url(canonical json)>   merchant → payer (works OFFLINE on both sides)
export interface EvmReqV1 {
  v: 1;
  rid: string;        // 32 lowercase hex (16 random bytes) — binds request ↔ claim ↔ receipt
  chainId: number;    // the settlement chain (42161 | 1 | …)
  token: string;      // 'ZCHF' (registry symbol; the contract address resolves via EVM_TOKENS)
  to: string;         // merchant 0x address (EIP-55)
  amt: string;        // decimal-digit string of RAW units (18-dec ZCHF), BigInt-safe
  iat: number;        // unix seconds
  exp: number;        // unix seconds; == the EIP-2612 deadline
  name: string;       // merchant display name ("" ok)
  memo: string;       // optional note ("" ok)
}
// evmpay:v1?<base64url(canonical json)>   payer → merchant (the offline claim)
export interface EvmPayV1 {
  v: 1;
  rid: string;        // echoes the request
  owner: string;      // payer 0x address (the permit's `owner`; the merchant needs it for
                      // permit() + transferFrom and it saves the merchant a recovery step)
  deadline: number;   // == req.exp (the permit's deadline field)
  sig: string;        // 65-byte r||s||v as 130 lowercase hex chars — the EIP-2612 permit signature
}
```

What crosses the boundary is exactly: `chainId, token(→address via registry), to, amt, deadline,
rid` on the request; `rid, owner, deadline, sig(65B)` on the claim. The permit's `spender` IS the
merchant's `to` address (self-permit then transferFrom to self). The permit `value` IS `amt`.
`createEvmPaymentRequest` needs NO chain read (no blockhash analog — the SOL request is online
because of the blockhash; the EVM request is fully offline), which makes the merchant's request QR
work in the same degraded connectivity as the payer's signature.

### D22 — The permit nonce problem and its answer

EIP-2612 `permit` carries an on-chain `nonce(owner)` — normally read online, but the payer is
offline at sign time. The wallet is the only consumer of its own permit nonces (single device per
seed; the seed re-imported into another wallet is the documented recovery flow, not a race), so:

1. The balance poll caches `nonces(owner)` per (chain, token) every 5th tick (D16), in the claim
   queue's storage (D23).
2. Each offline sign consumes the CACHED nonce and increments the cache optimistically (both the
   queued claim and the cache update happen before the QR is shown).
3. A stale guess (seed used elsewhere) fails ON-CHAIN at the merchant's `permit()` call with a
   deterministic revert; the merchant reports `failed(nonce)`; the claim stays queued with a
   `needsResign` marker; the payer's next online moment re-reads the true nonce and re-signs a
   FRESH claim with the same rid (a re-sign of NEW parameters after a PROVEN on-chain failure —
   never a blind re-sign, the `app/solana.ts` lines 200-207 rule).
4. `isEvmReqExpired` mirrors `isSolReqV2Expired` (`app/solana/payments.ts` lines 76-92): valid
   through the expiry second; the 600s advisory cap enforced at decode too.

### D23 — The claim queue (merchant side, AsyncStorage)

`app/services/evmClaimQueue.ts`, a list-shaped twin of `app/services/solMerchantPersist.ts` (the
SOL store is single-request; a merchant collects MANY offline claims while offline, so the shape is
an array, schema-versioned envelope, per-identity key `dpay.evm.claims.v1.<identityPubHex>`, capped
at 50 with oldest-settled eviction, best-effort load — corrupt value → empty, never thrown):

```ts
export type EvmClaimState = {
  claim: EvmPayV1;
  reqName: string; reqMemo: string;      // display, carried from the request
  status: 'queued' | 'settling' | 'settled' | 'failed' | 'unknown';
  txHash: string | null;                 // set on settled/unknown (the reconciliation handle)
  permitNonce: number;                   // the nonce consumed (diagnostics + needsResign flow)
  failReason: 'nonce' | 'expired' | 'rejected' | 'gas' | null;
  attempts: number;                      // settle re-entry guard (max 3, then 'failed' honestly)
  settledAtMs: number | null;
};
```

Transitions: queued → settling (atomic reservation BEFORE the first network send, the SOL
invariant #11 pattern) → settled (clear the open-request flip; keep the row for history annotation)
| failed (terminal reasons kept for the merchant to act on) | unknown (transport death after
broadcast — the tx MAY land; preserved for reconciliation, the invariant #12 pattern; re-entry
checks the chain before re-sending, D24). Payer side: the payer's own sent-claim log (rid → status)
lives in the SAME store under the payer key so history rows and receipts can annotate
(`app/services/txNotes.ts` consumes it).

### D24 — Merchant settle: `permit` then `transferFrom`, gas from the merchant's ETH

`settleEvmClaim` (seam, D10) implements, in order:

1. Pre-checks (all BEFORE any spend): req-not-expired (`isEvmReqExpired`); duplicate guard — the
   queue holds no settled claim with this rid, AND a `eth_getLogs` on the token for
   `Transfer(owner → to, amt)` since the claim's arrival block finds nothing (the idempotent
   re-entry for the `unknown` state: if the money already moved, mark settled with the found hash
   and spend nothing); merchant gas gate — `eth_getBalance(merchant)` ≥ 2 × estimated fee or
   refuse `failed(gas)` (the founder rule: the error names the fix — "your <chain> ETH is
   exhausted; receive ETH at <merchant 0x>").
2. `permit()`: build `permit(owner, spender=to, value=amt, deadline, v, r, s)` via
   `evm/abi.ts`, sign EIP-1559 with the MERCHANT key, broadcast, wait receipt (60s deadline,
   poll 1.5s). A failed permit receipt is classified: revert reason mapping where the node
   surfaces it, else `failed(nonce)` for a consumed-nonce-shaped failure — the D22.3 signal.
3. `transferFrom(owner, to, amt)`: only after the permit receipt confirms inclusion (sequential;
   the same-block consecutive-nonce optimization is a measured fast-follow, not iteration 1 —
   a reverted permit would burn gas twice under the optimistic ordering). Sign, broadcast,
   receipt. Success ⇒ `EvmReceiptV1 {status:0, rid, sig: txHash}`; the queue records settled;
   the open request with the matching rid flips to Received (D18).
4. Double-spend honesty = settle-first-wins, stated precisely: the FIRST successful
   `transferFrom` is the payment; the permit nonce makes the permit single-use on-chain; the queue
   makes the rid single-use locally; and a claim handed over twice (QR shown twice) still settles
   once, because the second settle's pre-check (1) finds the Transfer log or a consumed permit
   nonce and marks it settled/failed with no second spend. This is the flow-177 model
   (`FLOWS.md` line 98: the allowance is a pull-claim the merchant collects), with the merchant's
   key paying gas instead of the IC wallet signing.

### D25 — Receipt and payer outcome

`EvmReceiptV1 {status: 0=settled | 1=rejected | 2=unknown, rid, sig: txHash}` (the
`SolReceiptV2` shape, `app/solana/payments.ts` lines 47-55; the 3=mismatch arm has no EVM analog
because the merchant never hands back a tx it did not itself broadcast — a claim receipt IS the
merchant's own tx hash). `decideEvmPayerReceipt(receipt, expectedRid, expectedTxHash?)` mirrors
`decideSolPayerReceiptV2` (lines 87-110): both bindings must match, hex compared
lowercase-normalized EXPLICITLY on both sides (stated, unlike SOL's case-sensitive base58 — hex
case is display noise; the normalization is total and named, never implicit); unknown status
codes → honest pending, never a false decline. UX reuse from flow 177 / the SOL offline rail: the
payer screen shows "Sent · awaiting settlement" (honest pending) on status 2, "Paid" on 0,
"Declined" on 1; the merchant settle action rides the ordinary request/receive screen (no new
surface), which is exactly how the SOL merchant broadcast works (`app/components/SolReceiveMode.tsx`
lines 344-422). NFC transport for the claim is a fast-follow carrying the SAME `evmpay:v1` bytes
(the SOL HCE transport precedent, `SolNfcTap`); the IC core's NFC protocol is untouched.

---

## 5. Local env + e2e

### D26 — `just evm-anvil`

A new justfile recipe (beside `test-relay`, `justfile` line 123) that stages the whole local chain
and prints the config the harness and a human both consume:

1. Spawn `anvil -p 8545 --chain-id 31337 --block-time 1` (1s blocks so receipt polls behave like
   Arbitrum's cadence, not instant). The binary is vendored under `third_party/bin/anvil` (the
   pocket-ic precedent, CLAUDE.md "Local dev cache & offline"); if absent, the recipe fails loud
   with the one-line fetch command (foundry release pinned by checksum in the recipe comment).
2. Deploy the mock token: `e2e/harness/evm/MockZCHF.hex` is a COMMITTED bytecode blob — a minimal
   OZ-style ERC20Permit (solc 0.8.x, optimizer on), compiled ONCE and committed with its source +
   solc version + a `sha3` of the bytecode in an adjacent README (the offline inner-loop rule:
   no forge/solc at runtime). The harness deploys it with a type-2 tx signed by anvil's well-known
   account #0 key (`0xac09…`, public and valueless) using the `e2e/harness/evm-sign.mjs` signer
   machinery (keccak + secp256k1 + RLP + EIP-1559 already implemented there on the same @noble
   packages, lines 1-30) — extract that core into `e2e/harness/evm/evm-core.mjs` so both the
   float tool and the harness import one implementation.
3. Fund the DEVICE key: the e2e driver reads the rendered 0x address off the receive surface
   (D14's testID) and calls `anvil_setBalance(addr, 10 finney)` + transfers mock ZCHF from the
   deployer to it (a plain signed transfer via evm-core) — no seed knowledge needed driver-side.
4. Print the config block (rpc url, chain id 31337, token address, deployer address) as JSON to
   stdout AND write it to `e2e/harness/evm/anvil.json` for the flows to read.

The relay for e2e is the harness relay (`e2e/harness/relay.mjs`); it gains
`DPAY_EVM_RPC_URL: process.env.DPAY_EVM_UPSTREAM ?? 'http://127.0.0.1:<port>/api/v1/test/evm-upstream'`
— named EXPLICITLY so a shell-exported variable can never leak in (the
`DPAY_SOLANA_RPC_URL` lines 237-241 pattern), the stub upstream rides the same test-helpers relay,
and the anvil flows set `DPAY_EVM_UPSTREAM=http://127.0.0.1:8545` so the app talks pipe → anvil,
exercising the REAL proxy route end-to-end (the flow-165 discipline: `e2e/tests/165-solana-via-relay`
proves the proxy, not a direct dial).

### D27 — Driver injection points

`e2e/harness/driver.mjs`: `globalThis.__DPAY_TEST_EVM_RPC_URL = 'stub'` by default (line 247
mirror; 'stub' = the harness relay's suffixed proxy route, which fronts the stub upstream);
anvil flows delete/replace it; `__DPAY_TEST_EVM_RPC_URL = ''` stays the jest default
(`app/jest.setup.js` line 23 mirror). The offline-claim flow asserts zero network traffic during
the offline phases by pointing the seam at a dead URL during sign (the flow-46 offline
discipline, `e2e/tests/46-sol-offline-handoff.mjs`).

### D28 — New e2e flows (next free ids; the suite currently ends at 212)

| id | file | proves |
|----|------|--------|
| 213 | `e2e/tests/213-evm-receive.mjs` | device-derived 0x address renders EIP-55-checksummed in Balances + Receive ▸ My address (QR + copy + explorer link, no explorer on Anvil); the address matches `deriveEvmAddress(seed)` asserted jest-side via golden vectors; zero RPC at render (seam `''`). |
| 214 | `e2e/tests/214-evm-send-history.mjs` | anvil funded → send sheet quotes a fee, passes the gas gate, signs + broadcasts THROUGH the harness relay's evm proxy (stub→anvil upstream hit recorded), receipt confirms "seen on Anvil", history row appears via the `eth_getLogs` poll, balance drops by amount+fee. |
| 215 | `e2e/tests/215-evm-offline-claim.mjs` | the offline permit loop: merchant request QR (`evmreq:v1`) → payer signs OFFLINE (dead-URL seam) → claim QR scanned back → merchant settle (permit + transferFrom through the pipe) → both screens flip; the double-hand-off second settle settles NOTHING and reports settled/failed without a second spend (D24.4). |
| 216 | `e2e/tests/216-evm-paylink.mjs` | `…/wallet/pay/<0x…>?asset=ZCHF&network=arbitrum` prefills the send form on the evm asset (route disclosed, never auto-signed); `network=solana` + `asset=ZCHF` refuses `wrong_network` by name; camera-scanned request QR opens the link (the flow-176 loop, evm arm). |
| 217 | `e2e/tests/217-evm-gas-gate.mjs` | a zero-ETH wallet with mock ZCHF refuses to send with the D15.3 instructive gate (fee shown, receive-ETH instruction, no broadcast), and passes once funded. |

All five ride the existing `setup()` harness (`e2e/tests/45-sol-receive.mjs` shape) and the
`__DPAY_TEST_POLL` cadence override; none touches real networks.

---

## 6. Testnet + mainnet probes

### D29 — Arbitrum Sepolia round trip (free path, time-boxed per the live-testing rules)

`scripts/evm-probe-arbitrum-sepolia.mjs`, riding `e2e/harness/evm-core.mjs` (D26.2) with `cast`
one-liners documented beside it for a human (cast availability is NOT assumed in the sandbox; the
script must not require it):

1. Fund: claim from an Arbitrum Sepolia faucet (the 10-minute time-boxed search rule; outcome
   recorded in `docs/live-testing/networks.md` — free paths found get used, dead ends recorded
   with the date). Deploy the MockZCHF (or use the faucet chain's native for the gas half).
2. Round trip: `transfer` device → probe address → device; assert `eth_getTransactionReceipt`
   status 1, `eth_getLogs` Transfer topics both directions, `balanceOf` deltas exact.
3. Through the relay: repeat with `DPAY_EVM_RPC_URL_421614` pointed at a public Sepolia-Arbitrum
   RPC and the app (or the probe script) dialing the pipe — the unconfigured-marker path
   (`evm-unconfigured` 503) asserted too (send with the env unset, expect the honest refusal).
4. Record: block time, gas cost in ETH, `logPageSize` that the public RPC tolerates (getLogs range
   limits vary by provider — the measured value lands in `app/evm/chains.ts`).

### D30 — Mainnet read-only ZCHF probe (the custody-semantics gate)

`scripts/evm-probe-zchf-mainnet.mjs` (read-only, keyless, through the pipe or a public RPC):

1. For BOTH pinned addresses (D2): `eth_chainId`, `symbol()` → `ZCHF`, `decimals()` → 18,
   `balanceOf(zero)` → 0, `EIP-712 DOMAIN_SEPARATOR()` vs the locally computed
   `keccak712({name:'Frankencoin', version:'1', chainId, verifyingContract})` — a mismatch means
   the `permitName`/`permitVersion` registry entries are wrong and permit signing is BLOCKED until
   fixed (the values come from the verified source, `OPEN_ISSUES.md` EVM entry).
2. The UIMultiplier reconciliation (the OPEN_ISSUES custody-semantics gate, which blocks balance
   DISPLAY from shipping until resolved): fetch the verified source from the block explorer for
   both addresses, grep for `UIMultiplier`/`uiMultiplier`/multiplier storage; if present, measure
   it on-chain and record the exact display-scaling rule the app must apply (and where:
   indexer-side per the OPEN_ISSUES wording); if absent, record the evidence (commit + file) that
   the Etherscan note is a stale widget. The probe's verdict, not prose, unblocks D16.
3. Cross-check both addresses byte-for-byte against `dfx/catalog_truth.json` (the drift alarm's
   other half — a wrong pin dies here before it can die in a test).

### D31 — What a funded mainnet round trip needs (the acceptance gate)

Per OPEN_ISSUES ("ONE real on-chain ZCHF round trip recorded before any pilot claim") and the
live round-trip rule (CLAUDE.md, 2026-09-26):

- The agent EVM float key ALREADY EXISTS (`secrets/agent-evm.sops.json`,
  `e2e/harness/evm-sign.mjs` lines 15-17) with mainnet ETH. Required additions: registration in
  `funds/wallets.json` (the census hard rule — a derived address holding value must be
  registered) + a `docs/AGENT-FUNDS.md` derivation-path note (m/44'/60'/0'/0/0 from the float
  seed, or the standalone key's own record); dust ETH on Arbitrum One (sub-cent per transfer);
  ZCHF on one chain (float swap or a founder top-up, ≤ the CHF 2 auto-spend line where possible).
- The trip itself: the agent drives the REAL UI (receive address → external ZCHF in → send out →
  history credit), every movement through `node scripts/funds.mjs add`, `just funds reconcile`
  clean. Arbitrum first (sub-cent gas), Ethereum second (mainnet fee measured, recorded in
  `docs/live-testing/networks.md`).

---

## 7. Dependency-ordered checklist with stream boundaries

Already running (NOT re-planned here):

- **S1 (external implementer):** `crates/dpay-relay/src/evm.rs` — the pure-pipe proxy, env
  `DPAY_EVM_RPC_URL`, markers `evm-unconfigured` / `evm-upstream-unreachable`. OWNS: the route,
  cache table, markers. NEEDS FROM THIS SPEC: the per-chain suffix contract + env naming
  (`DPAY_EVM_RPC_URL_<CHAINID>`, D12) — the one coordination item.
- **S2 (external implementer):** `app/evm/{identity,rlp,tx,abi,permit,chains}.ts` + golden-vector
  jest tests. OWNS: every PURE module + vectors. NEEDS FROM THIS SPEC: the exported-signature
  list (D9) so the seam compiles against their modules unchanged.

Then, in dependency order (each item cites its decision):

1. **S3 — catalog (independent of S1/S2):** truth-file additions (D4) → relay rows + sections +
   consts (D1/D2/D3) → Rust drift alarms + wire byte pins (D5) → `EvmAsset` type + `parseEvmRow` +
   `evmAssetsOf` + bundled rows (D6) → SelectableAsset arm + ids/slugs/chip + `visibleEvmKeys` +
   link routing (D7) → jest alarm + parse fixtures (D5/D6/D8). Gate: `just test-relay` +
   `app/__tests__/catalog.test.ts` green with EVM rows served in the test-helpers build.
2. **S4 — seam + endpoints (needs S1 route contract, S2 modules):** `app/config/constants.ts`
   evm endpoint machinery (D10) → `app/evm/rpc.ts` client + walk + taxonomy (D9/D12) →
   `app/evm.ts` seam exports + deadline table (D10) → Settings field + jest/e2e injection (D11).
   Gate: jest seam tests prove the no-op contract (empty URL ⇒ no import, no fetch).
3. **S5 — UI (needs S3+S4):** receive address surface (D14) → balances/history hooks + Wallet
   wiring (D16) → send sheet + gas gate (D15) → pay-link prefill + destination routing (D17) →
   funding copy (D20) → native-gas visibility (D19).
4. **S6 — offline claim (needs S2 permit/abi, S4):** `app/evm/qr.ts` codec + golden tests (D21) →
   `app/services/evmClaimQueue.ts` (D23) → nonce cache + stale-nonce path (D22) →
   `settleEvmClaim` + `decideEvmPayerReceipt` (D24/D25) → request screen flip (D18).
   STATUS (2026-09-27, the pure core): `app/evm/qr.ts` (D21 codec, byte-interop-proven against
   `e2e/harness/evm/qr.mjs`) and `app/evm/claims.ts` (D22 nonce cache, D23 queue, D24 settle over
   an injected `EvmRpcLike`, D25 receipt decision) are LANDED with 37 jest tests
   (`app/__tests__/evm-claims.test.ts`, fully offline). Deliberate deviations: the queue lives in
   `app/evm/claims.ts`, not `app/services/evmClaimQueue.ts`, until the seam lands (same key scheme,
   50-row cap, corrupt-tolerant load); queue rows carry the FULL `req` (settle needs
   chainId/token/to/amt — the claim wire deliberately does not); the status union gains
   `needsResign` (D22.3's state, not an error); settle reaches the chain ONLY through the injected
   `EvmRpcLike` (`app/evm.ts` adapts its rpc client and wraps `settleEvmClaim`). Still open: the
   seam wrapper, the nonce-cache seeding in the balance poll (D16), and the request-screen flip (D18).
5. **S7 — anvil + e2e (needs S1, S5, S6):** MockZCHF blob + `evm-core.mjs` extraction (D26) →
   `just evm-anvil` + harness relay/driver injection (D26/D27) → flows 213-217 (D28).
6. **S8 — probes + live docs (needs S4; S6 for the permit half):** Sepolia round trip (D29) →
   mainnet read-only probe + UIMultiplier verdict (D30) → float-key census + funded mainnet trip
   (D31). Final automated gate: `just verify` (which runs e2e + the suites), then the live trip
   as the LAST acceptance step (CLAUDE.md ordering).

---

## Risks and open items

- **R1 — S1 landed single-chain (RESOLVED into a required follow-up).** `evm.rs` shipped
  2026-09-26 (`9cecd64`) as the bare `POST /api/v1/evm/rpc` + one `DPAY_EVM_RPC_URL` — correct
  for chain 1, not yet multi-chain. The suffix + per-chain env (D12) is the follow-up; until it
  lands the seam refuses to send on any non-1 chain (`eth_chainId` gate, D12/D15). Everything
  else in this spec was and is independent of it.
- **R2 — the ZCHF address literals' EIP-55 checksums are unverified in this spec.** D5's jest
  alarm self-verifies them (`eip55ChecksumBad`); a red alarm means the verified-source spelling
  wins and the truth file is corrected in the same commit.
- **R3 — UIMultiplier.** RESOLVED same-day — see Addendum 1 (A1.1): no multiplier exists on
  either pinned ZCHF contract; chain == indexer; display = raw/10^18.
- **R4 — provider `eth_getLogs` range limits** on free tiers (commonly 1k-10k blocks). The
  per-chain `logPageSize` starts conservative (D9) and is replaced by D29's measured values;
  the history cursor makes page size a performance knob, never a correctness one.
- **R5 — Arbitrum fee estimation** includes an L1 data-availability component that
  `eth_estimateGas` on an Arbitrum node already folds in; the quote is only ever shown from the
  chain's own arithmetic (D15.2), so a node-version change moves the estimate, not the trust model.
- **R6 — permit nonce staleness** (D22.3) is a real, bounded failure mode: one extra round trip
  for the user, never a fund loss; the `needsResign` path must ship with S6 or offline claims are
  not honest.
- **R7 — foundry/anvil availability**: vendoring is a fetch-once with a pinned checksum (D26.1);
  until it lands, flows 213-217 stay RED-by-absence and `just verify` must not regress
  (the recipes fail loud, they do not skip).

---

## Addendum 1 — same-day probe receipts (2026-09-26, keyless, read-only)

### A1.1 — D30.2 CLOSED: no UIMultiplier exists; balance display UNBLOCKED

Verified-source pulls (blockscout v2 api, receipts saved in `tmp/frankencoin-src.json`,
`tmp/frankencoin-arb.json`):

- Ethereum `0xB58E…21cB` "Frankencoin": plain verified solidity, not a proxy, ABI events exactly
  `{Approval, Loss, MinterApplied, MinterDenied, Profit, Transfer}` — zero `UIMultiplier`
  occurrences.
- Arbitrum `0xD4dD…5553` "BridgedFrankencoin": CCIP `CrossChainERC20`, zero `UIMultiplier`
  occurrences.
- On-chain cross-check (`ethereum-rpc.publicnode.com`): `decimals()` = 18;
  `balanceOf(0x27d9AD987BdE08a0d083ef7e0e4043C857A17B38)` = 11671150848527532348117692, which
  EXACTLY equals the indexer's raw holder value — chain == indexer, no scaling anywhere.

**Verdict: display = `balanceOf` / 10^18. The Etherscan "UI multiplier" note is an explorer-side
token-tracker display config, not chain state. R3 is resolved; D16's display gate is lifted.**

### A1.2 — D30.1 AMENDED: real ZCHF permit uses the MINIMAL EIP-712 domain

Both pinned ZCHF contracts use `ERC20PermitLight`, whose domain has NO name and NO version:

```
DOMAIN_SEPARATOR() = keccak256(abi.encode(
    0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218, // EIP712Domain(uint256 chainId,address verifyingContract)
    block.chainid,
    address(this)))
permit typehash = 0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9 // canonical, (owner,spender,value,nonce,deadline)
```

Consequences (binding for S2/S4/S6):

- The registry's `permitName`/`permitVersion` idea is DROPPED for ZCHF; replace with a per-token
  **domain-kind flag** (`minimal | full`). ZCHF on both chains = `minimal`.
- Signing a full-domain permit against real ZCHF fails `INVALID_SIGNER` — D30.1's probe MUST
  compute the minimal domain (this addendum, not the D30.1 text above, is authoritative).
- Error strings on real ZCHF: `PERMIT_DEADLINE_EXPIRED`, `INVALID_SIGNER`; UI/error mapping must
  not assume `ZCHF: …` strings.
- The dev mock mirrors all of this exactly (verified mock at `tmp/mock-zchf`, 3/3 forge tests:
  offline-permit pull-claim, expiry revert, nonce replay revert).

---

## Addendum 2 — app-side service layer LANDED (2026-09-26/27, stream S4+S3-app on `evm-rail`)

Records exactly the D-items this stream completed; everything else in §1–§7 is unchanged. The
Solana rail was mirrored everywhere (root seam, network modules, jest wiring, driver seam).

- **D6/D7 app half — LANDED, relocated by scope decision:** the parse lives in
  `app/lib/evmCatalog.ts` (NOT `app/config/catalog.ts` as first written) with `parseEvmRow`
  (fail-closed, `eip55ChecksumBad` rejects the row), `evmSectionsOf`/`evmAssetsOf` over the RAW
  wire envelope, the selectable-row shape (`evm:<chainId>:<TOKEN>`, linkToken=token, chain slugs
  `arbitrum`/`ethereum`/`arbitrum-sepolia`/`anvil` owned here as `EVM_CHAIN_SLUGS`,
  `evm-zchf-arbitrum`/`evm-zchf-ethereum` testKeys), `parseEvmAssetId`, exact-case-insensitive
  `evmTokenEq` (no VCHF collision), the `ZCHF·Arb`/`ZCHF·Eth` collision chips, and
  `visibleEvmKeys`. `AssetId` (lib/types.ts) gained the `evm:<chainId>:<TOKEN>` arm. REMAINING
  (one-line integrations, UI wave): the `'evm'` arm in `parseNetworkCatalog` +
  `opts.evmEnabled` appending `evmSelectableRow` outputs in `buildSelectableAssets` +
  `SHORT_NETWORK_TAG`'s Arb entry if the config chip path is preferred over `evmChipLabel`.
- **D10 — LANDED:** `app/evm.ts` is the isolation seam (SOL-mirror: pure static imports only;
  `evm/service` + `evm/history` reached via lazy dynamic import gated on
  `evmRpcUrl(chainId)`; the offline contract is pinned by a jest trip-wire that fails if the
  network module so much as EVALUATES). Endpoint machinery in `app/evm/endpoints.ts` (pure):
  operator override > `__DPAY_TEST_EVM_RPC_URL` (jest.setup.js sets `''`; the e2e driver option
  `evmRpcUrl` mirrors `solRpcUrl`, 'derive' deletes) > relay-derived per-chain routes. The
  wrong-chain gate is LIVE: `eth_chainId` must prove the endpoint serves the requested chain
  before any spend-shaped request OR balance read (memoized per endpoint list per session,
  never on failure; `EvmWrongChainError` names both chains). The Settings ▸ Advanced field
  (D11 UI half) is NOT in this wave; the override machinery + storage key are.
- **D12 app half — LANDED:** the client derives the bare route for chain 1 and `/{chainId}`
  for every other chain; the relay markers (`evm-unconfigured`, `evm-upstream-unreachable`,
  `evm-unknown-chain`) classify through `EvmRelayPathDown`/`EvmEndpointRefused` (brand-field
  tests, never instanceof) into the SOL read taxonomy ('unreachable'/'refused'/offline-oracle).
- **D15 app half — LANDED:** `quoteEvmFee` = the chain's own `eth_estimateGas` + `eth_gasPrice`
  + `eth_maxPriorityFeePerGas` (null → 0 priority, nothing invented; maxFeePerGas =
  2×baseFee+priority, gasLimit = estimate×1.2+1). `sendErc20` gates in money-safety order:
  wrong-chain → fee probe → THE GAS GATE (`eth_getBalance` < maxFee ⇒ `EvmGasGateError`
  carrying required/have/chain/payer-address for the D15.3 instructive copy, BEFORE any nonce
  or broadcast) → `signEip1559Tx` → `eth_sendRawTransaction` (same bytes walk, never re-sign;
  a node echoing an unexpected hash is not a verdict — the receipt decides by OUR keccak) →
  receipt poll 1.5s/60s (failed = definitive, timeout = honest unknown). Broadcasts ride the
  `abortable` seam guarantee; every step traced to the money log.
- **D9 partial (history):** `app/evm/history.ts` — `eth_getLogs` Transfer-topic paging, two
  filter legs (wallet as from / as to), dedupe, `dropped` count for foreign shapes,
  best-effort block timestamps, newest-first. The per-chain `logPageSize` idea is a SINGLE
  conservative constant (`EVM_LOG_PAGE_SIZE=2000` in `app/evm/constants.ts`) — a performance
  knob, never a correctness one (R4); D29's measured values can replace it in one place.
- **e2e seams (D26/D27 partial):** `driver.mjs` gains `__DPAY_TEST_EVM_RPC_URL=''` in the
  test globals + an `evmRpcUrl` flow option ('derive' deletes; else the URL is the whole
  list). `harness/evm/pipe.mjs` sets `DPAY_EVM_RPC_URL_31337` (so the app's per-chain route
  rides the pipe) and `DPAY_EVM_ANVIL_TOKEN` (so the real harness relay's catalog carries the
  Anvil ZCHF dev row — the fake relay IS the real binary; no separate fake catalog exists).
- **Tests:** 70 jest tests across `evm-{endpoints,rpc,seam,service,history,catalog}.test.ts`
  (walk precedence, gate ORDER, raw-tx RLP decode, gas gate, wrong-chain sends AND reads,
  receipt states incl. honest-unknown, history decode/paging, catalog fail-closed rows).
  Flows 213–217 remain optional+stubbed (UI legs) — the UI wave owns the app-surface legs.
