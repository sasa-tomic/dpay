# vCHF and ICP support analysis

> **Status:** investigation complete; implementation complete and verified per the spec (2026-08-28).
> **Verified:** 2026-08-28 against IC mainnet and the current dpay tree.
> **Execution spec:**
> [`specs/2026-08-28-vchf-icp-support-spec.md`](specs/2026-08-28-vchf-icp-support-spec.md).

## Executive conclusion

dpay can add both VNX Swiss Franc (`VCHF`) and native Internet Computer Protocol (`ICP`) as
ordinary external IC assets. The existing app-signed IC rail already constructs and submits direct
`icrc1_transfer` envelopes from the user's self-authenticating principal to an arbitrary catalog
ledger. Neither asset needs a dpay-owned ledger, a facade settlement path, a new key, or a new
cryptographic transport.

This is not just a catalog-only change:

1. The app currently equates "payable" with "has a recognized chain-key minter family". VCHF and
   ICP are valid ICRC ledgers with no dpay ramp/minter, so both would be rejected before signing.
2. The relay infers IC mainnet/testnet from the display `network` string. `Internet Computer` is not
   in its mainnet allowlist, so both rows would be put in the testnet section and hidden by default.
3. VCHF supports the transaction endpoint used by dpay history. The canonical ICP ledger does not.
   Complete ICP support therefore needs a dedicated adapter to the official ICP index canister.
4. The existing deploy cap placeholder is `100_000` raw units, only `0.001` of either 8-decimal
   token. Deliberate per-asset caps are required.

Direct payment and trading must remain separate:

- **Pay/Receive:** direct exact-asset `icrc1_transfer`; no conversion.
- **Buy/sell VCHF:** a future, explicit user-authorized DEX action. ICRC-1/2 supplies transfer and
  approval primitives, but does not define swaps. The investigated route is ICPSwap-specific
  `quote` plus `icrc2_approve` plus `depositFromAndSwap`.

The execution spec implements complete direct payment support for VCHF and ICP, including ICP
history. It deliberately does not add a swap UI or issuer mint/redeem integration.

## Authoritative identities

| Asset | Ledger canister | Index/archive | Symbol | Decimals | Transfer fee |
|---|---|---|---|---:|---:|
| VNX Swiss Franc | `ly36x-wiaaa-aaaai-aqj7q-cai` | archive `eo2xm-tiaaa-aaaai-atlzq-cai` | `VCHF` | 8 | `10_000` raw (`0.0001 VCHF`) |
| Internet Computer | `ryjl3-tyaaa-aaaaa-aaaba-cai` | official index `qhbym-qaaaa-aaaaa-aaafq-cai` | `ICP` | 8 | `10_000` raw (`0.0001 ICP`) |

These are external canisters. They must not be added to `canister_ids.json`, `dfx.json`, or the list
of dpay-owned canisters in `docs/CANISTERS.md`.

### Live ledger evidence

