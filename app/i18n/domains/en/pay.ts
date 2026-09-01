/**
 * i18n/domains/en/pay.ts — the Pay + Receive screens: type AND English values, co-located.
 *
 * Covers PayMode, SolPayMode, ReceiveMode, SolReceiveMode, QrScanner and AssetPicker. The two
 * namespaces are composed into `Messages` / `en` by i18n/keys.ts + i18n/en.ts.
 *
 * Conventions (see keys.ts for the full rationale):
 *   • Interpolation is a typed FUNCTION, never a '{{placeholder}}' string, so a locale can move the
 *     value anywhere in the sentence. That includes the *branching* copy — `fundTitle` takes the
 *     action rather than letting the caller splice an English verb into a template, and
 *     `showToPayer` takes the NFC state rather than concatenating an English suffix.
 *   • Money is formatted by fmtCurrencyAmount/fmtAsset at the call site and passed in ALREADY
 *     FORMATTED. This catalog never formats numbers.
 *   • A few strings are read across the two namespaces (ReceiveMode reads `M.pay.notAPaymentCode`,
 *     SolReceiveMode reads `M.pay.createUsdcAccount`). That is deliberate: the sentence is the same
 *     fact on both screens, and one copy is the point. Same reason PayMode reads `M.nfc.paidAmount`.
 */

export type PayMessages = {
  // --- decode + expiry refusals -------------------------------------------------------------
  /** Also used by ReceiveMode when the merchant scans something that isn't a signed dpay envelope. */
  notAPaymentCode: string;
  requestExpired: string;
  solRequestExpired: string;

  // --- the outcome (paid) screen ------------------------------------------------------------
  /** Pending hand-off headline. `amount` is null when an NFC pay left no decoded request behind. */
  sent: (amount: string | null) => string;
  alreadyPaid: string;
  toWho: (who: string) => string;
  toWhoAwaiting: (who: string) => string;
  alreadyNotCharged: (amount: string, who: string) => string;
  /** SOL twin of toWhoAwaiting; `who` is null when the payment arrived over NFC (no request state). */
  solAwaiting: (who: string | null) => string;
  balanceUpdatesOnSettle: string;
  newPayment: string;

  // --- share affordances --------------------------------------------------------------------
  shareReceipt: string;
  shareReceiptHint: string;
  shareAuthCode: string;
  shareSignedPayment: string;
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
  reviewPayment: string;
  paying: string;
  payAmount: (amount: string) => string;
  notEnoughBalance: string;
  localBalanceMayNotCover: string;
  approve: string;
  approveA11y: string;
  approveHint: string;
  signing: string;
  signsOffline: string;
  /** Review of a payment that arrived as a shared LINK: the payee name came out of a URL and is
   *  unverified, so the account shown above it is the part the payer can actually check. */
  linkNameClaimed: string;

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

  // --- an OpenCryptoPay merchant till -------------------------------------------------------
  // A static till QR resolves to a live quote at a provider dpay does not control, so every string
  // here is either a refusal or an honesty marker. Two rules shape the copy:
  //   • Nothing the provider sends is verified by dpay — the merchant name is CLAIMED and the host
  //     the quote came from is shown, so "why does this say another company's name" is answerable.
  //   • The payer moves irreversible funds BEFORE the provider is told, and gets exactly one chance
  //     to tell it (docs/specs/2026-09-01-opencryptopay-findings.md, "The loss path"). So the
  //     post-transfer keys must say neither "paid" nor "failed", and must hand the payer the
  //     transfer's reference — it is the only thing that ties their money to this sale.
  ocp: {
    solanaUsdcUnsupported: string;
    assetNotAccepted: (selected: string, accepted: string) => string;
    /** The till DOES take the selected asset, but its provider says it cannot settle that method
     *  right now. `alternatives` is null when nothing else the till takes is payable here — there
     *  is then no "switch in Balances" to point at, so the branch must not pretend there is. */
    methodUnavailable: (selected: string, alternatives: string | null) => string;
    /** The till takes nothing this wallet can pay — a true dead end for dpay, said plainly. */
    noPayableAsset: (accepted: string) => string;
    quoteExpired: string;
    /** Shown while the two provider reads are in flight — up to half a minute of nothing, on a
     *  screen the payer just pointed at a QR code. */
    checkingTill: string;
    badCode: string;
    notHttps: string;
    providerUnreachable: string;
    /** The provider answered the payment step with something dpay will not sign: a destination on
     *  another ledger, an unreadable address, or an amount that is not the one quoted. Nothing has
     *  moved — this is a refusal BEFORE the money, and a red flag worth naming as one. */
    badDestination: (host: string) => string;
    noPendingCharge: (merchant: string) => string;
    /** How each rail names the proof of a transfer, composed into the two keys below (the
     *  `link.part` pattern) so one sentence serves both rails without either being described in
     *  the other's vocabulary. */
    ref: {icBlock: (index: string) => string; solTransaction: (signature: string) => string};
    /** Funds moved; the provider never answered. Honest unknown — never rendered as paid or failed. */
    submitUnknown: (reference: string) => string;
    /** Funds moved; the provider refused the proof. Definitive, and still costs the payer. */
    submitRejected: (reference: string) => string;
    /** The TRANSFER's own outcome is unknown, so the provider was never told (calling it once is
     *  all we get — see the findings doc's loss path). Neither paid nor failed, and no reference
     *  exists to hand over yet. */
    transferUnknown: string;
    claimedMerchant: string;
    providerHost: (host: string) => string;
  };

  // --- the fund-first gate ------------------------------------------------------------------
  /** Stand-in noun when the selected asset has no display name yet ("Add funds to pay"). */
  fundsSymbol: string;
  fundTitle: (symbol: string, action: 'pay' | 'send') => string;
  fundBody: (symbol: string, action: 'pay' | 'send') => string;
  fundBodyNoDeposits: (symbol: string) => string;
  fundBodyUsdc: string;
  showMyAddress: (symbol: string) => string;
  /** Also used by SolReceiveMode's inline ATA setup card. */
  createUsdcAccount: string;

  // --- send-to-address needs a connection; scan-to-pay does not ------------------------------
  /** Shown in place of the send form while the wallet is offline. A send goes straight to the
   *  ledger with no counterparty to carry it, so it is the ONE Pay-tab action airplane mode
   *  genuinely blocks — and the payer's way out is the rail that was built for exactly this. */
  offlineSendTitle: string;
  offlineSendBody: (symbol: string) => string;
  /** A scanned wallet address for an asset that cannot leave the wallet to an address at all. */
  scannedAddressNotSendable: (symbol: string) => string;

  // --- the scan surface + its NFC status row ------------------------------------------------
  scanToPay: string;
  sendToAddress: string;
  tapOrScanToPay: string;
  scanQrToPay: string;
  solScanHint: string;
  payNow: string;
  payNowA11y: string;
  payNowHint: string;
  nfcNotAvailable: string;
  whyNfcUnavailable: string;
  nfcUnavailableTitle: string;
  close: string;

  // --- the camera scanner (QrScanner) --------------------------------------------------------
  noCameraFound: string;
  pointCamera: string;
  cameraPrivacy: string;
  allowCameraScan: string;
  allowCameraScanHint: string;
};

