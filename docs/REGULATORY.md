# Regulatory posture — what the law says, what was measured, what it costs the design

**This file owns dpay's regulatory analysis.** Nothing here is restated anywhere else in the repo;
every other doc that touches the subject carries a bare pointer to this path.

**This is orientation before hiring a Swiss fintech lawyer, not a substitute for one.** It is
research, not advice, and no regulator has been asked. The one action item this file does not
contain is the only one that closes it: retain Swiss counsel and put the questions in
[§7](#7-open-questions-for-counsel) to them in those words.

*Research performed 2026-09-04/05 against primary sources. Not re-verified while writing this file —
each claim carries its citation so it is re-checkable at the source.*

## 0. How to read this

| Marker | Means |
|---|---|
| A citation (statute, ordinance, docket, register, report + date) | **MEASURED** — read at the primary source on 2026-09-04/05. |
| *Inference:* | **INFERRED** — reasoning from the measured facts. Not a finding. |
| *Open:* | Nobody has answered it. Not a risk estimate — an absence. |

Swiss law governs, because dpay is Swiss. MiCA matters only if EU users are served. US material is
persuasive only — and is the most instructive body of evidence on the record, because it is the only
place where the exact question has been litigated.

---

## 1. Switzerland — the governing regime

### 1.1 The headline, and it corrects an assumption this repo carried

**"Non-custodial, therefore out of scope" stopped being the Swiss test on 1 August 2021.**

- AMLA (GwG, SR 955.0) Art. 2(3): financial intermediaries include persons who "assist in the
  investment or transfer" of assets belonging to others. Art. 14(1) makes SRO affiliation mandatory
  for anyone caught.
- AMLO (GwV, SR 955.01) **Art. 4(1)(b)**, inserted by the DLT ordinance of 18 June 2021
  (AS 2021 400). German binding text — a person
  > "hilft, virtuelle Währungen an eine Drittperson zu übertragen, sofern er mit der Vertragspartei
  > eine **dauernde Geschäftsbeziehung** unterhält **oder** sofern er für die Vertragspartei
  > **Verfügungsmacht** über virtuelle Währungen ausübt".

  **This is DISJUNCTIVE.** A permanent business relationship *alone* suffices, with no power of
  disposal whatsoever. Confirmed by diffing the pre-2021 ordinance, which contained no such letter.
- "Permanent business relationship" is defined at AMLO-FINMA (SR 955.033.0) Art. 2(d): a customer
  relationship "die sich nicht in der Vornahme einmaliger unterstellungspflichtiger Tätigkeiten
  erschöpft" (not exhausted in a single act).

*Inference:* an installed app with an ongoing user relationship is, on its face, within Art. 2(d).

### 1.2 The carve-out, and its limit

Both come from the same document: the EFD explanatory report to the DLT ordinance, 18 June 2021.

- §4.6: "Tatsächliche Non-Custody Wallet Anbieter, die bloss eine Software zuzüglich die
  erforderliche Lizenzierung, nicht aber **Zusatzleistungen** zur Verfügung stellen, sollen hingegen
  weiterhin nicht dem Geldwäschereigesetz unterstellt sein."
- §5.7 limits it: the excluded provider offers no "Zusatzleistungen zur **Auslösung oder
  Durchführung von Zahlungen**".

Two things about that carve-out matter more than its text. It is an **explanatory report** —
persuasive in Swiss interpretation, binding on nobody. And the words *Software*, *Wallet* and
*rein technisch* appear **nowhere** in the AMLA or the AMLO themselves.

**The sentence in the same report that most endangers dpay**, verbatim:

> "Gerade dort, wo eine dauerhafte Kundenbeziehung besteht und für den Gebrauch der technischen
> Lösung die **Verfügbarkeit der Dienstleistung** erforderlich ist, wird die Grenze zu einer
> finanzintermediären Tätigkeit überschritten, obwohl möglicherweise **keine alleinige
> Verfügungsmacht** des Dienstleisters vorliegt."

### 1.3 Exchange is an independent trigger, custody-free

- FINMA ICO Guidelines, 16 Feb 2018, §3.7: "the exchange of a cryptocurrency for fiat money or a
  different cryptocurrency falls under Art. 2 para. 3 AMLA."
- But every official description of that trigger — Federal Council 2018 DLT report, under
  "Wechselstuben" — describes an exchanger dealing "direkt aus dem Eigenbestand" in a
  "Zweiparteienverhältnis", i.e. as **counterparty**.
- AMLO Art. 5(1)(a) does not list virtual currencies at all.

*Open:* whether the exchange trigger reaches a UI that neither quotes nor executes is unaddressed in
anything found.

### 1.4 What FINMA itself has said — and when

- **The clearest pro-non-custody statement is STALE.** Jahresbericht 2018, p.31: non-custody wallet
  providers "sind … nach geltendem Recht … nicht dem Geldwäschereigesetz unterstellt". "nach
  geltendem Recht" means the law as it stood in 2018 — which changed in 2021. No FINMA restatement
  since.
- FINMA's current authorisation page says "providing wallet services" is AMLA-subject and draws **no**
  custodial/non-custodial distinction.
- **DeFi control indicators**, Jahresbericht 2023 p.34: in every enquiry the supposedly decentralised
  application in fact had "kontrollierende Betreiber". Indicators included "die
  **Geschäftsbeziehungen mit Endnutzerinnen und Endnutzern**" and "die **Ertragsflüsse von der
  Applikation zu einer bestimmten Person**".

*Inference:* a permanent user relationship plus per-conversion revenue hits both of those
indicators at once.

### 1.5 The ordinance may exceed its own statutory basis

economiesuisse, the Swiss Bankers Association, CMTA, VISCHER, FRORIEP and MME all argued in the 2021
consultation that AMLO Art. 4(1)(b) was "zu breit, wenn nicht sogar **extra legem**". The Federal
Council kept it. Untested in court.

A litigable argument is not a compliance plan.

### 1.6 Swiss precedent — who is affiliated and who is not

Two non-custodial wallet vendors, both unlicensed and in **no** SRO, both shipping an embedded swap:

| Entity | UID | Seat |
|---|---|---|
| Shift Crypto AG (BitBox) | CHE-498.818.196 | Adliswil |
| Tangem AG | CHE-390.112.525 | Zug |

**Caution on Shift Crypto:** it routes swap quotes through its **own proxy**, injecting a 150bps
affiliate fee — squarely the FINMA "Ertragsflüsse" indicator (§1.4).

Everyone who takes the **other side** of those trades **is** SRO-affiliated: Mt Pelerin (SO-FIT),
Bity (SO-FIT), Relai (VQF), DFX (VQF), Pocket App (VQF).

*Inference:* observed market practice draws the line at **whether funds pass through you**. That is
market practice, not a safe harbour. No FINMA enforcement action against a software-only provider
was found — undefended is not defensible.

### 1.7 DFX.swiss, corrected

- The entity is **DFX AG**, CHE-429.856.521, Zug. There is no "DFX Swiss AG".
- **VQF member, AMLA financial intermediary, NOT FINMA-licensed.** Verified in FINMA's cross-SRO
  register (`DFX AG | Zug | VQF, Zug`); absent from FINMA's authorised-institutions register and from
  the six-holder fintech-licence list; absent from every other Swiss SRO register checked.
- **Required phrasing in any dpay artifact, verbatim:**
  > "Swiss AMLA financial intermediary, SRO-supervised (VQF), not FINMA-licensed."

  "Regulated" alone overstates it.
- DFX is non-custodial **and** still SRO-affiliated. Being the exchange **counterparty** did that
  work, not custody.
- DFX ring-fences its own wallet software: "The use of this software does not establish a business
  relationship with DFX."

### 1.8 CARF — already in force, and it is a tax exposure, not an AML one

- AEOIA (SR 653.1) Section 2a, amended 1 Jan 2026: CARF is in force in Switzerland now.
- OECD CARF FAQ: "Does the definition of Reporting Crypto-Asset Service Provider … exclude
  non-custodial services effectuating Exchange Transactions? **No.**" The test is "control or
  sufficient influence".
- Triggered by **exchange**, not custody. Separate from AMLA and does not substitute for it.

### 1.9 The bigger flag: dpay's relay may already be a payment system

**FLAGGED, NOT CONCLUDED — and possibly a larger question than the conversion feature.**

FINMA Circular 11/1, Rz 63–66: "das Betreiben von Zahlungssystemen, die Drittparteien die Übertragung
von Vermögenswerten ermöglichen" is AMLA-subject, and an operator in a three-or-more-party model
"ist … **immer** ein unterstellter Finanzintermediär".

dpay's relay is a merchant/payer payment system by that description.

Caveat that cuts the other way: the current version of Circular 11/1 predates AMLO Art. 4(1)(b) and
contains no virtual-currency content at all.

### 1.10 One point in dpay's favour

BGer 2A.62/2007 (30 Nov 2007): because AMLA Art. 2 describes intermediaries "only in an open and
exemplary manner", **purpose outweighs literal wording**; the Court quashed the authority's decision.
Not a crypto case.

---

## 2. EU / MiCA — relevant only if dpay serves EU users

### 2.1 The sentence

Recital 83 — and it is the **only** occurrence of the word "wallet" in all of MiCA:

> "Hardware or software providers of non-custodial wallets should not fall within the scope of this
> Regulation."

Recitals have no binding force. CJEU C-162/97 *Nilsson*, para. 54: "the preamble … has no binding
legal force and cannot be relied on as a ground for derogating from the actual provisions".

**Correct the common error:** the frequently-cited Recital 22 is about **full decentralisation**, not
self-custody wallets. Cite 83, not 22. Recital 22's carve-out appears in **no** operative article
(`decentralis*` occurs in the articles only in the Art. 140/142 review clauses), and ESMA_QA_2671
says whether a platform is fully decentralised "is assessed on a case-by-case basis by the competent
authorities". Do not rely on it.

### 2.2 The real argument: meeting no Art. 3(1)(16) definition

| Definition | Limiter that holds a wallet out | Risk |
|---|---|---|
| Exchange, Art. 3(1)(19)/(20) | requires "**by using proprietary capital**" | Low — the cleanest out |
| Custody, Art. 3(1)(17) | "safekeeping or controlling, on behalf of clients … the means of access" | Low |
| RTO, Art. 3(1)(23) | **none** — no proprietary-capital limiter, no conclusion-of-contract limiter | **Highest** |
| Transfer services, Art. 3(1)(26) | operative text has **no control limiter** at all | High |

For transfer services the only things holding a non-custodial wallet out are the words "on behalf
of", the validators/nodes/miners exclusion in Recital 93, and Recital 83 — i.e. two recitals and a
preposition.

Also on the record:

- ESMA_QA_2653: NCAs "should not rely solely on the qualification provided by the CASP"; attention
  goes to "the order fulfilment flow"; and for retail "there should be a **presumption** that the
  CASP acts as an agent and thus provides execution services".
- **Art. 80(2): a CASP "shall not receive any remuneration, discount or non-monetary benefit in
  return for routing orders received from clients"** (ESMA_QA_2087 confirms it covers both RTO and
  execution). *Inference:* taking a cut of a partner's conversion is a trap in both directions — it
  raises the chance you are inside the perimeter, and it is prohibited if you are.
