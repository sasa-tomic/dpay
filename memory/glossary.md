# Glossary — dpay decoder ring

## Product terms

| Term | Meaning |
|------|---------|
| dpay | Working name for the offline-capable digital-dollar wallet. |
| offline payer | The customer's phone signs a payment while fully offline (airplane mode). |
| online merchant | The merchant's phone is online; it submits the payment and gets final confirmation. |
| authorization | The signed payment payload: `{from, to, amount, nonce, expiry}`. |
| spending cap | User-set on-device limit — "like cash in a pocket." Enforced by the canister. |
| the offline wedge | The strategic differentiator: crypto payments normally need both parties online; dpay needs only the merchant online. |

## Tech / infra

| Term | Meaning |
|------|---------|
| ICP | Internet Computer — decentralized ledger with fast finality; dpay's settlement layer. |
| canister | ICP smart contract. Here it's the demo ledger: verifies signature, nonce, expiry, cap, balance; moves funds atomically; returns a receipt. |
| relay | Tiny Node + Express + `@dfinity/agent` service. Relays the merchant's submission to the canister so the merchant app only does QR + HTTPS. Only online dependency in the demo. |
| dfx | ICP SDK / CLI used to build and deploy the canister. |
| ckUSDC | Chain-key USDC on ICP — the real USD stablecoin dpay would settle in beyond the internal demo ledger. |
| nonce | Unique per-payment value; the idempotency key. Prevents replay and double-charge. |
| Ed25519 | Signature scheme used to sign/verify authorizations (`@noble/ed25519` / `tweetnacl` on device; `ed25519-dalek` in a Rust canister). |
| idempotency | Submitting the same authorization twice returns the same receipt, never double-charges. |
| safe-mode | Demo fallback that runs the full visual flow locally if venue wifi dies. |

## UI conventions

| Term | Meaning |
|------|---------|
| `$` | How money is displayed. The underlying stablecoin/ledger is an implementation detail and never shown. |
| Pay mode | App mode where the payer scans a request and approves a payment. |
| Receive mode | App mode where the merchant enters an amount and shows a request QR. |

## Comparisons often referenced

Venmo / Alipay / WeChat Pay / Twint (clean QR wallet UX), UPI (QR ubiquity), M-Pesa (proved mobile-money demand in emerging markets).
