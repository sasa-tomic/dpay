/**
 * i18n/domains/en/pay.ts - the Pay + Receive screens: type AND English values, co-located.
 *
 * Covers PayMode, SolPayMode, ReceiveMode, SolReceiveMode, QrScanner and AssetPicker. The two
 * namespaces are composed into `Messages` / `en` by i18n/keys.ts + i18n/en.ts.
 *
 * Conventions (see keys.ts for the full rationale):
 *   • Interpolation is a typed FUNCTION, never a '{{placeholder}}' string, so a locale can move the
 *     value anywhere in the sentence. That includes the *branching* copy - `fundBody` takes the
 *     action, and `showToPayer` takes the NFC state, rather than letting the caller splice an
 *     English verb or suffix into a template.
 *   • Money is formatted by fmtCurrencyAmount/fmtAsset at the call site and passed in ALREADY
 *     FORMATTED. This catalog never formats numbers.
 *   • A few strings are read across the two namespaces (ReceiveMode reads `M.pay.notAPaymentCode`,
 *     SolReceiveMode reads `M.pay.createTokenAccount`). That is deliberate: the sentence is the same
 *     fact on both screens, and one copy is the point. Same reason PayMode reads `M.nfc.paidAmount`.
 */

export type PayMessages = {
  // --- decode + expiry refusals -------------------------------------------------------------
  /** Also used by ReceiveMode when the merchant scans something that isn't a signed dpay envelope. */
  notAPaymentCode: string;
  /** A scanned `bitcoin:`/`ethereum:` payment request - another wallet's format, on a network no
   *  dpay rail settles on. `coin` is the proper noun, `uri` the scheme spelling (`bitcoin:`); both
   *  are never-translated display constants (see coinDisplayOfScheme), so every locale moves them
   *  freely. The instruction is the point: name the coin, say dpay can't pay it, point elsewhere. */
  scannedCoinRequest: (coin: string, uri: string) => string;
  requestExpired: string;

  // --- the outcome (paid) screen ------------------------------------------------------------
  /** Pending hand-off headline. `amount` is null when an NFC pay left no decoded request behind. */
  sent: (amount: string | null) => string;
  alreadyPaid: string;
  toWho: (who: string) => string;
  toWhoAwaiting: (who: string) => string;
  alreadyNotCharged: (amount: string, who: string) => string;
  /** SOL twin of toWhoAwaiting; `who` is null when the payment arrived over NFC (no request state). */
  solAwaiting: (who: string | null) => string;
  newPayment: string;

  // --- share affordances --------------------------------------------------------------------
  /** One label for every share-a-signed-code button, both rails (was three near-identical keys). */
  shareReceipt: string;
  shareSignedCode: string;
  /** Confirmation labels handed to shareConfirmLabel()/useCopyFeedback. */
  linkCopied: string;
  copied: string;

  // --- the signed hand-off QR ---------------------------------------------------------------
  showThisTo: (who: string) => string;
  showThisToMerchant: string;
  amountToWho: (amount: string, who: string) => string;
  signedOnThisDevice: string;
  signedOffline: string;
  waitingToScan: (who: string) => string;
  offlineSettles: (who: string) => string;
  solOfflineSettles: string;
  handedTo: (who: string) => string;
  handedToMerchant: string;
  handedOffHint: string;

  // --- review + sign ------------------------------------------------------------------------
  unsupportedAsset: string;
  unsupportedAssetBody: (currency: number) => string;
  paying: string;
  payAmount: (amount: string) => string;
  notEnoughBalance: string;
  localBalanceMayNotCover: string;
  approve: string;
  approveA11y: string;
  approveHint: string;
  signing: string;
  signsOffline: string;

  // --- a shared payment link that cannot be paid --------------------------------------------
  // Every branch names the asset/chain the link asked for and ends with the one action the payer
  // can take. dpay never swaps, so "pay it with something else" is never offered.
  link: {
    title: string;
    /** Which part of the link is missing or damaged (composed into `malformed`). */
    part: {recipient: string; asset: string; network: string; amount: string; ref: string};
    malformed: (part: string) => string;
    unknownAsset: (token: string, network: string) => string;
    wrongNetwork: (token: string, network: string) => string;
    hiddenAsset: (token: string) => string;
    unsupportedAsset: (token: string) => string;
    badAmount: (amount: string, token: string) => string;
    badAccount: (network: string) => string;
  };

  // --- an OpenCryptoPay merchant checkout -------------------------------------------------------
  // A static checkout QR resolves to a live quote at a provider dpay does not control, so every string
  // here is either a refusal or an honesty marker. Two rules shape the copy:
  //   • Nothing the provider sends is verified by dpay - the merchant name is CLAIMED and the host
  //     the quote came from is shown, so "why does this say another company's name" is answerable.
  //   • The payer moves irreversible funds BEFORE the provider is told, and gets exactly one chance
  //     to tell it (docs/specs/2026-09-01-opencryptopay-findings.md, "The loss path"). So the
  //     post-transfer keys must say neither "paid" nor "failed", and must hand the payer the
  //     transfer's reference - it is the only thing that ties their money to this sale.
  ocp: {
    /** An OpenCryptoPay checkout that takes a Solana token but whose code carries no token account.
     *  `symbol` names the token (USDC, EURC, …). */
    solanaTokenUnsupported: (symbol: string) => string;
    /** The checkout doesn't take the selected asset, but DOES take others this wallet can pay from the
     *  screen the payer is already on. Heading for that menu. Distinct from `assetNotAccepted`,
     *  which is the dead end - this one has options under it, so it must not send anyone to
     *  Balances. Names the declined asset so the switch is never silent. */
    chooseAsset: (selected: string) => string;
    assetNotAccepted: (selected: string, accepted: string) => string;
    /** The checkout DOES take the selected asset, but its provider says it cannot settle that method
     *  right now. `alternatives` is null when nothing else the checkout takes is payable here - there
     *  is then no "switch in Balances" to point at, so the branch must not pretend there is. */
    methodUnavailable: (selected: string, alternatives: string | null) => string;
    /** The checkout takes nothing this wallet can pay - a true dead end for dpay, said plainly. */
    noPayableAsset: (accepted: string) => string;
    quoteExpired: string;
    /** The price is still live but has too little time left for the whole sequence (move the funds,
     *  then report them ONCE) to finish inside it. A DIFFERENT fact from `quoteExpired`: the
     *  countdown is still on screen, so calling it expired would be visibly false. */
    notEnoughTime: string;
    /** The provider's `callback` yields no submission URL, so a payment made here could never be
     *  reported (`unreportable-callback`). Its own instruction, not `badAnswer`'s: rescanning gets
     *  the same callback, so "scan again" would be a dead end. */
    unreportable: (host: string) => string;
    /** The scanned code's host answered with a `callback` on a DIFFERENT host - so one company
     *  quotes the price while another receives the destination address and the proof of an
     *  irreversible transfer. The review can only show one host, so a payment whose two hosts
     *  disagree is refused instead: that is what keeps the host on screen the host that gets the
     *  money's proof. Names both, because which two they are is the whole point. */
    proofElsewhere: (quoteHost: string, proofHost: string) => string;
    /** What the checkout is charging in ITS OWN unit ("CHF 1"), on the review beside the asset amount.
     *  `price` arrives ALREADY FORMATTED (this catalog never formats numbers). Without it the payer
     *  approves "0.0000162 BTC" with no way to check it against the price on the checkout.
     *
     *  It is the MERCHANT's figure, and naming `host` in the same breath is what says so - the
     *  provider, not dpay, decided how much crypto that fiat price costs. That attribution used to
     *  be a second sentence of policy ("dpay doesn't convert"), which is a note to dpay rather than
     *  to the person at the checkout (founder, 2026-09-09). `providerHost` says the same thing with no
     *  price, for a provider that sent none. */
    checkoutPrice: (price: string, host: string) => string;
    /** Shown while the two provider reads are in flight - up to half a minute of nothing, on a
     *  screen the payer just pointed at a QR code. */
    checkingCheckout: string;
    badCode: string;
    notHttps: string;
    providerUnreachable: string;
    /** The provider answered the payment step with something dpay will not sign: a destination on
     *  another ledger, an unreadable address, an amount that is not the one quoted, or a settlement
     *  chain other than the one the payer chose. Nothing has moved - this is a refusal BEFORE the
     *  money, and a red flag worth naming as one. */
    badDestination: (host: string) => string;
    /** The provider REFUSED and said why, in its own words. That sentence is written by a company
     *  dpay does not control, in its own language and vocabulary ("Payment link not found",
     *  "Invalid method or asset"), so it is never spoken as dpay's own instruction - but it is the
     *  one thing the payer can repeat to the merchant, so it is not thrown away either. The
     *  localized half says what happened and what to do; `detail` is QUOTED after it. Nothing has
     *  been paid at this point. */
    providerRefused: (host: string, detail: string) => string;
    /** The provider failed with a status and nothing to quote. `status` arrives ALREADY a string
     *  (the catalog never formats numbers - and an HTTP status must never pick up a locale's
     *  thousands separator). */
    providerFailed: (host: string, status: string) => string;
    /** The provider answered, but the answer is missing or unreadable exactly where the payment
     *  needs it. `part` names the piece - same "name the broken part" shape as `link.part`, so one
     *  sentence serves every incomplete answer instead of four near-identical ones. */
    badAnswer: (host: string, part: string) => string;
    /** The pieces of a provider answer a payment depends on (composed into `badAnswer`). */
    answerPart: {body: string; details: string; destination: string; expiry: string};
    noPendingCharge: (merchant: string) => string;
    /** How each rail names the proof of a transfer, composed into the two keys below (the
     *  `link.part` pattern) so one sentence serves both rails without either being described in
     *  the other's vocabulary. */
    ref: {icBlock: (index: string) => string; solTransaction: (signature: string) => string};
    /** Funds moved; the provider never answered. Honest unknown - never rendered as paid or failed. */
    submitUnknown: (reference: string) => string;
    /** Funds moved, the provider TOOK the report, and its own answer says it has not matched the
     *  transfer yet. Distinct from `submitUnknown`, and the difference is what the payer should do:
     *  there the provider never answered at all, here it answered "not yet" - so waiting is right
     *  and there is nothing to chase. Never rendered as paid; never as failed either. */
    submitPending: (reference: string) => string;
    /** Funds moved; the provider refused the proof. Definitive, and still costs the payer. */
    /** The provider REFUSED the proof after the money moved. `said` is the provider's own sentence
     *  when it gave one, already sanitised - quoted, never presented as dpay's own words. It is the
     *  only statement of WHY the sale went uncredited, and the thing the payer repeats at the checkout;
     *  null when the provider refused without saying anything. */
    submitRejected: (reference: string, said: string | null) => string;
    /** The transfer turned out to have settled only AFTER the price expired, so the one submission
     *  was deliberately not spent on a dead quote - burning it would also bind the transaction id
     *  and take away the user's ability to claim the payment with the merchant. */
    submitTooLate: (reference: string) => string;
    /** The TRANSFER's own outcome is unknown, so the provider was never told (calling it once is
     *  all we get - see the findings doc's loss path). Neither paid nor failed, and no reference
     *  exists to hand over yet.
     *
     *  It promises that dpay keeps checking because BOTH rails now do: the transfer is left
     *  indefinite only where a claim on it survives - the IC envelope, the Solana signature - and
     *  each outcome screen re-polls that claim and reports it if it resolves in time (PayMode /
     *  SolPayMode). The promise is bounded to the screen because the claim lives in that
     *  component's state, which is exactly what "keep this screen open" says. */
    transferUnknown: string;
    /** A transfer that had been indefinite turns out to have DEFINITELY not happened: the ledger
     *  refused it. Nothing left the wallet, so this is a relief, not a loss - and the payer needs
     *  to know both that and what to do next. `reason` is the rail's own decoded refusal, which is
     *  a FRAGMENT with no terminal punctuation (`M.rail.*`) - this sentence supplies its own. */
    transferRefused: (reason: string) => string;
    /** Solana included the transaction and it FAILED on-chain: the amount never left the wallet
     *  (the network fee did). Definitive - the payer must pay again, which is the opposite of what
     *  the unknown-outcome copy tells them. */
    transferFailed: string;
    providerHost: (host: string) => string;
  };

  // --- the fund-first gate ------------------------------------------------------------------
  /** Stand-in noun when the selected asset has no display name yet ("No funds available"). */
  fundsSymbol: string;
  /** The gate's headline states the LACK; the action the user was reaching for lives in `fundBody`. */
  fundTitle: (symbol: string) => string;
  fundBody: (symbol: string, action: 'pay' | 'send') => string;
  fundBodyNoDeposits: (symbol: string) => string;
  /** The token-rail fund body - `symbol` names the token (USDC, EURC, …). */
  fundBodyToken: (symbol: string) => string;
  showMyAddress: (symbol: string) => string;
  /** Also used by SolReceiveMode's inline ATA setup card. */
  createTokenAccount: (symbol: string) => string;
  /** The funded-account pointer on a fund-blocked surface (`config/currency.ts` →
   *  `fundedAlternative`): the wallet is empty HERE and holds money THERE, so the screen names it
   *  instead of asking for a deposit and nothing else.
   *
   *  `holds` serves the two REAL kinds - a rail of the same home currency, and an account in
   *  another currency - with the amount exactly as the balances map renders it (unit included,
   *  never merged, never converted). Their buttons differ because their ambiguity does: two rails
   *  of one currency are told apart by their CHAIN, while two accounts on the same chain are told
   *  apart only by their ASSET.
   *
   *  `practice` is its own sentence because practice money is its own thing: it must state both
   *  that a payment can be rehearsed with it AND that it buys nothing from a real merchant. Never
   *  reuse `holds` for it - "You hold ∂100.00" beside a merchant's price is a lie by omission. */
  fundSibling: {
    holds: (amount: string, rail: string) => string;
    switchTo: (network: string) => string;
    switchToAsset: (asset: string) => string;
    practice: (amount: string) => string;
    switchToPractice: string;
  };

  // --- send-to-address needs a connection; scan-to-pay does not ------------------------------
  /** Shown in place of the send form while the wallet is offline. A send goes straight to the
   *  ledger with no counterparty to carry it, so it is the ONE Pay-tab action airplane mode
   *  genuinely blocks - and the payer's way out is the rail that was built for exactly this. */
  offlineSendTitle: string;
  offlineSendBody: (symbol: string) => string;
  /** A scanned wallet address for an asset that cannot leave the wallet to an address at all. */
  scannedAddressNotSendable: (symbol: string) => string;

  // --- scanned Solana Pay requests (the `solana:` open standard the SOL receive QR speaks) ----
  /** Everything the scan surface + review screen need for a scanned Solana Pay request. The named
   *  refusals mirror `parseSolanaPayUri`'s refusal codes one-for-one (`solana/payUri.ts`), so the
   *  payer always gets the broken part AND the way out - the opencryptopay.ts discipline. */
  spay: {
    /** The IC Pay screen's refusal: this code IS payable - on the Solana rail this wallet
     *  carries. Names the rail and the switch, per the scannedCoinRequest founder rule. */
    wrongRail: string;
    badUri: string;
    badRecipient: string;
    badAmount: string;
    badSplToken: string;
    badReference: string;
    unexpectedParam: (param: string) => string;
    memoTooLong: string;
    /** A spl-token mint the catalog does not carry - named, with the way out. */
    unknownMint: (mint: string) => string;
    /** A Solana Pay transfer is submitted by the payer's own phone, so offline blocks the scan. */
    offline: string;
    /** Label above the amount entry when the URI carried no amount (spec-optional - the receive
     *  QR this wallet emits itself is amount-less). */
    amountLabel: string;
    /** The merchant's `message` param - display text for the payer, sanitised upstream. It is
     *  NOT the on-chain memo; that is the `memo` param, which rides an SPL Memo instruction. */
    merchantMessage: (message: string) => string;
    /** The outcome note when a Solana Pay transfer was ACCEPTED by the network but its
     *  confirmation did not land in the window - the signature is the payer's record, and paying
     *  again is the one action that could double-charge. */
    pendingNote: string;
  };

  // --- WalletConnect wallet side (plan W1): pair copy + the one review sheet ------------------
  /** Everything the scan surface needs when a `wc:` pairing code arrives, plus every string the
   *  WcRequestSheet renders (the proposal review and the per-method request review). The sheet is
   *  the security boundary of the whole wallet side, so the review lines name the counterparty
   *  app, the chain, and exactly what would be signed - never a bare hex blob alone. */
  wc: {
    /** A scanned/tapped `wc:` code could not pair (web, or the wallet side disabled). */
    unavailable: string;
    /** `pair()` threw - a damaged or expired pairing URI. */
    pairFailed: string;
    connectTitle: string;
    connectHeadline: string;
    /** A method request under review (the sheet title). */
    requestTitle: string;
    appLabel: string;
    chainLabel: string;
    chainsLabel: string;
    messageLabel: string;
    domainLabel: string;
    typeLabel: string;
    fieldsLabel: string;
    toLabel: string;
    amountLabel: string;
    spenderLabel: string;
    ownerLabel: string;
    deadlineLabel: string;
    dataLabel: string;
    /** A decoded ERC-20 amount the sheet cannot scale (no decimals without the catalog). */
    rawUnits: (amount: string) => string;
    /** Calldata matched no known token action: raw hex plus this explicit warning line. */
    unknownCall: string;
    /** Solana review rows (Track S): venue-neutral labels + the honest notes. */
    fromLabel: string;
    mintLabel: string;
    memoLabel: string;
    programLabel: string;
    feePayerLabel: string;
    signersLabel: string;
    /** A program id the static account table cannot resolve (it sits in an address-lookup table). */
    lookupTableProgram: string;
    /** Unknown instruction / undecodable transaction: the explicit warning before any raw display. */
    unknownTx: string;
    /** The signMessage bytes are not valid UTF-8 - the raw-bytes fallback note. */
    rawBytesNote: string;
    /** The fee payer is not this wallet (sponsored tx): displayed, then the user decides. */
    externalFeePayer: string;
    /** The transaction needs signatures besides the device's: the whole request is refused. */
    coSignNote: string;
    /** The device is not among the required signers: the request is refused. */
    notSignerNote: string;
    /** signAndSendTransaction broadcasts on approve - the money-safety line. */
    broadcastNote: string;
    switchHeadline: (chain: string) => string;
    approve: string;
    reject: string;
    submittedTitle: string;
    /** The submitted-not-settled terminal: the network accepted the broadcast, settlement did
     *  not happen yet - the hash is the record (the send path's honest-unknown shape). */
    submittedNote: string;
  };

  // --- the scan surface + its NFC status row ------------------------------------------------
  scanToPay: string;
  sendToAddress: string;
  tapOrScanToPay: string;
  solScanHint: string;
  nfcNotAvailable: string;
  whyNfcUnavailable: string;
  nfcUnavailableTitle: string;
  close: string;

  // --- the camera scanner (QrScanner) --------------------------------------------------------
  noCameraFound: string;
  pointCamera: string;
  cameraPrivacy: string;
  allowCameraScan: string;
};