- **No tied-agent regime exists.** ESMA_QA_2143, answered by the Commission: "a CASP cannot designate
  agents … If a CASP appoints an agent, the agent needs to be a CASP itself." *Inference:* for an
  embedded ramp the question is binary — either the user is genuinely the third party's own customer,
  or dpay is providing the service.

### 2.3 A Swiss entity cannot be MiCA-authorised

Art. 59(2) requires an EU registered office, EU effective management, and an EU-resident director.
No third-country equivalence regime exists.

Reverse solicitation (Art. 61) is practically unavailable to a Play-Store consumer app: ESMA
Guidelines ESMA35-1872330276-2030 (26/02/2025) construe solicitation "broadly" and exclusive
initiative "narrowly", say disclaimers "cannot supersede contrary facts", and the only stated way out
requires EU geoblocking **and** the app being unavailable in EU app stores.

Structural point worth more than the guidelines: Art. 61 only engages a firm that **is** providing a
crypto-asset service. If dpay provides none, it never needed Art. 61 — and invoking it concedes the
opposite.

### 2.4 Market check — ESMA interim CASP register (335 entities, 2026-08-21)

Absent: MetaMask/Consensys, Phantom, Trust Wallet, Exodus, Uniswap, Ledger.

**Coinbase Wallet is not covered by Coinbase Luxembourg's CASP authorisation, and Coinbase says so:**
"None of these self-custodial wallets or the DEX trading feature, are provided by CB Lux, and the
protections afforded by MiCA do not apply."

