# WalletConnect compatibility feasibility, dpay as a connectable wallet (research, 2026-10-11)

Question (founder, 2026-10-11): "Explore feasibility of making dpay compatible with walletconnect.
There's a third party Integration that supports walletconnect apps and it would be convenient if
dpay could be easily added that way." The third party named same-day: **Mt Pelerin**
(`developers.mtpelerin.com`, the Swiss crypto-fiat on/off-ramp, already the compliant-counterparty
reference in `docs/REGULATORY.md` §1.6).

**Verdict: FEASIBLE, on the EVM (Ethereum Virtual Machine) rail, with zero new key surface.**
Every signing primitive the wallet side needs already exists on-device (`app/evm/`); the work is
protocol plumbing, a WalletConnect (WC) responder, plus one review screen. The one hard boundary:
WalletConnect cannot carry dpay's IC/ICRC (Internet Computer and its Internet Computer Request for Comments token standard) assets;
Mt Pelerin speaks EVM (+BTC/Tezos) only, no ICP (Internet Computer Protocol), no Solana. What becomes
"easily addable" is exactly the device-key EVM rail dpay shipped in the 2026-09-26 EVM rail spec.

All external facts below were **measured against the providers' own docs on 2026-10-11**
(developers.mtpelerin.com, docs.walletconnect.com), not from memory or marketing copy.

---

## 1. WalletConnect has two sides; dpay is already on one of them

- **dApp (decentralized application) side (proposer)**, dpay IS this today: `app/walletconnect.ts` pairs *external* wallets
  (Trust, MetaMask, …) via `@walletconnect/ethereum-provider` ^2.23.10 so the user can fund the
  ckERC20 onramp from another wallet. A WalletConnect project ID already exists
  (`app/config/constants.ts` `WALLETCONNECT_PROJECT_ID`). React Native compatibility of the WC
  SDK (software development kit) in THIS app is proven by that shipped, tested feature: Metro
  shims, `@walletconnect/react-native-compat`, a jest stub, e2e (end-to-end test) aliasing.
- **Wallet side (responder)**, dpay is NOT this: no inbound `wc:` intent filter
  (`AndroidManifest.xml` claims only `https://dpay.kalaj.org/…` and `dpay://`), no
  session-proposal handling, no request dispatch. This is what "WalletConnect compatible" means
  for the Mt Pelerin ask: their widget connects *wallets*; dpay must be connectable.

The symmetry is exact: today dpay *consumes* an EIP-1193 (Ethereum Improvement Proposal) provider (`window.ethereum` on web, the WC
provider on Android, `resolveOnrampProvider()` in `app/wallet.ts`). The wallet side means dpay
*provides* that surface to other apps.

## 2. What Mt Pelerin requires (their docs, measured 2026-10-11)

Integration surface: web widget (iframe/popup/direct link), a React Native SDK
(`react-native-mtp-onofframp`), and a REST API (quotes, currencies, conversion webhooks, revenue
sharing). Their widget connects end-user wallets over standard WC v2 EVM. The facts that decide
feasibility:

- **Chains:** all-EVM for dpay's purposes: Arbitrum, Avalanche, Base, BNB Chain, Celo, Ethereum,
  Gnosis, Optimism, Polygon, Rootstock, Sonic, Tempo, zkSync Era, plus Bitcoin, Lightning, and
  Tezos. **No Solana. No ICP.** (List: developers.mtpelerin.com → "Supported chains &
  cryptocurrencies"; the JSON at `api.mtpelerin.com/currencies/tokens` still carries a stale
  `fantom_mainnet` remnant absent from their docs page, so treat the docs page as authoritative.)