export const payEn: PayMessages = {
  notAPaymentCode: "This isn't a dpay payment code",
  scannedCoinRequest: (coin, uri) =>
    `That's a payment request in ${coin} (${uri}…). This wallet pays on the Internet Computer and Solana - use a wallet that supports ${coin}.`,
  requestExpired: 'This request expired - ask the merchant for a fresh QR',

  sent: amount => (amount ? `Sent ${amount}` : 'Sent'),
  alreadyPaid: 'Paid',
  toWho: who => `to ${who}`,
  toWhoAwaiting: who => `to ${who} · awaiting the merchant’s confirmation`,
  alreadyNotCharged: (amount, who) => `${amount} to ${who} · not charged again`,
  solAwaiting: who =>
    who ? `to ${who} · awaiting the merchant's confirmation` : "awaiting the merchant's confirmation",
  newPayment: 'New payment',

  shareReceipt: 'Share receipt',
  shareSignedCode: 'Share signed code',
  linkCopied: 'Link copied ✓',
  copied: 'Copied ✓',

  showThisTo: who => `Show this to ${who}`,
  showThisToMerchant: 'Show this to the merchant',
  amountToWho: (amount, who) => `${amount} to ${who}`,
  signedOnThisDevice: 'signed ✓',
  signedOffline: 'signed offline ✓',
  waitingToScan: who => `Waiting for ${who} to scan…`,
  offlineSettles: who =>
    `Offline - ${who} settles it when they submit. Your balance updates once you’re online.`,
  solOfflineSettles:
    "Offline - the merchant settles it when they submit. Your balance updates once it's confirmed.",
  handedTo: who => `Handed to ${who}`,
  handedToMerchant: 'Handed to merchant',
  handedOffHint: 'Marks the payment handed off - your balance updates when the merchant settles',

  unsupportedAsset: 'Unsupported asset',
  unsupportedAssetBody: currency =>
    `This payment asks for an asset this wallet can’t pay (currency ${currency}). dpay never swaps - ask the merchant for a supported asset.`,
  paying: 'Paying',
  payAmount: amount => `Pay ${amount}`,
  notEnoughBalance: 'Not enough balance.',
  localBalanceMayNotCover: 'Your local balance may not cover it - the merchant verifies.',
  approve: 'Approve',
  approveA11y: 'Approve payment',
  approveHint: 'Sign the displayed amount with your key and send it',
  signing: 'Signing…',
  signsOffline: 'Signs offline - the merchant settles it when they submit.',

  link: {
    title: 'This payment link can’t be paid',
    part: {recipient: 'the account to pay', asset: 'the asset', network: 'the network', amount: 'the amount', ref: 'the reference'},
    malformed: part => `The link is missing or has a damaged ${part}. Ask for a new link.`,
    unknownAsset: (token, network) =>
      `The link asks for ${token} on ${network} - you hold none. dpay never swaps: ask for a link in an asset you hold.`,
    wrongNetwork: (token, network) =>
      `The link asks for ${token} on ${network}, but you hold ${token} elsewhere. Paying would land your money on the wrong chain - ask the sender for a link on a network you hold.`,
    hiddenAsset: token =>
      `The link asks for ${token}, a test-network asset. In Balances, turn on “Show testnet assets”, then open the link again.`,
    unsupportedAsset: token =>
      `The link asks for ${token}, which this wallet can’t pay. dpay never swaps - ask for a link in an asset you hold.`,
    badAmount: (amount, token) =>
      `“${amount}” isn’t a valid ${token} amount - check the decimal places. Ask for a new link.`,
    badAccount: network =>
      `That account isn’t a valid ${network} account. Ask the sender to check it and send a new link.`,
  },

  ocp: {
    solanaTokenUnsupported: symbol =>
      `This checkout takes ${symbol} on Solana, but its code doesn’t say which account to pay - money could land on the wrong one, so pay with SOL instead, or switch in Balances.`,
    chooseAsset: selected =>
      `This checkout doesn’t take ${selected}, but it takes these - dpay never swaps.`,
    assetNotAccepted: (selected, accepted) =>
      `This checkout takes ${accepted}, not ${selected}. dpay never swaps - switch in Balances and scan again.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `The checkout takes ${selected}, but its provider can’t process it right now. It also takes ${alternatives} - switch in Balances and scan again.`
        : `The checkout takes ${selected}, but its provider can’t process it, and nothing else it takes is payable here. Ask the merchant for another way to pay.`,
    noPayableAsset: accepted =>
      `This checkout takes ${accepted} - nothing this wallet can pay. dpay never swaps. Pay another way.`,
    quoteExpired:
      'This price expired - scan the code again for a fresh one.',
    notEnoughTime:
      'This price runs out too soon to pay safely - scan again for a fresh one.',
    unreportable: host =>
      `${host} gave no way to report a payment - paying could take your money without crediting the sale. Nothing has been paid. Rescanning won’t help - ask the merchant for another way to pay.`,
    proofElsewhere: (quoteHost, proofHost) =>
      `The price comes from ${quoteHost}, but your payment proof would go to ${proofHost}. One sale can’t answer to two companies. Nothing has been paid - ask the merchant for their own code.`,
    checkoutPrice: (price, host) => `${price} · price from ${host}`,
    checkingCheckout: 'Checking with the payment provider…',
    badCode:
      'This code is damaged, or it isn’t a payment code. Ask the merchant to show it again - check nothing covers it.',
    notHttps:
      'This code points to an insecure address, so dpay won’t open it. Ask the merchant for their code - a sticker over the real one looks identical.',
    providerUnreachable:
      'Couldn’t reach the payment provider. Nothing has been paid - check your connection and scan again.',
    badDestination: host =>
      `${host} returned a payment address that doesn’t match what you chose, so dpay stopped. Nothing has been paid - don’t pay this code. Ask the merchant for a fresh one.`,
    providerRefused: (host, detail) =>
      `The payment provider (${host}) refused this payment. Nothing has been paid. Ask the merchant to open a fresh charge and scan again. If it keeps failing, show them what it said: “${detail}”.`,
    providerFailed: (host, status) =>
      `The payment provider (${host}) returned an error (${status}) with no reason. Nothing has been paid. Wait a moment and scan again; if it keeps failing, ask the merchant for another way to pay.`,
    badAnswer: (host, part) =>
      `The payment provider (${host}) didn’t send ${part}, so dpay can’t pay this checkout. Nothing has been paid. Scan again, and tell the merchant if it keeps happening.`,
    answerPart: {
      body: 'a readable answer',
      details: 'complete payment details',
      destination: 'a payment address',
      expiry: 'a readable expiry time',
    },
    noPendingCharge: merchant =>
      `${merchant}’s checkout has no charge open. Ask the cashier to open one, then scan again.`,
    ref: {
      icBlock: index => `ledger block ${index}`,
      solTransaction: signature => `Solana transaction ${signature}`,
    },
    submitUnknown: reference =>
      `Your transfer went through, but the provider didn’t confirm it - neither paid nor failed. The money has left your wallet: don’t pay again. Show the merchant ${reference}, your transfer’s proof.`,
    submitPending: reference =>
      `Your transfer went through and the provider has been told - it hasn’t matched this sale yet; it credits when it sees the transfer. The money has left your wallet: don’t pay again. If the checkout doesn’t show it, give the merchant ${reference}.`,
    submitRejected: (reference, said) =>
      `Your transfer went through, but the provider refused the proof - the sale wasn’t credited. The money has left your wallet: don’t pay again. Give the merchant ${reference}.`
      + (said === null ? '' : ` The provider said: “${said}”`),
    submitTooLate: reference =>
      `Your transfer went through, but only after the price expired - the sale wasn’t credited. The money has left your wallet: don’t pay again. Give the merchant ${reference}.`,
    transferUnknown:
      'Your transfer isn’t confirmed yet, so the merchant hasn’t been told - neither paid nor failed. Keep this screen open: dpay is still checking and will finish the payment if it went through. Don’t pay again meanwhile.',
    transferRefused: reason =>
      `The transfer didn’t go through - nothing was paid and your money is still in your wallet: ${reason}. Scan again to pay.`,
    transferFailed:
      'The Solana network rejected your transaction - nothing was paid. Your amount is intact; a small network fee was charged. Scan again to retry.',
    providerHost: host => `Price from ${host}`,
  },

  fundsSymbol: 'funds',
  fundTitle: symbol => `No ${symbol} available`,
  fundBody: (symbol, action) =>
    action === 'pay'
      ? `To pay in ${symbol}, first receive ${symbol} at your address.`
      : `To send ${symbol}, first receive ${symbol} at your address.`,
  fundBodyNoDeposits: symbol =>
    `dpay cannot show a deposit address for ${symbol}. Receive it from another wallet before spending it.`,
  fundBodyToken: symbol => `Send ${symbol} (Solana) to your ${symbol} address. Keep a little SOL in the wallet for network fees.`,
  showMyAddress: symbol => `Show my ${symbol} address`,
  createTokenAccount: symbol => `Create my ${symbol} account`,
  fundSibling: {
    holds: (amount, rail) => `You hold ${amount} on ${rail}`,
    switchTo: network => `Switch to ${network}`,
    switchToAsset: asset => `Switch to ${asset}`,
    practice: amount =>
      `You have ${amount} in practice money. Practise with it - it has no cash value and cannot pay a real merchant.`,
    switchToPractice: 'Switch to practice money',
  },

  offlineSendTitle: 'Sending to an address needs a connection',
  offlineSendBody: symbol =>
    `Scan the merchant's code instead - their phone submits your ${symbol} payment while you're offline.`,
  scannedAddressNotSendable: symbol =>
    `That's a wallet address - ${symbol} can't be sent to one. Scan a payment code to pay.`,

  spay: {
    wrongRail:
      "That's a Solana Pay code. This screen settles on the Internet Computer - switch to Solana in Balances and scan it there.",
    badUri: 'This Solana Pay code is damaged. Ask the merchant for a fresh QR.',
    badRecipient: "This code's recipient isn't a valid Solana address. Ask the merchant for a fresh QR.",
    badAmount: "This code's amount isn't a plain number above zero. Ask the merchant for a fresh QR.",
    badSplToken: "This code's token mint isn't valid. Ask the merchant for a fresh QR.",
    badReference: "This code's payment reference isn't valid. Ask the merchant for a fresh QR.",
    unexpectedParam: param =>
      `This code carries an unknown parameter (${param}), so dpay can't review what paying would sign. Ask the merchant for a code without it.`,
    memoTooLong: "This code's memo is too long for a Solana transaction. Ask the merchant for a fresh QR.",
    unknownMint: mint =>
      `This code asks for a token dpay doesn't carry (mint ${mint}). Pay it with a wallet that supports it.`,
    offline:
      'Paying a Solana Pay code submits from your phone, so it needs a connection - go online and scan again.',
    amountLabel: 'Amount',
    merchantMessage: message => `From the merchant: ${message}`,
    pendingNote:
      'The network accepted this payment; confirmation is still on the way. The signature below is your record - check it before paying again.',
  },

  wc: {
    unavailable: 'WalletConnect is unavailable. Use the dpay mobile app to connect.',
    pairFailed: 'This WalletConnect code did not work. Ask the app for a new one.',
    connectTitle: 'Connect',
    connectHeadline: 'An app wants to connect',
    requestTitle: 'Sign request',
    appLabel: 'App',
    chainLabel: 'Chain',
    chainsLabel: 'Chains',
    messageLabel: 'Message',
    domainLabel: 'Domain',
    typeLabel: 'Type',
    fieldsLabel: 'Fields',
    toLabel: 'To',
    amountLabel: 'Amount',
    spenderLabel: 'Spender',
    ownerLabel: 'Owner',
    deadlineLabel: 'Deadline',
    dataLabel: 'Data',
    rawUnits: amount => `${amount} raw units`,
    unknownCall: 'Unknown contract call. Read the raw data before approving.',
    fromLabel: 'From',
    mintLabel: 'Mint',
    memoLabel: 'Memo',
    programLabel: 'Program',
    feePayerLabel: 'Fee payer',
    signersLabel: 'Signers',
    lookupTableProgram: 'address-lookup table',
    unknownTx: 'Unknown instruction. Review the raw data before approving.',
    rawBytesNote: 'Not text - shown as raw bytes.',
    externalFeePayer: 'Another account pays the fee.',
    coSignNote: 'Other signers are required.',
    notSignerNote: 'This wallet does not sign this transaction.',
    broadcastNote: 'Approving sends this transaction to the network.',
    switchHeadline: chain => `Switch chain to ${chain}`,
    approve: 'Approve',
    reject: 'Reject',
    submittedTitle: 'Submitted',
    submittedNote:
      'The network accepted the transaction. Settlement is still pending. The hash is your record.',
  },

  scanToPay: 'Scan to pay',
  sendToAddress: 'Send to address',
  tapOrScanToPay: 'Tap or scan to pay',
  solScanHint: "Scan the merchant's code to pay offline.",
  nfcNotAvailable: 'NFC not available',
  whyNfcUnavailable: 'Why NFC is unavailable',
  nfcUnavailableTitle: 'NFC unavailable',
  close: 'Close',

  noCameraFound: 'No camera found.',
  pointCamera: 'Point the camera at a payment code',
  cameraPrivacy: 'Only used to scan codes. Never recorded or uploaded.',
  allowCameraScan: 'Allow camera scan',
};