VCHF's official identity is published in the
[VNX standards and contracts registry](https://vnx.gitbook.io/vnx-global/transparency/standards-and-contracts.md).
The following calls were also run directly against IC mainnet:

```sh
dfx canister call ly36x-wiaaa-aaaai-aqj7q-cai icrc1_metadata '()' --network ic
dfx canister call ly36x-wiaaa-aaaai-aqj7q-cai icrc1_supported_standards '()' --network ic
dfx canister call ly36x-wiaaa-aaaai-aqj7q-cai icrc1_total_supply '()' --network ic
```

They returned name `VNX Franc`, symbol `VCHF`, 8 decimals, fee `10_000`, maximum memo length 32,
and support for ICRC-1, ICRC-2, ICRC-3, ICRC-10, ICRC-21, ICRC-103, and ICRC-106. VCHF also exposes
the legacy `get_transactions` interface already consumed by dpay.

The canonical ICP ledger was checked with:

```sh
dfx canister call ryjl3-tyaaa-aaaaa-aaaba-cai icrc1_metadata '()' --network ic
dfx canister call ryjl3-tyaaa-aaaaa-aaaba-cai icrc1_supported_standards '()' --network ic
dfx canister call ryjl3-tyaaa-aaaaa-aaaba-cai icrc1_fee '()' --network ic
```

It returned name `Internet Computer`, symbol `ICP`, 8 decimals, fee `10_000`, and support for
ICRC-1, ICRC-2, and ICRC-21.

## Standards boundary

The phrase "buy/sell through ICRC" needs a precise boundary:

- ICRC-1 defines token metadata, accounts, balances, and transfers.
- ICRC-2 defines allowances, approvals, and delegated transfers.
- ICRC-3 defines a standardized transaction log, when a ledger implements it.
- None of these standards defines a quote, order, AMM, fiat purchase, issuer mint, issuer redeem,
  or exchange.

VCHF and ICP payments are therefore standard ICRC transfers. A VCHF/ICP trade can use ICRC-2 to
authorize a DEX pool, but the quote and swap calls remain proprietary to that DEX.

## Fit with dpay's architecture

The production IC value path is already suitable:

1. The catalog names the exact ledger principal for the requested currency.
2. The merchant request binds the exact currency ID and raw amount.
3. `app/services/rail.ts::prepareTransfer` builds `icrc1_transfer` arguments for that ledger.
4. `crates/dpay-icp` signs the full IC `/api/v2` envelope with the user's device key.
5. The app submits those immutable bytes directly to an IC boundary node.
6. The receiver confirms the exact recipient, amount, currency, and random memo in ledger history.

The facade and relay do not move VCHF or ICP. The facade remains the governed catalog of record;
the relay composes that catalog and serves read-only balances/history. This preserves the project's
non-custodial, no-automatic-swap, and no-exchange-credentials constraints.

## Proposed catalog records

Production currently uses immutable IC currency IDs 0 through 6. A live catalog read on 2026-08-28
showed IDs 7 and 8 unused. The implementation must check again immediately before registration;
an existing or retired ID must never be reused.

### VCHF, candidate currency 7

```text
currency          7
ledger            ly36x-wiaaa-aaaai-aqj7q-cai
mintable          false
minter             null
minter_family      null
symbol             VCHF
decimals           8
wrapper_name       VCHF
backing_symbol     VCHF
network            Internet Computer
display_decimals   8
fee                10000
cap                1000000000000   # 10,000 VCHF
chain_id           null
token_contract     null
gas_ledger         null
onramp             Unavailable
offramp            Unavailable
```

`backing_symbol` is intentionally `VCHF`, not `CHF`. In dpay that field is the unit rendered on
payment amounts. Calling an issuer token simply `CHF` would imply the wallet holds bank francs and
would hide the exact asset being transferred. The reserve/reference currency can be described in
education or issuer information later; the payment unit must remain VCHF.

### ICP, candidate currency 8

```text
currency          8
ledger            ryjl3-tyaaa-aaaaa-aaaba-cai
mintable          false
minter             null
minter_family      null
symbol             ICP
decimals           8
wrapper_name       ICP
backing_symbol     ICP
network            Internet Computer
display_decimals   8
fee                10000
cap                100000000000    # 1,000 ICP
chain_id           null
token_contract     null
gas_ledger         null
onramp             Unavailable
offramp            Unavailable
```

The proposed caps are explicit initial payment-policy values, not ledger limits. Metadata can be
governed later without changing the immutable currency-to-ledger identity.

## Current code gaps

### 1. Payability incorrectly depends on ramps

`app/config/catalog.ts::isPayableAsset` currently returns true only for DEMO or a currency whose
`minter_family` is recognized by `familyDisplay`. That conflates two independent capabilities:

- **Payment capability:** can the app build and sign a direct transfer to a valid ICRC ledger?
- **Ramp capability:** can the app fund or redeem that asset through a known minter/partner flow?

`parseIcpRow`, `buildSelectableAssets`, `prepareTransfer`, formatting, NFC disclosure, and the
generic signer can already carry complete no-minter rows. `isPayableAsset` should accept a complete
direct-ICRC descriptor without inventing a fake minter family. `familyDisplay` should remain a ramp
helper and continue returning `null` for VCHF and ICP.

The direct-payment gate should require a catalog row with a non-empty ledger, valid decimals,
non-empty wrapper/payment unit/network labels, parseable non-negative fee, and a positive cap. It
must not depend on `mintable`, `minter`, `minter_family`, `onramp`, or `offramp`. Unknown IDs and
malformed rows must still fail closed.

### 2. Relay mainnet classification uses a display string

`crates/dpay-relay/src/app.rs::is_testnet_row` currently treats only `None`, `Bitcoin`, and
`Ethereum` as mainnet. A row with `network = "Internet Computer"` is incorrectly emitted in the ICP
testnet section.

The smallest safe change is to add `Internet Computer` to the explicit mainnet set and pin this with
tests for both new rows plus the existing Bitcoin-testnet/Sepolia rows. Longer term, the canister
catalog should carry an explicit environment instead of asking the relay to infer environment from
a presentation field. That schema migration is not necessary to add these two mainnet assets.

### 3. Native ICP needs a different history backend

`crates/dpay-relay/src/agent_ledger.rs::transactions_on_ledger` assumes each ledger exposes
`get_transactions`. That is true for VCHF and the current ck ledgers. It is false for native ICP:

```text
get_transactions  -> IC0536 method not found
icrc3_get_blocks  -> IC0536 method not found
query_blocks      -> succeeds (legacy ledger-wide block API)
```

Walking `query_blocks` is the wrong production design for account history: the ICP chain contained
about 38 million blocks at investigation time, older ranges are archived, and the interface is not
account-indexed.

The official ICP index canister is `qhbym-qaaaa-aaaaa-aaafq-cai`. Its dashboard is
[ICP Index](https://dashboard.internetcomputer.org/canister/qhbym-qaaaa-aaaaa-aaafq-cai), and its
live `ledger_id()` returned the canonical ICP ledger:

```sh
dfx canister call qhbym-qaaaa-aaaaa-aaafq-cai ledger_id '()' --query --network ic
# (principal "ryjl3-tyaaa-aaaaa-aaaba-cai")
```

Its authoritative Candid exposes:

```candid
type Account = record { owner : principal; subaccount : opt vec nat8 };
type GetAccountTransactionsArgs = record {
  account : Account;
  start : opt nat;
  max_results : nat;
};

get_account_transactions :
  (GetAccountTransactionsArgs) -> (GetAccountIdentifierTransactionsResult) query;
```

The response contains newest-first `TransactionWithId` rows with `Mint`, `Burn`, `Transfer`, and
`Approve` operations, `amount.e8s`, `fee.e8s`, `memo : nat64`, optional `icrc1_memo`, and nanosecond
timestamps. This is the preferred adapter because it accepts the same ICRC-style `Account` dpay
already derives for the user.

Mapping requirements:

- Query `Account { owner: user_principal, subaccount: null }`.
- Exclude approvals.
- Map transfer, mint, and burn into the existing relay `TxnRecord`; do not change the REST/app
  history contract.
- Prefer `icrc1_memo` so dpay's 16-byte reconciliation nonce survives exactly.
- Convert nanoseconds to Unix seconds, preserving the existing contract.
- Preserve newest-first ordering and bounded pagination.
- For ordinary history, stop after the requested limit.
- For exact-memo receiver reconciliation, continue through bounded index pages until the memo is
  found or the same 4-second/10-round-trip budget is exhausted.
- Legacy index operations use textual account identifiers for `from` and `to`. Compute the queried
  user's legacy account identifier, replace that side with the user's principal text, and leave the
  counterparty as its account-identifier text. This preserves the app's current direction check
  without pretending an account identifier is a principal.

The relay can use a narrowly pinned `(ICP ledger -> official ICP index)` mapping. Adding an index
field to every catalog row would widen stable storage and Candid for a one-ledger exception and is
not justified yet. Pin the pair in code and cover the live `ledger_id` relationship in the outer
read-only smoke test.

### 4. Cold-start catalogs and drift alarms

The live facade catalog is authoritative, but dpay deliberately ships offline/test fallbacks. Both
assets must be added consistently to:

- `app/config/catalog.ts::BUNDLED_NETWORKS`
- `crates/dpay-relay/src/ledger/fake.rs::fake_catalog`
- `dfx/catalog_truth.json`
- app catalog/assets tests
- relay catalog/drift tests
- e2e fake-IC ledger state

`dfx/catalog_truth.json` should gain the VCHF ledger, ICP ledger, ICP index, and 8-decimal facts so a
principal or precision typo makes both Rust and Jest fail.

### 5. Display prefix

`currencySymbol` currently returns `?` for a catalog symbol longer than two characters. Both `VCHF`
and `ICP` would therefore show an ambiguous receive-amount prefix even though the amount suffix and
asset picker are correct. The implementation should allow short textual units from complete trusted
catalog rows and verify that the Receive amount layout fits `VCHF` and `ICP` on mobile. Unknown or
malformed rows must retain the `?` fallback.

## VCHF purchase and sale options

### Issuer mint/redeem

VNX's published institutional flow is not a retail ICRC operation. It requires a direct VNX customer
relationship, KYB, a Stablecoin Services Agreement, registered signing credentials, whitelisted
wallet/Travel Rule data, and generally a CHF 100,000 minimum. Relevant material:

- [Minting and redemption](https://vnx.gitbook.io/vnx-global/institutional/products/minting-and-redemption.md)
- [Mint integration](https://vnx.gitbook.io/vnx-global/developer/guides/integrate-stablecoin-mint.md)
- [Redeem integration](https://vnx.gitbook.io/vnx-global/developer/guides/integrate-stablecoin-redeem.md)
- [Onramp/offramp integration](https://vnx.gitbook.io/vnx-global/developer/guides/integrate-onramp-offramp.md)

dpay must not own those credentials, receive fiat, or act as the issuer's omnibus customer. A future
commercial arrangement could provide a user-direct handoff, but it is not a current funding rail.

### ICPSwap V3

The viable on-chain trade path is ICPSwap V3:

- official factory: `4mmnk-kiaaa-aaaag-qbllq-cai`
- VCHF/ICP pool: `65mrh-fqaaa-aaaar-qapoa-cai`
- VCHF/ckUSDC pool: `hx7nb-diaaa-aaaar-qbxsa-cai`
- pool fee tier: `3000` (0.3%)
- [source](https://github.com/ICPSwap-Labs/icpswap-v3-service)
- [integration docs](https://github.com/ICPSwap-Labs/docs)

The VCHF/ICP pool was live, unwhitelisted, and much deeper at investigation time than the direct
VCHF/ckUSDC pool. Snapshot reserves were about `178,742.87 VCHF / 137,107.15 ICP`; quotes included
`1 VCHF -> 0.51472131 ICP` and `1 ICP -> 1.93115382 VCHF`. These are historical observations, not
prices to embed. The VCHF/ckUSDC pool held only about `1,254.73 VCHF / 638.54 ckUSDC` and showed
severe price impact on large trades.

An eventual user-authorized trade is:

1. Verify the pool's token principals, order, fee tier, availability, and cached ledger fees.
2. Call the pool-specific `quote` query.
3. Show exact input, gross output, net wallet receipt, 0.3% fee, both ledger fees, price impact,
   slippage, minimum output, and pool canister.
4. Sign `icrc2_approve` on the input ledger for the exact pool and bounded amount, with
   `expected_allowance` and a short expiry.
5. Wait for certified approval completion.
6. Sign the ICPSwap-specific `depositFromAndSwap` update.
7. Reconcile the asynchronous output/refund transfer and revoke residual allowance.

The pool pulls `amountIn` through ICRC-2 and later queues output withdrawal. Its initial `#ok`
contains gross swap output; the wallet receives gross output minus the output ledger fee. A failed
asynchronous withdrawal/refund can leave funds in the pool's unused-balance accounting. Therefore a
swap feature requires persistent pending/recovery states and identical-envelope retry discipline.
It must not be folded into the direct-payment work as a button that assumes `#ok` means settled.

## Risk and product assessment

- **Custody:** direct payment remains non-custodial. A future DEX action also remains user-signed,
  but introduces temporary pool custody and recovery risk that must be disclosed.
- **Automatic conversion:** forbidden. A VCHF request must settle VCHF; an ICP request must settle
  ICP. Low balance may offer a separate trade entry point later, never an automatic swap.
- **Issuer risk:** VCHF is issuer-created, not chain-key-backed. dpay should link issuer/reserve/legal
  information without implying DFINITY or dpay guarantees redemption.
- **Ramp honesty:** `Unavailable` means no Add money/Cash out action. Asset visibility and direct
  payment must not be suppressed because a ramp is absent.
- **History completeness:** ICP is not complete until outgoing/incoming rows and exact-memo receiver
  reconciliation work through the official index.
- **Immutable IDs:** registration must fail if candidate ID 7 or 8 is occupied or retired; it must
  never silently bind a candidate ID to a different ledger.
- **Production-only behavior:** real catalog partitioning and real index latency are not represented
  fully by browser e2e. Production catalog reconciliation plus an emulator run against the real relay
  are completion gates.

## Recommendation

Implement the direct assets first, as one complete slice:

1. Separate direct ICRC payability from ramp/minter capability.
2. Add the native ICP index history adapter.
3. Register and bundle VCHF currency 7 and ICP currency 8 with no ramps.
4. Exercise balance, request, transfer, exact receiver reconciliation, Ledger history, NFC
   disclosure, offline fallback, and real-relay catalog rendering for both assets.

After that ships, write a separate ICPSwap execution/recovery spec. Adding ICP now makes the verified
deep VCHF/ICP pool a practical future buy/sell route without contaminating exact-asset payments.