export const payEn: PayMessages = {
  notAPaymentCode: "This isn't a dpay payment code",
  requestExpired: 'This request expired — ask the merchant for a fresh QR',
  solRequestExpired: 'This payment request has expired. Ask the merchant for a fresh QR.',

  sent: amount => (amount ? `Sent ${amount}` : 'Sent'),
  alreadyPaid: 'Already paid',
  toWho: who => `to ${who}`,
  toWhoAwaiting: who => `to ${who} · awaiting the merchant’s confirmation`,
  alreadyNotCharged: (amount, who) => `${amount} to ${who} · not charged again`,
  solAwaiting: who =>
    who ? `to ${who} · awaiting the merchant's confirmation` : "awaiting the merchant's confirmation",
  balanceUpdatesOnSettle: 'Your balance updates when the merchant settles this on-chain.',
  newPayment: 'New payment',

  shareReceipt: 'Share receipt',
  shareReceiptHint: 'Share the payment proof as a link the merchant can open to confirm',
  shareAuthCode: 'Share auth code',
  shareSignedPayment: 'Share signed payment',
  shareSignedCode: 'Share signed code',
  linkCopied: 'Link copied ✓',
  copied: 'Copied ✓',

  showThisTo: who => `Show this to ${who}`,
  showThisToMerchant: 'Show this to the merchant',
  amountToWho: (amount, who) => `${amount} to ${who}`,
  signedOnThisDevice: 'signed on this device ✓',
  signedOffline: 'signed offline ✓',
  waitingToScan: who => `Waiting for ${who} to scan…`,
  offlineSettles: who =>
    `Offline — ${who} settles this when they submit it. You’ll see it on your balance once you’re back online.`,
  solOfflineSettles:
    "Offline — the merchant settles this when they submit it. You'll see it on your balance once it's confirmed.",
  handedTo: who => `Handed to ${who}`,
  handedToMerchant: 'Handed to merchant',
  handedOffHint: 'Mark the signed payment as handed off; your balance updates when the merchant settles',

  unsupportedAsset: 'Unsupported asset',
  unsupportedAssetBody: currency =>
    `This payment requests an asset this wallet can’t pay (currency ${currency}). dpay never swaps, so there’s no fallback. Ask the merchant to request a supported asset.`,
  reviewPayment: 'Review payment',
  paying: 'Paying',
  payAmount: amount => `Pay ${amount}`,
  notEnoughBalance: 'Not enough balance to cover this payment.',
  localBalanceMayNotCover: 'Your local balance may not cover this — the merchant will verify.',
  approve: 'Approve',
  approveA11y: 'Approve payment',
  approveHint: 'Sign the displayed amount with your key and send it',
  signing: 'Signing…',
  signsOffline: 'This signs offline — the merchant settles when they submit it.',
  linkNameClaimed: 'Name given by the sender — check the account above.',

  link: {
    title: 'This payment link can’t be paid',
    part: {recipient: 'the account to pay', asset: 'the asset', network: 'the network', amount: 'the amount', ref: 'the reference'},
    malformed: part => `The link is missing or has a damaged value for ${part}. Ask the sender to send you a new link.`,
    unknownAsset: (token, network) =>
      `The link asks for ${token} on ${network}. This wallet has no such asset, and dpay never swaps, so it can’t pay it with anything else. Ask the sender for a link in an asset you hold.`,
    wrongNetwork: (token, network) =>
      `The link asks for ${token} on ${network}. You hold ${token} on a different network — that is a different asset, and paying it would send your money to the wrong chain. Ask the sender for a link on a network you hold.`,
    hiddenAsset: token =>
      `The link asks for ${token}, a test-network asset. Open Balances, turn on “Show testnet assets”, then open the link again.`,
    unsupportedAsset: token =>
      `The link asks for ${token}, which this wallet can’t pay. dpay never swaps, so there’s no fallback. Ask the sender for a link in an asset you hold.`,
    badAmount: (amount, token) =>
      `“${amount}” isn’t a valid ${token} amount — it may have more decimal places than ${token} has. Ask the sender for a new link.`,
    badAccount: network =>
      `The account in this link isn’t a valid ${network} account. Ask the sender to check it and send the link again.`,
  },

  ocp: {
    solanaUsdcUnsupported:
      'This till takes USDC on Solana, but its code doesn’t say which token account to send to — paying it would risk sending real money to the wrong account. Pay with SOL instead, or switch in Balances to another asset this till takes.',
    assetNotAccepted: (selected, accepted) =>
      `This till doesn’t take ${selected}. It takes ${accepted}. dpay never swaps, so switch to one of those in Balances and scan again.`,
    methodUnavailable: (selected, alternatives) =>
      alternatives
        ? `This till takes ${selected}, but the merchant’s payment provider can’t process ${selected} right now. The till also takes ${alternatives}. dpay never swaps, so switch to one of those in Balances and scan again.`
        : `This till takes ${selected}, but the merchant’s payment provider can’t process ${selected} right now — and nothing else this till takes can be paid from this wallet. Ask the merchant for another way to pay.`,
    noPayableAsset: accepted =>
      `dpay can’t pay this till. It takes ${accepted} — none of which this wallet can pay, and dpay never swaps. Pay this one another way.`,
    quoteExpired:
      'This till’s price has expired — each one lasts about five minutes. Scan the code again for a fresh price.',
    checkingTill: 'Checking with the merchant’s payment provider…',
    badCode:
      'This code is damaged, or it isn’t a payment code. Ask the merchant to show it again, and check that nothing is covering it.',
    notHttps:
      'This code points to an insecure address, so dpay won’t open it. Ask the merchant to show their own payment code — a sticker placed over the real one looks exactly like this.',
    providerUnreachable:
      'Couldn’t reach the merchant’s payment provider. Nothing has been paid. Check your connection and scan again.',
    badDestination: host =>
      `${host} answered with a payment address that doesn’t match what you chose, so dpay stopped. Nothing has been paid — don’t pay this code. Ask the merchant to show their own code again.`,
    noPendingCharge: merchant =>
      `${merchant}’s till has no charge waiting. Ask the cashier to ring up the sale first, then scan the code again.`,
    ref: {
      icBlock: index => `ledger block ${index}`,
      solTransaction: signature => `Solana transaction ${signature}`,
    },
    submitUnknown: reference =>
      `Your transfer went through, but the merchant’s payment provider didn’t confirm it — so this is neither paid nor failed. The money has left your wallet, so don’t pay again. Show the merchant ${reference}: it is the proof of your transfer.`,
    submitRejected: reference =>
      `Your transfer went through, but the merchant’s payment provider refused the proof of it, so the sale wasn’t credited. The money has left your wallet, so don’t pay again. Contact the merchant and give them ${reference}.`,
    transferUnknown:
      'dpay couldn’t confirm your transfer, so the merchant hasn’t been told about it — this is neither paid nor failed. Don’t pay again: open Transactions to see whether it went through, and show the merchant that payment if it did.',
    claimedMerchant: 'Name given by the code — dpay doesn’t verify it.',
    providerHost: host => `Price from ${host}`,
  },

  fundsSymbol: 'funds',
  fundTitle: (symbol, action) => `Add ${symbol} to ${action}`,
  fundBody: (symbol, action) =>
    `This wallet has no ${symbol} yet. Send ${symbol} to your address and you can ${action} right away.`,
  fundBodyNoDeposits: symbol =>
    `This wallet has no ${symbol} yet — and ${symbol} isn't available for deposits yet. Fund another asset, or check back soon.`,
  fundBodyUsdc: 'Send USDC (Solana) to your USDC address. Keep a little SOL in the wallet for network fees.',
  showMyAddress: symbol => `Show my ${symbol} address`,
  createUsdcAccount: 'Create my USDC account',

  offlineSendTitle: 'Sending to an address needs a connection',
  offlineSendBody: symbol =>
    `Your phone submits an address send itself, so it has to be online. To pay while you're offline, scan the merchant's payment code instead — their phone submits your ${symbol} payment for you.`,
  scannedAddressNotSendable: symbol =>
    `That's a wallet address. ${symbol} can't be sent to an address — scan the merchant's payment code to pay.`,

  scanToPay: 'Scan to pay',
  sendToAddress: 'Send to address',
  tapOrScanToPay: 'Tap or scan to pay',
  scanQrToPay: 'Scan the QR code to pay.',
  solScanHint: "Scan the merchant's payment code to pay offline.",
  payNow: 'Pay Now',
  payNowA11y: 'Pay now',
  payNowHint: 'Turn on the camera and tap-to-pay so you can pay a merchant',
  nfcNotAvailable: 'NFC not available',
  whyNfcUnavailable: 'Why NFC is unavailable',
  nfcUnavailableTitle: 'NFC unavailable',
  close: 'Close',

  noCameraFound: 'No camera found on this device.',
  pointCamera: 'Point your camera at a payment code to pay',
  cameraPrivacy: 'dpay uses your camera only to scan codes — never records or uploads.',
  allowCameraScan: 'Allow camera scan',
  allowCameraScanHint: 'Permission to use your camera so you can scan payment codes',
};