export type ReceiveMessages = {
  // --- the request form ----------------------------------------------------------------------
  amountToReceive: string;
  amountPlaceholder: string;
  solAmountPlaceholder: string;
  memo: string;
  memoPlaceholder: string;
  chooseCurrency: string;
  chooseCurrencyHint: string;
  request: string;
  creating: string;
  solanaOffline: string;
  /** NATIVE-SOL request, typed price at or under the one-signature fee: netting would leave
   *  nothing (or less) on the wire, so no request is built. `fee` is the network fee, ALREADY
   *  FORMATTED with its unit - this catalog never formats numbers. */
  solAmountUnderFee: (fee: string) => string;
  /** The ONE honest fee/receives line under a native-SOL request headline (the fee nets payee-side,
   *  founder rule 2026-09-12 - the IC twin is the checkout's `settlesAs`). Both args ALREADY FORMATTED
   *  with units. SPL requests show nothing here: their fee is separate-asset gas that was never
   *  subtracted, so their existing display is already the whole truth. */
  solFeeLine: (fee: string, receives: string) => string;

  // --- the asset picker ----------------------------------------------------------------------
  receiveInTitle: string;
  receiveIn: (symbol: string) => string;
  switchToRail: (symbol: string) => string;

  // --- the request QR screen -----------------------------------------------------------------
  requestPayment: string;
  myAddress: string;
  /** The home-currency rail disclosure on Receive ▸ My address: the fee fact of the SHOWN rail,
   *  in that rail's own unit (never converted, never summed with the sibling's). */
  rail: {
    feeLine: (network: string, fee: string) => string;
    feeWithOneTime: (network: string, fee: string, oneTime: string) => string;
    feeUnknown: (network: string) => string;
  };
  /** The one-line fee disclosure under the request headline (exact-price rule, founder
   *  2026-09-12): the ledger fee this payee absorbs, and what actually arrives once it is
   *  netted out of the wire - both pre-formatted amounts. */
  feeNetLine: (fee: string, net: string) => string;
  /** Refusal: the typed price does not clear the ledger fee, so no honest wire exists (the
   *  customer would be paying the payee's fee twice over). `fee` is pre-formatted. */
  feeTooBig: (fee: string) => string;
  /** 'tap' = the payer may tap instead; 'expired' = the short NFC request lapsed; 'none' = QR only. */
  showToPayer: (nfc: 'tap' | 'expired' | 'none') => string;
  expiredMakeNew: string;
  validForMin: (minutes: number) => string;
  /** `seconds` is already zero-padded by the caller - this catalog never formats numbers. */
  expiresIn: (seconds: string) => string;
  waitingForPayment: (online: boolean) => string;
  waitingForSign: string;
  offlineCantSubmit: string;
  shareRequestLink: string;
  /** Fail-closed gate: a request whose asset or destination cannot be named in a link never opens. */
  linkUnavailable: string;
  /** ONE label for the submit-their-offline-payment button AND the under-scanner line, both rails
   *  (was four near-identical QR/code keys). */
  scanPayerSignedCode: string;
  confirmWithTheirPhone: string;
  newRequest: string;
  back: string;

  // --- the settled outcome -------------------------------------------------------------------
  /** The counterparty noun shown as "from …" when only the role is known. */
  payer: string;
  receivedAmount: (amount: string) => string;
  fromWho: (who: string) => string;
  transactionSignature: string;
  copySignature: string;
  copySignatureA11y: string;
  sharedConfirm: string;

  // --- refusals + reconciliation -------------------------------------------------------------
  receiptMalformed: string;
  receiptMismatch: string;
  receiptUnreadable: string;
  couldNotConfirmYet: string;
  unknownLedger: string;
  /** A thrown submit is a LOCAL failure AFTER the envelope POST (icSubmit never throws) - the
   *  outcome is unknown, and the old copy blamed a connection this path never touched. */
  couldNotSubmit: string;
  noOpenRequest: string;
  paymentRejected: string;
  paymentRejectedDetail: string;
  couldNotConfirmMaySettle: string;
  stillCannotConfirm: string;
  /** Settle-verify MISMATCH (receipt code 3): the tx confirmed with a body that isn't this
   *  request. Terminal doubt - check-before-handover copy; the reconcile card stays armed. */
  settlementNotVerified: string;
  savedDataCorrupt: string;
  paymentBeingConfirmed: string;
  broadcastInterrupted: string;
  retryBroadcast: string;
  broadcasting: string;

  // --- the checkout: the merchant's own OpenCryptoPay charge -------------------------------------
  /**
   * The counter (`components/CheckoutCharge.tsx`). A checkout charge is the SAME request with a wider
   * audience, so it lives inside "Request payment" as a second code FORM rather than a third tab -
   * which is why the first two keys read as two kinds of CODE and not two kinds of screen.
   *
   * Almost everything here is a dead end, on purpose: a code that expired, a checkout that was never
   * turned on, a relay that cannot be reached, a price the checkout answered differently. Each one must
   * say what happened AND the merchant's next move (founder rule 2026-08-29) - and none of them may
   * ever imply a payment did or did not arrive, because only the relay's own ledger read can say
   * that (`services/checkout.ts`).
   */
  checkout: {
    /** The checkbox under the amount: the same request, two audiences. The label says what the box
     *  does - also produce a code that OpenCryptoPay-compatible apps (Binance Pay, MoonPay) can
     *  scan - and that the payer must be online (this is an online-payer standard). */
    checkoutCode: string;

    openChargeHint: string;
    /** Why the typed total cannot be a checkout charge. Three causes, three different corrections. */
    badAmount: (reason: 'too-precise' | 'not-a-number' | 'too-large') => string;

    /** The selected asset is not the one a checkout code is paid in. `network` is the chain's proper
     *  noun (null for an asset that has none), so the refusal names the rail as well as the asset. */
    wrongAssetTitle: string;
    wrongAsset: (selected: string, network: string | null) => string;
    /** …and this wallet carries no checkout asset at all, so there is no switch to offer. */
    noCheckoutAsset: string;
    switchTo: (asset: string) => string;

    /** Opening a charge did not happen. Nothing is payable in any of these - say so, then say what next. */
    failedTitle: string;
    notServed: (host: string) => string;
    /** The CLASSIFIED blame (work order 2026-09-30): offline blames nobody; the online arm
     *  says the connection is fine and names the relay(s) that did not answer. */
    unreachable: (host: string) => string;
    unreachableOffline: (host: string) => string;
    /** The checkout's OWN sentence, quoted: it already names the fix (the price bound, the clock skew,
     *  the reused nonce), and it is what the merchant repeats to whoever runs the relay. */
    refused: (said: string) => string;
    refusedNoReason: (status: number) => string;
    /** The checkout answered with a price that is not the one that was opened. */
    mispriced: (entered: string, quoted: string) => string;
    /** The checkout opened the charge in an asset OTHER than the one picked - it serves what it
     *  serves, and nothing is shown for a charge the counter did not open. `served` names the
     *  asset the checkout DID open, `picked` the currency the cashier chose. */
    servedOther: (served: string, picked: string) => string;
    unsigned: string;
    tryAgain: string;

    /** The settlement picker (multi-currency build-out): the label over the joined asset pills,
     *  and one pill - `token` names the ledger token that settles, `currency` the currency the
     *  price is read in. One line = the whole honest contract of a multi-asset checkout. */
    settleOption: (token: string, currency: string) => string;

    /** The code is up. `settlesAs` states what the SHOP receives beside what the customer pays -
     *  two different numbers since 2026-09-12, because the shop absorbs the ledger fee, and a
     *  cashier shown only the smaller one would read it as a bug. */
    settlesAs: (amount: string, price: string) => string;
    /** The checkout's own asset, on a relay whose catalog states no ledger fee for it. The shop pays
     *  that fee out of the price, so there is nothing to subtract and no honest price to quote. */
    noFeeTitle: string;
    noFee: (symbol: string, host: string) => string;
    /** A customer approved this shop to COLLECT rather than sending the money, and this phone is
     *  spending that allowance. `collecting` is the live line; the three refusals send the cashier
     *  to three different places, which is why they are three strings and not one. */
    collecting: string;
    collectNotApproved: string;
    collectNoFunds: string;
    collectFailed: string;
    /** How the customer can pay THIS code. `tap` = the reader is armed; `expired` = the tap
     *  request's certified expiry has passed while the code itself is still payable (it scans for
     *  the rest of its hour); `none` = this phone could not build a tap request at all. */
    showToCustomer: (nfc: 'tap' | 'expired' | 'none') => string;
    waiting: string;
    /** The checkout is out of contact. NEVER "unpaid" - the whole reason this string exists. */
    cantCheck: string;
    /** Expired, and still watching: an offline payer's transfer can land after the deadline. */
    expiredWatching: string;
    cancel: string;
    cancelling: string;
    /** A cancellation that did not clear the checkout - the charge is still payable in every case. */
    cancelFailed: (said: string) => string;
    cancelFailedNoReason: (status: number) => string;
    /** `host` = the relay address(es) actually tried (the pin alone, or the whole walk). */
    /** Classified blame, same split as the open path; the charge stays payable in both. */
    cancelUnreachable: (host: string) => string;
    cancelUnreachableOffline: (host: string) => string;

    /** The four ways a charge stops being payable without being paid. They are told apart because
     *  they send the cashier - and the customer standing there - to do different things. */
    endedTitle: (reason: 'expired' | 'cancelled' | 'superseded' | 'gone') => string;
    endedBody: (reason: 'expired' | 'cancelled' | 'superseded' | 'gone') => string;
    openChargeNext: string;

    paidAmount: (price: string) => string;
    /** The ledger row that paid - the merchant's proof, and the reason no other charge can claim it. */
    paidBlock: (block: number) => string;
    paidLate: string;
  };
};