Firms that did licence self-custody products licensed only the leg they intermediate — Deblock:
c/d/e, no custody; Relai EU: c only.

### 2.5 The counter-example that matters

**Enforcement against a non-custodial wallet has happened.** CONSOB (Italy) Resolution 23639,
2025-07-16, ordered cessation under MiCA Art. 59 because through the site "users are offered the
possibility … to open an account to **place orders to buy and/or sell** crypto-assets"
(Atomic Wallet). Also: CNMV warning 2025-11-24; AMF blacklist since 2023-10-12; FCA Warning List
2024-11-28.

"We're only an interface" is close to verbatim Atomic Wallet's own defence. It failed in four
jurisdictions.

### 2.6 The best NCA statement for self-custody, and its limit

BaFin Merkblatt, 03.01.2025: no coverage where providers have "**keinen bestimmungsgemäßen Zugriff**"
(no access by design). That sentence sits in the **custody** section; BaFin does not expressly clear
non-custodial wallets of **transfer services**.

---

## 3. US precedent — persuasive only, and the most instructive material on the record

### 3.1 The decisive contrast

***SEC v. Coinbase***, No. 1:23-cv-04738 (S.D.N.Y.), Failla J., 2024-03-27, 726 F. Supp. 3d 260 — the
**Wallet broker claim was DISMISSED**, even though Coinbase charged a 1% fee, compared prices across
third-party platforms, and routed orders to DEXs:

> "**Coinbase's participation in the order-routing process is minimal** … Coinbase has no control
> over a user's crypto-assets … **Only a user has control over her own assets, and the user is the
> sole decision-maker**"

> "providing pricing comparisons does not rise to the level of routing or making investment
> recommendations"

> "**the fact that Coinbase has, at times, received a commission does not, on its own, turn Coinbase
> into a broker**"

District court, never appealed — persuasive, not binding.

***SEC v. Consensys***, E.D.N.Y. 1:24-cv-04578, filed 2024-06-28, charged MetaMask Swaps as an
**unregistered broker** — and the theory was **architectural, not fee-based**:

> "Consensys's **Spender.sol smart contract address temporarily holds the investor's Crypto Asset A**"

> it "**is the counterparty to the trade**"

plus recommending the "**best**" value. Dismissed with prejudice 2025-03-27 (LR-26277), expressly
"**not on any assessment of the merits**".

**The lesson, and it is the single most load-bearing fact in this file:** Coinbase Wallet never
touched the funds; MetaMask's contract did.

### 3.2 The rest of the US record

- **Uniswap Labs:** Wells notice 2024-04-10; investigation **closed with no action** — per Uniswap
  2025-02-25. No SEC document confirms it; the SEC does not publish closings.
- **CFTC** has only ever charged front-ends over **leverage** — ZeroEx/0x and Opyn/Deridex (2023),
  Uniswap Labs $175k (2024). Never the swap, never the fee. 0x charged **no** fee and was fined
  anyway.
- **CFTC Staff Letter 26-09, 2026-03-17:** no-action for **Phantom** as a self-custodial wallet
  developer, reasoning it will be "**passively providing software**" with "no discretion with respect
  to the routing or execution of User orders" — at the price of 10 conditions including
  joint-and-several liability with collaborators. Covers CFTC-regulated derivatives, not spot.
- **SEC Division of Trading and Markets Staff Statement, 2026-04-13 (File No. 4-894)** — the closest
  written answer anywhere, and it covers interfaces "embedded in a wallet". Conditions include: no
  commentary that a route is "**best price**" or "most reliable"; compensation limited to "a fixed
  charge to the user … **product, execution route, execution venue, and counterparty agnostic**",
  with n.12 precluding compensation "from any person other than the user". It excludes anyone
  "holding, having access to, handling, managing, or possessing user funds …; executing or settling
  transactions; or **taking or routing orders**". Its own n.1: "**it has no legal force or effect**";
  securities only; self-destructs 2031.

### 3.3 FinCEN — and a widespread error to correct

- FIN-2019-G001 §4.5.1(b): "**An anonymizing software provider is not a money transmitter** …
  suppliers of tools … are engaged in trade and not money transmission."
- **The guidance never states that an unhosted wallet *provider* is not a money transmitter.**
  §4.2.1's sentence is about the **user/payer**. The provider-level conclusion has to be *built* from
  the four §4.2 criteria — who owns the value, where it is stored, direct interaction, and "**total
  independent control**" — not quoted.
- FinCEN MSB register (33,414 records, 2026-08-30): Consensys, MetaMask, Phantom,
  Uniswap/Universal Navigation, Exodus — **none registered**. Exodus states the position in its
  FY2025 10-K: it does not "exercise total independent control over the value in our users' wallets".

### 3.4 Criminal exposure survives the 2025 policy thaw

18 U.S.C. §1960(b)(1)(C) — knowingly transmitting criminal proceeds — is expressly carved **out** of
DOJ's 2025 "Ending Regulation By Prosecution" memo. Roman Storm convicted on the §1960 count
2025-08-06 (not yet sentenced; retrial on the other counts 2027-04-26). Samourai Wallet guilty pleas
2025-07-30.