export type ReceiveMessages = {
  // --- the request form ----------------------------------------------------------------------
  amountToReceive: string;
  amountHint: string;
  amountPlaceholder: string;
  solAmountPlaceholder: string;
  memo: string;
  memoHint: string;
  memoPlaceholder: string;
  chooseCurrency: string;
  chooseCurrencyHint: string;
  chooseAssetHint: string;
  request: string;
  requestHint: string;
  creating: string;
  creatingRequest: string;
  solanaOffline: string;

  // --- the asset picker ----------------------------------------------------------------------
  receiveInTitle: string;
  receiveIn: (symbol: string) => string;
  switchToRail: (symbol: string) => string;

  // --- the request QR screen -----------------------------------------------------------------
  requestPayment: string;
  myAddress: string;
  /** 'tap' = the payer may tap instead; 'expired' = the short NFC request lapsed; 'none' = QR only. */
  showToPayer: (nfc: 'tap' | 'expired' | 'none') => string;
  expiredMakeNew: string;
  validForMin: (minutes: number) => string;
  /** `seconds` is already zero-padded by the caller — this catalog never formats numbers. */
  expiresIn: (seconds: string) => string;
  waitingForPayment: (online: boolean) => string;
  waitingForSign: string;
  offlineCantSubmit: string;
  shareRequestLink: string;
  shareRequestHint: string;
  scanPayerSignedQr: string;
  scanPayerSignedQrPrompt: string;
  scanPayerSignedQrHint: string;
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
  couldNotSubmit: string;
  noOpenRequest: string;
  paymentRejected: string;
  paymentRejectedDetail: string;
  couldNotConfirmMaySettle: string;
  stillCannotConfirm: string;
  savedDataCorrupt: string;
  paymentBeingConfirmed: string;
  broadcastInterrupted: string;
  retryBroadcast: string;
  broadcasting: string;
};

