# dpay as an Apple Pay / Google Pay payment source — exploration results

*Researched 2026-09-20 via two agent swarms against primary sources (Apple/Google issuer programs, vendor docs and pricing, regulator pages, press). All findings dated to that access.*

## Objective

∂pay is a Swiss, non-custodial stablecoin wallet (CHF/USD/EUR as VCHF / USDC / EURC on ICP + Solana; charter: never custody funds, never convert on the user's behalf, no cut). We wanted to know what it would actually take for dpay to appear as a payment source in Apple Pay / Google Pay: whether dpay would have to become a card issuer, what alternatives exist, how deep a partnership with a provider would be, whether a Swiss partner (e.g. Yuh) is possible, what the end user would see, which country would control the card, and what it all costs.

## TLDR

dpay does **not** need to become a card issuer — and cannot avoid needing **a card**. Both wallets only accept tokenized Visa/Mastercard credentials; there is no "wallet balance" source type (the one non-card experiment, linked PayPal in Google Wallet, was killed in 2025). The proven pattern is a **program-manager partnership with a licensed issuer-of-record** (Lithuania/UK) that already has both wallets plumbed in, with **non-custodial funding at authorization time** (Gnosis Pay/Immersve/Rain have shipped exactly this). The user experience can be exactly what we want: tap "Add to Apple/Google Wallet" inside the dpay app, one-time in-app KYC, a fully dpay-branded card appears — no second app, no account elsewhere, issuer invisible. Timeline **2–4 months**, year-one cost **CHF ~50–150k**, user-facing fees can be **zero**. There is **no Swiss path today** (no Swiss issuer serves crypto or non-custodial programs; Yuh is consumer-only and its cards come from Swissquote) — a 2027 Swiss "payment institution" licence reform is the first window for a genuinely Swiss-controlled program. Until then: EEA-issued card, Swiss AG as the customer-facing company.

## Findings

### 1. Why a card is unavoidable

- Apple Wallet / Google Wallet passes are structurally tokenized card-network credentials (Visa, Mastercard, Amex, … plus some national schemes). No stablecoin or balance instrument exists.
- Even the EU DMA route (own tap-to-pay app, `com.apple.developer.nfc.hce`; Switzerland covered by Apple's NFC & SE Platform since iOS 18.2) removes Apple as gatekeeper but **not the scheme requirement** — EMV terminals route by AID to a card network (Vipps needed BankAxept membership before adding Visa/MC).
- Dead ends, verified: linked PayPal in Google Wallet (killed Jun 2025); Google balance card (removed Jun 2026); Pix-in-Wallet (required a central-bank national scheme); Wero/UPI/TWINT (licensed-bank/PSP members only); Visa VTAP / Mastercard MTN / Circle CPN (issuer-side settlement plumbing, not founder-facing); own scheme (>$10M, 5–10 yrs).

### 2. The working pattern: partner-issued, non-custodially funded

All crypto cards in Apple/Google Pay (Gnosis Pay, MetaMask, Tangem, Coinbase, KAST, MiniPay) follow the same structure:

1. Licensed issuer-of-record holds the BIN, licence, and does KYC/AML.
2. User funds stay in their own wallet until the moment of purchase; the issuer **debits on-chain at authorization** (Gnosis Pay: Safe + real-time balance check; Immersve: approval-based spend from the existing wallet; Rain: on-chain collateral, daily USDC settlement with Visa).
3. Card is tokenized and push-provisioned into both wallets, appearing weeks after issuance.
4. dpay never touches funds → charter-compatible; Swiss precedent: Tangem AG ships Tangem Pay via a US operator + Rain without holding licences itself.

### 3. Partner shortlist and onboarding effort

| Partner | Fit | Caveats |
|---|---|---|
| **Rain** | Visa *and* Mastercard principal, **Solana-native**, non-custodial support, Apple/Google Pay bundled; claims 2–3 month go-live; powers Tangem/KAST | Fully sales-gated: no public pricing/docs |
| **Immersve** | Mastercard principal; cleanest non-custodial model; same-day sandbox; partner-side KYC; CH supported | Google Pay push provisioning not live yet (manual entry until then) |
| **Bridge (Stripe)** | Published 6–8 week onboarding; Solana + non-custodial native; mature APIs | KYC runs through Bridge's branded flow — least white-label |
| **Gnosis Pay B2B** | Architecturally ideal self-custody; published tiers; brandable KYC | 2–3 year minimum contracts; EVM only; EUR corridor drags in Monerium |
| **Monavate/W3C** | Gnosis Pay's actual issuer, proven EEA/UK stack | Enterprise-sales only; post-Exodus-acquisition turmoil risk |

Process shape (all providers): intro call → KYB on dpay → contract → sandbox API integration (weeks of dev) → Apple/Google certification → live. **2–4 months from first contact to a user card in a wallet.**

### 4. Swiss providers: no path today

- **Yuh**: consumer-only, no B2B/API/white-label at all; 100% Swissquote-owned since Jul 2025; its cards are just Swissquote Mastercards.
- **Structural**: Switzerland has no e-money licence — card issuing requires a full banking licence (or the rare fintech licence, CHF 100M cap, ~4 holders, none issuing cards). Evidence: Swiss Bankers (the flagship prepaid issuer) issues from **Liechtenstein**; Payme Swiss ran "Swiss" cards via a UK EMI and went into liquidation Jun 2026.
- Every Swiss fintech rides a bank: Neon → Hypothekarbank Lenzburg, Yuh → Swissquote, Zak → Bank Cler, Revolut CH → Lithuanian bank.
- No Swiss issuer serves crypto-funded or non-custodial programs (Sygnum/Amina are custodial, no issuing-as-a-service).
- **Window**: the FINIG reform ("payment institution" licence, in force 2027 at earliest) explicitly covers stablecoin payment services — the first realistic opening for a Swiss-controlled program. Until then the Swiss flavor is: EEA issuer + dpay's Swiss AG as the customer-facing entity (the Revolut-CH model).

### 5. User experience (verified mechanics)

- The Apple in-app provisioning entitlement is held by **dpay's app** (issuer disclosed to Apple on a form, never to users); Google has an explicit program-manager path plus an app allowlist. **MiniPay** — a self-custodial stablecoin wallet with a Visa in both wallets — is the shipping precedent.
- Card art and display name in Wallet are fully **dpay-branded**; the issuer stays invisible (Gnosis/MetaMask cards show their own brands, not Monavate/Baanx).
- KYC embeds in dpay's onboarding (Gnosis Pay: users sign up "without leaving the app"); ID&V can be a silent cryptographic OTP — no SMS needed unless the issuer insists; front-line support is dpay's.
- Complete best-case user journey: open dpay → one-time in-app identity check → "Add to Apple/Google Wallet" → Face ID → card appears. No second app, no account elsewhere. Unavoidable extras: an in-app issuer-terms sheet, possibly one OTP, Google Wallet's standard confirmation.
- Contract must-dos: issuer production-live on **both** tokenization platforms (VTS/MDES) as an SLA; on separation, wallet tokens die via VTS/MDES while self-custodied balances are unaffected.

### 6. Which country controls the card

The **issuer-of-record's country — realistically Lithuania (EU) or the UK** — not Switzerland. Practically: EU safeguarding rules (not deposit insurance), GDPR, EU interchange caps, Visa/Mastercard Europe; the BIN country (LT) is technically visible to merchants. A Swiss bank BIN would be cleanest but economically worst (COMCO interchange cap ~0.15%) and no bank partner for stablecoins exists. US sponsor bank = phase 2 for a USD card. Switzerland regulates dpay itself only via the non-custody line: no client funds → no FINMA licence.

### 7. Fees

**dpay pays** (all negotiated, nothing public):
- Platform minimum €2–10k/month; $2–10 per card; disputes ~$15; all-in transaction cost ~0.5–1.5% of volume before scale; Apple's issuer fee (~0.15% on credit transactions in the US) is baked into issuer pricing.
- **Realistic year one: CHF ~50–150k.**

**User pays** — can be zero: Gnosis Pay and Tangem charge 0% markup (pure network rate). Comparables: MetaMask 1%, KAST 0.5–1.75%, Neon 0.35%, Yuh 0.95%, Zak 2%.

- Structural residual: Visa/Mastercard charge the issuer **0.6–1.4% network FX** on foreign-currency spend, regardless of markup. Issuing the card in the user's home currency (CHF/USD/EUR ↔ VCHF/USDC/EURC 1:1) means most traveler spending never converts; exotic-currency spend is the only leak.
- Given the no-cut charter, monetization stays off spend (premium tiers — MetaMask Metal $199/yr is the model).

### 8. Charter tensions for Swiss counsel

- KYC on the card leg is unavoidable (issuer-of-record requirement).
- Authorization-time debit fits the same-asset-rails doctrine (card currency = home currency = one stablecoin; merchant-side conversion happens acquirer-side, outside dpay) — needs counsel sign-off.
- Branding: Wallet shows a Visa card, never a "dpay balance" object.

### 9. Recommended next steps

1. Parallel intro calls: **Immersve + Rain** (Gnosis Pay B2B as architecture reference). Three deciding questions each: Swiss-resident onboarding? Solana support? Production tokenization on both Apple and Google?
2. Retain Swiss fintech counsel for the SRO/AMLA question and the card-leg charter tensions.
3. Target: first dpay-branded virtual card in Apple/Google Pay within one quarter of contract signature.
4. Watch the 2027 Swiss payment-institution licence as the future Swiss-control window; Apple NFC & SE Platform (CH, iOS 18.2+) as a later own-app tap-to-pay layer on top of the card.