- **Asset overlap with dpay's wired EVM chains today:**
  - USDC, Ethereum ✓ and Arbitrum ✓ (chains wired in dpay's device-key rail, `app/evm/chains.ts`;
    the USDC asset itself is NOT a rail row today: the EVM catalog carries only ZCHF,
    `crates/dpay-relay/src/catalog.rs`, so delivered USDC would not render until the row is
    added).
  - ZCHF (Frankencoin), Ethereum ✓ (dpay's rail carries ZCHF there, and also on Arbitrum One,
    which Mt Pelerin does not list). Also on Base/Gnosis/Optimism, reachable later by *adding
    chains* to dpay's rail (see §5), not by new cryptography.
  - EURC, Ethereum ✓ (rail-wired chain; EURC contract not yet in dpay's catalog).
- **Address-ownership validation:** the integrator signs the fixed message `MtPelerin-{code}` with
  `personal_sign` on EVM and submits the raw signature base64-encoded. This is the ONLY signature
  their flow requires of the wallet for address automation.
- **Buy (fiat → crypto):** delivery goes straight to the connected address. No funds-moving
  signature is requested from the wallet.
- **Sell/swap (crypto → fiat):** for a connected-wallet sell/swap the widget can build the
  transaction (an ERC-20 transfer, the Ethereum token standard, to their deposit address, or a
  router swap) and request
  `eth_sendTransaction` (observed in the live widget, not documented); their widget's sell
  flow also offers a manual send to their deposit address, a widget UI option not covered in
  their developer docs (see §9.5).

So the complete wallet-side method surface Mt Pelerin exercises:
`personal_sign` + `eth_sendTransaction` (plus the session basics, `eth_accounts`/accounts,
`eth_chainId`, and typically `wallet_switchEthereumChain`). No `eth_signTypedData` in their
documented flow.

## 3. What dpay can already sign (repo facts)

One seed (`Identity.secretHex`) already derives all three rails; the EVM rail is
SLIP-10 secp256k1 at m/44'/60'/0'/0/0 (`app/evm/identity.ts`), one address on every EVM chain,
recoverable in MetaMask/Rabby. Existing on-device primitives:

| Need (wallet side) | dpay today | Gap |
|---|---|---|
| keccak256 / secp256k1 / Recursive Length Prefix | `app/evm/keccak.ts`, `evm/identity.ts`, `evm/rlp.ts` | none |
| EIP-1559 + legacy tx signing | `signEip1559Tx` / `signLegacyTx` (`app/evm/tx.ts`) | none |
| EIP-712 structured signing | `signPermit` + digest builders (`app/evm/permit.ts`) | generic typed-data hasher only if `eth_signTypedData` is wanted (Mt Pelerin doesn't need it) |
| **`personal_sign`** | keccak + secp256k1 primitives (`app/evm/keccak.ts`, `evm/identity.ts`) | EIP-191 (the personal_sign message-prefix standard) wrapper: `keccak("\\x19Ethereum Signed Message:\\n" + len + msg)` then the same secp256k1 sign; pure, ~15 lines |
| Broadcast + receipt | relay per-chain RPC (remote procedure call) proxy `/api/v1/evm/rpc/{chainId}`, `evm/service.ts` send + poll, wrong-chain guard | a wallet-side param-fill path (nonce/gas defaults when the dApp omits them), the same lookups dpay's own send path already performs |
| Chains wired | Ethereum (1), Arbitrum One (42161), + Arbitrum Sepolia (421614)/Anvil (31337) test | Base/Optimism/Gnosis only if ZCHF-ramp coverage on those chains is wanted (§5) |

Non-custodial invariant: unchanged. The device key never leaves; WalletConnect transports only
end-to-end-encrypted envelopes, and the wallet returns signatures/hashes only, the same
"ZERO key surface" property the dApp-side module's header already documents.

## 4. The build (Route A, the ask: dpay as a WalletConnect wallet)

SDK: `@reown/walletkit` (WalletKit, the current wallet-side SDK, successor of Web3Wallet) over
`@walletconnect/core`, which the wallet side MUST construct explicitly and isolate
(`new Core({ projectId, customStoragePrefix: "walletkit" })` passed to `WalletKit.init`). Core
instances are shared globally by default and storage keys carry no client identity, so a
default-prefix second client would corrupt the dApp-side provider's session/pairing stores (see
§9). `@walletconnect/react-native-compat` is ALREADY a dependency at the exact version the
dApp side pins (^2.23.10). House isolation pattern copies `app/walletconnect.ts` verbatim: one
module statically imports the SDK, and the rest of the app reaches it only through a lazy
dynamic import of that module. Jest maps `^@walletconnect/.*` to a stub (`app/jest.config.js:19`)
and needs the same mapping added for the new `@reown/*` specifier (nothing maps `@reown` in jest
today, only Metro shims the one `@reown/appkit/core` subpath). E2E aliases the two
`@walletconnect/*` packages out (`e2e/vite.config.js`); disabled guard on web / empty project ID.
The existing project ID works for the wallet side unchanged.

Pieces, in dependency order:

1. **`personal_sign` primitive** (pure, `app/evm/`): EIP-191 digest + sign + base64. Golden-vector
   jest test against a known MetaMask-signed fixture. (Hours.)
2. **WalletKit responder skeleton** (`app/walletkit.ts`, mirroring the walletconnect.ts seam):
   - init with dpay metadata + `redirect: {native: 'dpay://'}` (the deep link exists);
   - `pair({uri})` for scanned URIs;
   - `session_proposal` → approve with the device EVM address on `eip155:1` + `eip155:42161`;
   - methods `personal_sign` + `eth_sendTransaction`; events `chainChanged`/`accountsChanged`.
   (~1-2 days.)
3. **Inbound pairing paths:**
   - Android `wc:` scheme intent-filter (new manifest entry), dpay appears in the OS chooser when
     any app emits a WC URI (Mt Pelerin's mobile flow). `Wallet.handleUrl` gains a `wc:` branch.
   - The EXISTING QR scanner parses a scanned `wc:` URI (Mt Pelerin's desktop widget shows the
     QR), new parse branch, no new hardware surface.
   - Explorer listing (supersedes the 2026-10-11 "optional, NOT required" note) is decisive for
     the Mt Pelerin ask, because their picker is Explorer-driven (submission process with
     icons/metadata/links; works without it via the two paths above). Founder set it HIGH prio
     (§9).
4. **Request dispatch + the review sheet** (the load-bearing new UI):
   - Displays chain, to, value, gas, and data.
   - Decodes ERC-20 `transfer`/permit calldata where recognizable (dpay knows these shapes
     from its own rail); UNKNOWN calldata renders raw hex behind an explicit "unknown contract
     call" warning, no auto-approve, ever.
   - `eth_sendTransaction` fills nonce/gas/chainId when omitted (same lookups as dpay's own
     send).
   - Signs with the device key, broadcasts through the existing relay proxy, and returns the
     hash, carrying the SAME submitted ≠ settled caveat as the send path.
   - Rejection answers with `getSdkError` USER_REJECTED (5000).
   (~2-4 days.)
5. **`wallet_switchEthereumChain`** maps to dpay's wired chains; a request for an unwired chain
   is refused with the SDK's chain error: `getSdkError('UNSUPPORTED_CHAINS')`,
   code 5100, or `USER_REJECTED_CHAINS` (5001) at proposal scope; message truthful (the
   wrong-chain-guard posture the EVM rail already has).
6. **Tests:**
   - Conformance: extend the `walletconnect-fake.ts` / `walletconnect-conformance.test.ts`
     pattern to the responder (proposal→approve→request→respond matrix).
   - Smoke: personal_sign vectors and the tx param-fill.
   - Real-chain proof: `just node-anvil` territory (sign→broadcast→mine against the same EVM
     send path the rail already proves).
   - Live gates: WalletConnect's own test dapp (react-app.walletconnect.com), then Mt Pelerin's
     widget.
   (~2-3 days with the device gate.)

Total: roughly **1-2 weeks** (integration, inbound paths, and the device gate included) to a
proof-of-concept-grade wallet side on Android, every request reviewed on-device, none of
it touching the offline pay rails, the IC facade, or the wire format.

## 5. What WalletConnect does NOT buy

- **IC/ICRC assets are unreachable.** There is no WC namespace for ICRC, and Mt Pelerin does not
  support ICP (§2). VCHF-on-IC, ckBTC, ckETH cannot be bought or sold through this path. The reachable
  universe today is ZCHF on Ethereum, the only wired chain Mt Pelerin lists it on (USDC needs
  the §2 catalog rows first; native ETH is gas-balance-only). Off-ramping IC-side
  funds via Mt Pelerin would require moving them to an EVM rail first, a conversion the no-swap
  charter keeps out of dpay's hands (the user does it at a venue, as with delegated conversion
  today).
- **Solana: MEDIUM priority, scheduled by the founder** (supersedes the 2026-10-11 "moot for Mt
  Pelerin" note; Track S in the integration plan, see §9). Mt Pelerin doesn't support it, but
  dpay's device ed25519 key can advertise a `solana` namespace for generic WC compatibility
  (WalletKit lists first-class Solana methods: `solana_signMessage`, `solana_signTransaction`,
  `solana_signAndSendTransaction`).
- **Session requests are a phishing surface by design.** Any WC dApp can request a signature; the
  review sheet is the security boundary. This is the standard wallet trade (Trust/MetaMask carry
  it too) and it is mitigated, not eliminated, by plain display of the request.
- **Requests land only when dpay can hold the WalletConnect relay socket**
   (`wss://relay.walletconnect.org`, the installed SDK's default relay; app foregrounded/online;
   not dpay's relay). Fine for
  the same-device Mt Pelerin flow (deep link back via `dpay://`); cross-device flows need the app
  open, and WC push notifications are the later enhancement.
- **Extra chains for ZCHF coverage** (Base/Gnosis/Optimism) are relay catalog + RPC + gas-asset
  work (the address is already correct there, same key), only worth it if the founder wants
  those specific ramps; Ethereum covers ZCHF today (USDC rides the same chains once its rows are
  added, §2).

## 6. Alternatives measured (why Route A is still the ask)

- **Route B, embed Mt Pelerin's RN (React Native) SDK:** host `react-native-mtp-onofframp` in-app, pass the
  user's dpay EVM address, automate validation with the §2 signed message (dpay signs locally).
  No WalletConnect at all; fastest path to a dpay-branded-context fiat ramp with revenue sharing
  available. But it is a dpay-only integration: nothing about dpay becomes "addable" elsewhere,
  and the exchange UI is Mt Pelerin's surface inside dpay.
- **Route C, injected provider in a dpay webview:** host `widget.mtpelerin.com` in a webview and
  inject an EIP-1193 `window.ethereum` backed by the device key (their iframe allow-list already
  declares `ethereum`). Works for ANY web dApp inside dpay's webview; still dpay-only surface, no
  ecosystem compatibility.
- Route A is the only one that answers the actual question, one build that lets Mt Pelerin (and
  every other WC app) connect to dpay. B and C compose with it later as UI shortcuts, but neither
  is compatibility.

## 7. Non-negotiables check

- **Non-custodial:** intact; device signs locally; WC relays ciphertext; only hashes/signatures
  return. No new key material, no seed change, no backup change (the EVM key already rides the
  same `Identity.secretHex` backup).
- **No-swap / no-exchange-creds:** intact. Mt Pelerin is an SRO (self-regulatory
   organisation)-affiliated ramp (Regulatory fit below) the user authorizes
  directly with their own dpay address as destination (the exact shape `positioning.md` and the
  2026-09-09 funding-routes plan license); dpay stays a screen, takes no cut by default. Mt
  Pelerin offers a revenue-sharing program; `docs/REGULATORY.md` §1.6 flags affiliate fees via
  the §1.4 FINMA (Swiss Financial Market Supervisory Authority) "Ertragsflüsse" indicator
  (answered 2026-10-12; left open, deferred, see the integration plan §6), founder decision, default NO.
- **Offline-first:** untouched. The WC surface is online-only and never enters the offline pay
  rails, NFC, or the IC envelope path.
- **Regulatory fit:** Mt Pelerin is SRO-affiliated (SO-FIT, the Geneva-based SRO, formerly
  OAR-G, its predecessor body, FINMA-recognised), already recorded as the compliant counterparty class in
  `docs/REGULATORY.md`.

## 8. Open questions for the founder (answered 2026-10-12, see §9)

1. Direction priority: on-ramp INTO dpay (buy USDC/ZCHF to the dpay address, Route B/C achieve
   it without WC) vs off-ramp OUT (sell, needs the wallet connection, or dpay's own send to
   Mt Pelerin's deposit address + their webhook for status)?
2. WalletConnect Explorer listing (named-wallet pickers), pursue now or rely on QR/`wc:` chooser?
3. Revenue sharing: assume NO (regulatory indicator) unless you say otherwise?
4. Generic-namespace scope: EVM-only v1 (recommended), or also advertise `solana` for
   non-Mt-Pelerin WC apps from the start?

## 9. Swarm verification addendum (2026-10-12)

Five independent agents re-verified this doc against the live sources (docs.walletconnect.com,
developers.mtpelerin.com, npm, the live Mt Pelerin widget bundle) and the repo. The verdict
stands: FEASIBLE, EVM rail, zero new key surface. The founder answered §8 (both ramp directions
HIGH prio; Explorer listing HIGH prio; revenue sharing left open; FINMA restrictions are not permanent; Solana
yes, MEDIUM prio). The execution plan is `2026-10-12-walletconnect-integration-plan.md`.
Corrections and sharpenings:

1. **§4 "shared core" was UNSAFE as written (fixed in place above).** Two exact-pinned trees ship
   (walletkit 1.6.0 pins core/sign-client at 2.25.0; the dApp-side ethereum-provider at 2.23.10
   pins 2.23.10). With the default prefix core never creates a second instance: `new Core()`
   returns the globally shared object, leaving ONE Core behind both SignClients over the same
   `//session` and `//pairing` stores, i.e. last-writer-wins corruption and double event delivery. The explicit
   `customStoragePrefix` isolation is load-bearing, not cosmetic. WalletKit additionally requires
   the explicit `core` option, and `react-native-compat` must be imported before any `@reown/*`
   import (relevant to the lazy-import seam; plan §2.1).
2. **Install list grows by two explicit deps:** `fast-text-encoding` (transitive today, explicit
   in WalletKit's RN docs) and `@walletconnect/utils` (`buildApprovedNamespaces`/`getSdkError`).
3. **Method surface gains `eth_signTypedData_v4`.** Mt Pelerin's documented flow does not use
   it, but the Explorer listing quality-assurance matrix requires it for EVM wallets.
   dpay's keccak/secp256k1 primitives carry the hashing; the grammar encoder is new
   (`app/evm/typedData.ts`, plan §2.3, 1-2 days).
4. **Explorer listing (§4 step 3) is decisive for the Mt Pelerin ask:** their live widget ships
   Web3Modal v2 with an EXPLORER-DRIVEN wallet list, so a listed dpay appears in their picker
   automatically (a generic QR/deep-link path also exists). Listing is free, review is 7-10
   business days, the same project ID serves both sides (classification claim from swarm
   dashboard inspection; re-confirm at submission), and the Progressive Web App is
   listable as a Web wallet (plan §2.3).
5. **§2 Mt Pelerin corrections (detail and live status in the plan, §2.2):**
   - The integration key `_ctkn` is a manual review process (email hello@mtpelerin.com + app
     review; NO prod keys for non-live projects), not self-serve.
   - Direct widget links need NO key at all (self-serve per their docs); the key gates
     iframe/popup embedding.
   - Revenue sharing itself is self-serve via the `rfr` invite code (plan §6); the conversion
     webhook is set up on request.
   - The validation `code` must differ per address; an address already registered on another
     Mt Pelerin account is rejected.
   - The widget's sell UI offers a manual-send-to-deposit-address alternative (the "I've sent
     the crypto manually" path, confirmed in the live widget 2026-10-12; not covered in their
     developer docs), so the in-app off-ramp needs NO wallet connection at all.
   - Their RN SDK is stale (1.0.3, published 2024-10-31), which argues for the widget-link
     approach over embedding it.
   - Fee facts for the UI copy: bank ramps 0% on the first CHF 500 per user per year, then a
     decreasing fee starting at 1.3%; card 2.5%+ (min CHF 1.20, max CHF 5k/tx); ERC-20 delivery
     on Ethereum costs $1, ETH and other chains free; no-KYC tier CHF 999/30d with a 7-day hold
     on unverified bank on-ramps (their pricing page, 2026-10-12).
   - ZCHF conversions are 0% via their Frankencoin Association partnership: buys and cash-outs
     to/from any supported fiat, no volume limits (their announcement, updated 2026-08-03).
6. **§5 Solana method list is wider than stated:** `solana_getAccounts` and
   `solana_requestAccounts`, and `solana_signAllTransactions` beyond the three listed; message
   params are base58, transaction params base64 (the instruction-array shape is deprecated
   upstream, their docs: "not compatible with versioned transactions"; dpay rejects it locally
   with its own explicit unsupported-format error rather than relying on a documented upstream
   one). Feasibility unchanged; Mt Pelerin has no
   Solana support (re-confirmed; plan §2.4).
   dpay's venue decode/sign path already handles single-signature legacy and v0 (static-keys)
   transactions, so the gap is multi-signer slots, fee-payer parameterization, and a semantic
   review decoder.

7. **Round-1 validation swarm:** a second pass (2026-10-12, five read-only validators)
   re-checked all external facts against live sources; material corrections landed above and in
   the plan (USDC catalog reality, R0 direct-link self-serve, Latvia absent from their
   forbidden-countries API, `solana_requestAccounts` now documented) plus doc-integrity fixes
   (collapsed duplicate §9 addenda to one, fixed section cross-references, the `personal_sign`
   table row, `docs/REGULATORY.md` §1.6).