export const receiveEn: ReceiveMessages = {
  amountToReceive: 'Amount to receive',
  amountHint: 'The amount the payer will send you',
  amountPlaceholder: '0.00',
  solAmountPlaceholder: '0.025',
  memo: 'Memo',
  memoHint: 'An optional note attached to this payment request',
  memoPlaceholder: 'Add a note (optional)',
  chooseCurrency: 'Choose settlement currency',
  chooseCurrencyHint: 'Pick which asset the payer will send you',
  chooseAssetHint: 'Choose which asset the payer will send you',
  request: 'Request',
  requestHint: 'Show your QR code so the payer can scan it to pay you',
  creating: 'Creating…',
  creatingRequest: 'Creating request…',
  solanaOffline: 'Solana is offline — go online to create a payment request.',

  receiveInTitle: 'Receive in',
  receiveIn: symbol => `Receive in ${symbol}`,
  switchToRail: symbol => `Switch to the ${symbol} rail`,

  requestPayment: 'Request payment',
  myAddress: 'My address',
  showToPayer: nfc =>
    `Show this to the payer${nfc === 'tap' ? ' · or let them tap' : nfc === 'expired' ? ' · NFC tap expired' : ''}`,
  expiredMakeNew: 'Expired — make a new request',
  validForMin: minutes => `Valid for ~${minutes} min`,
  expiresIn: seconds => `Expires in 0:${seconds}`,
  waitingForPayment: online => `Waiting for payment${online ? '…' : ' — reconnect to submit…'}`,
  waitingForSign: 'Waiting for the payer to sign offline…',
  offlineCantSubmit: 'Offline — can’t submit payments until reconnected',
  shareRequestLink: 'Share request link',
  shareRequestHint: 'Share this request as a link the payer can open to pay',
  scanPayerSignedQr: "Scan payer's signed QR",
  scanPayerSignedQrPrompt: "Scan the payer's signed QR",
  scanPayerSignedQrHint: "Scan the payer's signed QR to submit their offline payment",
  scanPayerSignedCode: "Scan the payer's signed code",
  confirmWithTheirPhone: 'If the payer paid without scanning your code, tap here to confirm with their phone.',
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
  couldNotConfirmYet: 'Couldn’t confirm this payment yet — if the payer paid, it lands with the next balance refresh.',
  unknownLedger: 'Unknown ledger for this asset — couldn’t submit',
  couldNotSubmit: "Couldn't submit the payment — check the connection",
  noOpenRequest: 'No open request.',
  paymentRejected: 'Payment rejected.',
  paymentRejectedDetail: 'Payment rejected — the payer may have insufficient balance or the blockhash expired.',
  couldNotConfirmMaySettle: "Couldn't confirm — the payment may still settle. Check your balance shortly or retry.",
  stillCannotConfirm: "Still can't confirm — the payment may still settle. Try again later.",
  savedDataCorrupt: 'Saved payment data is corrupt.',
  paymentBeingConfirmed: 'A payment is being confirmed',
  broadcastInterrupted: 'A broadcast was interrupted. The payment may have settled — retry to check.',
  retryBroadcast: 'Retry broadcast',
  broadcasting: 'Broadcasting on Solana — this can take up to a minute.',
};