export const receiveEn: ReceiveMessages = {
  amountToReceive: 'Amount to receive',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Memo',
  memoPlaceholder: 'Add a note (optional)',
  chooseCurrency: 'Choose settlement currency',
  chooseCurrencyHint: 'Pick which asset the payer will send you',
  request: 'Show code',
  creating: 'Creating…',
  solanaOffline: 'Solana is offline - go online to create a payment request.',
  solAmountUnderFee: fee =>
    `A SOL request must be for more than the network fee (${fee}). The fee is yours - the payer pays what you type.`,
  solFeeLine: (fee, receives) => `Fee ${fee} · you receive ${receives}`,

  receiveInTitle: 'Receive in',
  receiveIn: symbol => `Receive in ${symbol}`,
  switchToRail: symbol => `Switch to the ${symbol} rail`,

  requestPayment: 'Request payment',
  myAddress: 'My address',
  rail: {
    feeLine: (network, fee) => `${network} · Fee ${fee}`,
    feeWithOneTime: (network, fee, oneTime) => `${network} · Fee ${fee} + one-time account rent ${oneTime}`,
    feeUnknown: network => `${network} · Fee unknown`,
  },
  feeNetLine: (fee, net) => `Fee ${fee} · you receive ${net}`,
  feeTooBig: fee => `This amount doesn’t clear the ledger fee (${fee}) - request a larger amount.`,
  showToPayer: nfc =>
    `Show this to the payer${nfc === 'tap' ? ' · or let them tap' : nfc === 'expired' ? ' · NFC tap expired' : ''}`,
  expiredMakeNew: 'Expired - make a new request',
  validForMin: minutes => `Valid for ~${minutes} min`,
  expiresIn: seconds => `Expires in 0:${seconds}`,
  waitingForPayment: online => `Waiting for payment${online ? '…' : ' - reconnect to submit…'}`,
  waitingForSign: 'Waiting for the payer to sign offline…',
  offlineCantSubmit: 'Offline - can’t submit payments until reconnected',
  shareRequestLink: 'Share request link',
  linkUnavailable: 'This asset can’t be named in a payment code. Pick another asset to request a payment.',
  scanPayerSignedCode: "Scan the payer's signed code",
  confirmWithTheirPhone: 'If the payer paid without scanning your code, confirm with their phone.',
  newRequest: 'New request',
  back: 'Back',

  payer: 'payer',
  receivedAmount: amount => `Received ${amount}`,
  fromWho: who => `from ${who}`,
  transactionSignature: 'transaction signature',
  copySignature: 'Copy signature',
  copySignatureA11y: 'Copy transaction signature',
  sharedConfirm: 'Shared ✓',

  receiptMalformed: 'This receipt link is malformed.',
  receiptMismatch: "This receipt doesn't match your open request.",
  receiptUnreadable: "Couldn't read this receipt link.",
  couldNotConfirmYet: 'Couldn’t confirm this payment yet - if the payer paid, it lands with the next balance refresh.',
  unknownLedger: 'Unknown ledger for this asset - couldn’t submit',
  couldNotSubmit: 'Couldn’t submit that payment. Scan it again. If it went through, it shows in your balance.',
  noOpenRequest: 'No open request.',
  paymentRejected: 'Payment rejected.',
  paymentRejectedDetail: 'Payment rejected - the payer may lack balance, or the blockhash expired.',
  couldNotConfirmMaySettle: "Couldn't confirm - the payment may still settle. Check your balance shortly or retry.",
  stillCannotConfirm: "Still can't confirm - the payment may still settle. Try again later.",
  settlementNotVerified: "Confirmed, but the on-chain transaction doesn't match this request. Don't hand over the goods yet - check the signature in a Solana explorer and watch your balance; the payment may still arrive.",
  savedDataCorrupt: 'Saved payment data is corrupt.',
  paymentBeingConfirmed: 'A payment is being confirmed',
  broadcastInterrupted: 'A broadcast was interrupted. The payment may have settled - retry to check.',
  retryBroadcast: 'Retry broadcast',
  broadcasting: 'Broadcasting on Solana - this can take up to a minute.',

  checkout: {
    checkoutCode: 'Also show a checkout code for OpenCryptoPay apps (Binance Pay, MoonPay) - the payer must have the app open',

    openChargeHint: 'Open this charge on your checkout and show the customer a payable code',
    badAmount: reason =>
      reason === 'too-precise'
        ? 'A charge is in whole rappen - enter 10.50, not 10.505.'
        : reason === 'too-large'
        ? 'That total is too large to open. Enter what this customer owes.'
        : 'Enter the total to charge, like 10.50.',

    wrongAssetTitle: 'A checkout code is paid in VCHF',
    wrongAsset: (selected, network) =>
      `A checkout code is always paid in VCHF on the Internet Computer - dpay never swaps. This request is in ${selected}${network ? ` on ${network}` : ''}. Switch to VCHF, or keep the dpay code: any phone camera opens it, and it is paid in ${selected}.`,
    noCheckoutAsset:
      'This wallet has no VCHF, so there is no account for a checkout charge. Use the dpay code instead - any phone camera opens it, and it takes the asset you chose.',
    switchTo: asset => `Switch to ${asset}`,

    failedTitle: 'The charge was not opened',
    notServed: host =>
      `${host} does not serve checkout codes, so nothing was opened. Ask whoever runs that relay to turn the checkout on, or use the dpay code.`,
    unreachable: host =>
      `Your connection is fine, but ${host} isn’t answering, so nothing was opened. Try again in a moment, or use the dpay code (this phone can show it offline).`,
    unreachableOffline: host =>
      `You seem offline, so ${host} couldn’t be reached and nothing was opened. Use the dpay code for now, or try again once you’re back online.`,
    refused: said =>
      `The checkout refused this charge: “${said}” Nothing is payable. Fix that, then open a fresh charge.`,
    refusedNoReason: status =>
      `The checkout refused this charge (HTTP ${status}) without a reason - nothing is payable. Open a fresh charge; if it refuses twice, tell whoever runs the relay.`,
    mispriced: (entered, quoted) =>
      `You entered ${entered}, but the checkout answered ${quoted} - dpay won’t show a code for a number nobody chose. Open a fresh charge; if it happens twice, tell whoever runs the relay before taking money.`,
    servedOther: (served, picked) =>
      `The checkout opened this charge in ${served}, not ${picked} - it does not settle ${picked} yet. Open a fresh charge in ${served}, or ask whoever runs the relay to serve it.`,
    unsigned:
      'This phone could not sign the charge, so nothing is payable. Restart dpay, then open a fresh charge.',
    tryAgain: 'Try again',

    settleOption: (token, currency) => `${token} · ${currency}`,

    settlesAs: (amount, price) =>
      `You receive ${amount} - the ledger fee is yours, so the customer pays ${price}.`,
    collecting: 'Collecting the customer’s approved payment…',
    collectNotApproved:
      'The customer didn’t approve enough, or the approval ran out. Ask them to pay the code again - nothing has been taken.',
    collectNoFunds:
      'The customer approved but lacks the money. Nothing has been taken - ask them to top up and pay again.',
    collectFailed:
      'The approved payment could not be collected, and nothing has been taken. The code is still payable - ask them to scan or tap again.',
    noFeeTitle: 'This checkout cannot price a charge',
    noFee: (symbol, host) =>
      `The shop pays the ledger fee out of the price, but dpay has no fee for ${symbol} - charging it would quietly bill the customer for it. Nothing is payable. Update dpay, or tell whoever runs ${host} that its currency list is missing the ${symbol} fee.`,
    showToCustomer: nfc =>
      nfc === 'tap'
        ? 'Show this to the customer - any phone camera opens it; a dpay phone can tap too.'
        : nfc === 'expired'
        ? 'Show this to the customer - any phone camera opens it. Tapping timed out on this code; open a fresh charge for taps.'
        : 'Show this to the customer - any phone camera opens it and pays.',
    waiting: 'Waiting for the payment…',
    cantCheck:
      'Can’t check this charge - the checkout is out of contact. That does NOT mean it is unpaid. Keep the code up; this screen updates the moment it reconnects.',
    expiredWatching:
      'This code expired, so nobody new can pay it. If the customer paid, the money can still land - watching a little longer.',
    cancel: 'Cancel charge',
    cancelling: 'Cancelling…',
    cancelFailed: said =>
      `The charge was NOT cancelled: “${said}” It may still be payable - decide whether to hand anything over.`,
    cancelFailedNoReason: status =>
      `The charge was NOT cancelled (HTTP ${status}) - treat it as still payable. Try again; hand over nothing until it clears or expires.`,
    cancelUnreachable: host =>
      `Your connection is fine, but ${host} isn’t answering, so this charge was NOT cancelled - it stays payable until it expires. Try again in a moment.`,
    cancelUnreachableOffline: host =>
      `You seem offline, so ${host} couldn’t be reached and this charge was NOT cancelled - it stays payable until it expires. Try again once you’re back online.`,

    endedTitle: reason =>
      reason === 'expired' ? 'This code expired'
      : reason === 'cancelled' ? 'Charge cancelled'
      : reason === 'superseded' ? 'Replaced by a newer charge'
      : 'The checkout no longer has this charge',
    endedBody: reason =>
      reason === 'expired'
        ? 'Nothing arrived for it, and nobody can pay it now. Open a fresh charge to show the customer a new code.'
        : reason === 'cancelled'
        ? 'Nothing is owed on it and nobody can pay it. Open a fresh charge when the next customer is ready.'
        : reason === 'superseded'
        ? 'Another charge was opened on this checkout, so this code no longer takes money. Open a fresh charge to show a new one.'
        : 'The relay no longer has it - most likely it restarted. Nothing was credited. Open a fresh charge; if the customer says they paid, check your VCHF balance and Transactions first.',
    openChargeNext: 'Next customer',

    paidAmount: price => `Paid ${price}`,
    paidBlock: block => `Ledger block ${block}`,
    paidLate: 'This landed after the code expired - accepted, and the money is on the ledger.',
  },
};