Architecture is no defence to that prong.

---

## 4. Design constraints — the checklist

**This is the operational payload of the whole file.** Ranked by weight of primary evidence.

1. **Never route funds through a dpay-controlled address or contract, even momentarily.** The single
   load-bearing constraint: it is the whole SEC theory against MetaMask (§3.1), and the converse of
   why Coinbase Wallet won.
2. **Never be able to release, stop, or reverse a transaction** — the *Verfügungsmacht* limb (§1.1).
3. **Let the user's own device submit the signed transaction.** Do not relay or broadcast through
   dpay infrastructure. MiCA transfer services has no control limiter (§2.2), and this is the limb
   most arguable against dpay today (§1.9).
4. **Never label a route "best".** Charged against Consensys; expressly barred by the 2026 SEC staff
   conditions (§3.1, §3.2).
5. **Let the user choose the venue. Do not exercise routing discretion.**
6. **Take no venue-paid compensation.** If there is any fee, a flat user-paid one, venue- and
   counterparty-agnostic. The founder's stated "no cut" is the safest option, and it is what
   MiCA Art. 80(2) and FINMA's revenue-flow indicator independently point at.
7. **Relay the provider's own rate, attributed and timestamped. Never compute or blend one.**
8. **Anything touching leverage** is the one thing the CFTC has actually charged.

---

## 5. What this means for the claim dpay currently makes

*Inference, and the reason this file exists:* "non-custodial, therefore not a money transmitter /
VASP / CASP" is a **product rule that holds** and a **legal conclusion that does not**, at least in
Switzerland, where Art. 4(1)(b) has been disjunctive since 2021 (§1.1). The non-negotiable in
`CLAUDE.md` is unaffected — the design constraints in §4 make it *stronger*, not weaker. What must
change is the confidence attached to the legal consequence.

---

## 6. Cost of the alternative, so it can be sized

| Item | Amount |
|---|---|
| SRO membership, year one | ~CHF 4,000–9,000 |
| SRO membership, thereafter | ~CHF 2,000–5,500/yr |
| VQF | CHF 2,000 admission + CHF 1,250 minimum annual |
| SO-FIT | CHF 3,000 + CHF 4,600 for VASP activity — the only fixed, disclosed crypto price found |
| External AML audit | on top of the above |

The membership fee is not the real cost. **The duty set is:** KYC from **CHF 1,000** per
virtual-currency transaction (AMLO-FINMA Art. 51a), beneficial-owner identification, 10-year
retention, a qualified Swiss-resident AML officer (a solo founder qualifies under the ≤5-FTE relief),
MROS reporting, and asset freezing.

A FINMA **licence** is a different universe — CHF 300,000 permanently locked minimum capital
(BankO Art. 17a) — and it exists to let you take custody. If you never hold user funds, it buys you
nothing.

---

## 7. Open questions for counsel

Ask these in these words.

1. **First, and in this wording:** is an in-app convert screen that displays a third party's quote
   and has the user sign a "*Zusatzleistung zur Auslösung oder Durchführung von Zahlungen*" under
   **AMLO Art. 4(1)(b)**? No FINMA statement, FAQ, ruling or enforcement action addresses it.
2. Does dpay's **existing** relay/payment system already trigger AMLA under **FINMA Circular 11/1
   Rz 63–66** (three-or-more-party payment system)? Possibly larger than the swap question. Flagged,
   not concluded.
3. Does the "permanent business relationship" limb of AMLO Art. 4(1)(b) catch an installed wallet app
   at all?
4. **CARF:** does dpay have "control or sufficient influence" if it ships a convert screen?
5. If EU users are served: does the transfer-services limb bite, and does anything dpay operates
   submit signed payloads?

---

## 8. The limits of this research — read before relying on any of it

Recorded honestly, because the gaps are load-bearing:

- **No regulator anywhere has answered the core question.** Not FINMA, not ESMA, not an NCA, not the
  SEC or CFTC outside no-action letters that disclaim force.
- **ESMA's 49 MiCA Q&As contain zero matches** for self-custody, non-custodial, front-end, interface,
  software, or DeFi.
- **The strongest Swiss carve-out is an explanatory report, not law** (§1.2).
- **FINMA's clearest pro-non-custody statement predates the 2021 rule change** (§1.4).
- The one enforcement precedent squarely against a non-custodial wallet went **against** the
  interface argument, in four jurisdictions (§2.5).
- The best-fitting written US guidance disclaims legal force in its own first footnote, is limited to
  securities, and expires in 2031 (§3.2).
