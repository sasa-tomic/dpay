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

  fundsSymbol: 'funds',
  fundTitle: (symbol, action) => `Add ${symbol} to ${action}`,
  fundBody: (symbol, action) =>
    `This wallet has no ${symbol} yet. Send ${symbol} to your address and you can ${action} right away.`,
  fundBodyNoDeposits: symbol =>
    `This wallet has no ${symbol} yet — and ${symbol} isn't available for deposits yet. Fund another asset, or check back soon.`,
  fundBodyUsdc: 'Send USDC (Solana) to your USDC address. Keep a little SOL in the wallet for network fees.',
  showMyAddress: symbol => `Show my ${symbol} address`,
  createUsdcAccount: 'Create my USDC account',

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
