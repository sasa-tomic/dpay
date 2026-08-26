/**
 * i18n/domains/en/deposit.ts — the copy for the two on-chain money-movement surfaces: DEPOSIT ("Add
 * money" — the Receive tab's *My address* sub-mode) and WITHDRAW ("Cash out" — the Pay tab's *Send
 * to address* sub-mode). Both the type and the English values live here, side by side, so a new key
 * is one edit in one file.
 *
 * Shape rules are inherited from ../keys.ts — read that first. In particular: interpolation is a
 * typed FUNCTION (never a '{{placeholder}}' string), and there is no pluralization machinery.
 *
 * MONEY IS FORMATTED BY THE CALLER. Every `amount`/`fee`/`min`/`cost` argument below is an
 * ALREADY-FORMATTED display string (`fmtAsset(...)`) — the catalog only decides the sentence around
 * it. Number/locale formatting belongs to lib/format.ts, not here.
 */

/**
 * One run of an instruction line. `em` marks the asset or network NAME the sentence is about — the
 * one word rendered in the emphasis style (components/InstrLine). A line is a list of runs rather
 * than a plain string so a locale can move the name anywhere its grammar wants it AND keep the
 * emphasis; splitting the sentence into prefix/suffix keys would freeze English word order.
 */
export type InstrRun = {t: string; em?: boolean};

/**
 * Copy that is word-for-word identical on the deposit and the withdraw sheets (they share the copy
 * button, the amount field and the Esc hint). Defined once, referenced by both English objects, so
 * an English edit can never land on one surface and miss the other. Each locale still translates
 * the two domains independently — this is a source-of-truth device, not a locale fallback.
 */
const bothSheets = {
  pressEsc: 'Press Esc to close',
  balanceAuto: 'Your balance updates automatically.',
  copied: 'Copied ✓',
  shared: 'Shared ✓',
  copyAddress: 'Copy address',
  amountLabel: (asset: string) => `Amount (${asset})`,
};

export type DepositMessages = {
  /** Shared with the withdraw sheets — see `bothSheets`. */
  pressEsc: string;
  balanceAuto: string;
  copied: string;
  shared: string;
  copyAddress: string;
  amountLabel: (asset: string) => string;

  /** Terminal title on BOTH deposit rails (native-address mint and wallet-signed onramp). */
  deposited: string;
  /** The copy button speaks its own state to a screen reader (clipboard on web, Share on native). */
  addressCopied: string;
  addressShared: string;
  /** Nudge the balance/mint recheck instead of waiting out the poll interval. */
  checkNow: string;

  /** ck-minter rail (DepositSheet): one real native address, watched for the mint. */
  ck: {
    /** The address couldn't be loaded — transient (network/timeout/gateway). Carries its own retry hint. */
    addressErr: string;
    /** No minter is registered for this asset, so there is no deposit rail at all. Not retryable. */
    noMinter: string;
    fetchingAddress: string;
    noAddress: string;
    sendToAddress: (nativeAsset: string, networkLabel: string) => InstrRun[];
    /**
     * "~2 confirmations · typically ~20 min" as ONE line, so a locale can reorder the two facts or
     * drop the tail. `required` is a count: English appends the plural s; every other locale decides
     * in its own rules (see the no-plural-machinery note in ../keys.ts).
     */
    confirmationLine: (required: number, estMin: number) => string;
    feeMinLine: (fee: string, min: string) => string;
    /** Words that stand in for a ZERO fee / minimum — a money screen never shows "0.00000000 BTC". */
    feeNone: string;
    minNone: string;
    custody: string;
    copyDepositAddress: string;
    statusTitle: string;
    watching: string;
    checkingEvery: (seconds: number) => string;
    checkNowLabel: string;
    mintedAmount: (amount: string) => string;
  };

  /** ckETH / ckERC20 rail (CkErc20DepositSheet): the user's OWN Ethereum wallet signs the deposit. */
  erc20: {
    onrampParamsErr: string;
    deriveErr: string;
    noWalletWeb: string;
    noWalletNative: string;
    pairRejected: string;
    pairFailed: string;
    wrongNetwork: (networkLabel: string, expected: number, actual: number) => string;
    connectFailed: string;
    noWalletApp: string;
    walletDisconnected: string;
    amountRequired: string;
    missingErc20Address: string;
    txReverted: string;
    txUnconfirmed: string;
    txNotSigned: string;
    txFailed: string;
    sendOnly: (nativeAsset: string, networkLabel: string) => InstrRun[];
    custody: string;
    /** Who pays gas: native ETH comes out of the sent amount; an ERC-20 needs ETH held separately. */
    gasNative: string;
    gasErc20: string;
    scanToPair: string;
    openWalletHint: string;
    openWallet: string;
    walletListPair: string;
    walletList: string;
    /** Why this rail asks for a wallet instead of showing an address. */
    explainNative: string;
    explainErc20: (nativeAsset: string) => string;
    connectLabel: string;
    connect: string;
    amountPlaceholder: string;
    /** The connected Ethereum account, already shortened by the caller. */
    fromAccount: (shortAccount: string) => string;
    confirmingLabel: string;
    /** One word for both the button and its a11y label — the native-ETH single-tx path. */
    deposit: string;
    /** The ERC-20 path is two txs: the label spells "and" out loud, the button uses "&". */
    approveDepositLabel: string;
    approveDeposit: string;
    confirming: string;
    depositingAmount: (amount: string, asset: string) => string;
    /** Resumed after a restart: honest that the wallet is gone but the watch is not. */
    watchingResumed: string;
    watchingFresh: string;
    startNew: string;
    mintedToWallet: (asset: string) => string;
  };

  /** Native Solana rail (SolanaReceiveSheet): the device key IS the account. */
  sol: {
    createAtaLabel: string;
    checkingAta: string;
    /** Fail-closed, never a false claim: the account could not be CHECKED, so nothing is asserted. */
    ataUnverified: string;
    ataUnverifiedDetail: string;
    retryAtaLabel: string;
    retryAtaHint: string;
    checkAgain: string;
    backToRequest: string;
    sendToAddress: (asset: string, network: string) => InstrRun[];
    custody: (asset: string) => string;
    /** Also rendered by the token-account setup card below. */
    devnetWarn: (asset: string) => string;
    waitingDeposit: string;
    checkNowHint: string;
    balanceAutoOnConfirm: string;
    copyAssetAddress: (asset: string) => string;
    returnHint: string;
  };

  /** The one-tap USDC token-account setup card (SolanaAtaSetupCard), shared by receive AND send. */
  ata: {
    absent: string;
    /** The one-time rent + fee is DISCLOSED before the tap — no silent cost on a money screen. */
    cost: (setupCost: string) => string;
    checkingSol: string;
    needSol: (setupCost: string) => string;
    showSolAddress: string;
    creating: string;
    createHint: (setupCost: string) => string;
  };

  /** One-tap funding from Trust Wallet (Android only). */
  trust: {
    fund: string;
    fundHint: (asset: string) => string;
    err: string;
  };
};

export const depositEn: DepositMessages = {
  ...bothSheets,

  deposited: 'Deposited ✓',
  addressCopied: 'Address copied',
  addressShared: 'Address shared',
  checkNow: 'Check now',

  ck: {
    addressErr: "Couldn't load your deposit address. Check your connection and try again.",
    noMinter: "This asset isn't available for deposits yet.",
    fetchingAddress: 'Fetching your deposit address…',
    noAddress: 'No deposit address available.',
    sendToAddress: (nativeAsset, networkLabel) => [
      {t: 'Send '},
      {t: nativeAsset, em: true},
      {t: ' to your '},
      {t: networkLabel, em: true},
      {t: ' address below.'},
    ],
    confirmationLine: (required, estMin) =>
      `${required > 0 ? `~${required} confirmation${required === 1 ? '' : 's'}` : 'confirmations'}${estMin > 0 ? ` · typically ~${estMin} min` : ''}`,
    feeMinLine: (fee, min) => `Network fee ${fee} · Min deposit ${min}`,
    feeNone: 'none',
    minNone: 'no minimum',
    custody: 'dpay never holds your keys — funds mint 1:1 to your wallet on confirmation.',
    copyDepositAddress: 'Copy deposit address',
    statusTitle: 'Status',
    watching: 'Watching for your deposit',
    checkingEvery: seconds => `checking every ${seconds}s`,
    checkNowLabel: 'Check deposit status now',
    mintedAmount: amount => `${amount} minted`,
  },

  erc20: {
    onrampParamsErr: "Couldn't reach the server for onramp details.",
    deriveErr: "Couldn't derive your deposit address — try reopening the sheet.",
    noWalletWeb: 'No Ethereum wallet found. Install MetaMask or Rabby in this browser.',
    noWalletNative: 'No wallet connected. Pair a wallet via WalletConnect.',
    pairRejected: 'Pairing not approved.',
    pairFailed: 'Could not pair with your wallet.',
    wrongNetwork: (networkLabel, expected, actual) =>
      `Wrong network: connect to ${networkLabel} (chain ${expected}). Your wallet is on chain ${actual}.`,
    connectFailed: 'Could not connect to your wallet.',
    noWalletApp: 'No wallet app found. Scan the QR with a wallet on another device instead.',
    walletDisconnected: 'Wallet disconnected.',
    amountRequired: 'Enter an amount greater than zero.',
    missingErc20Address: 'Onramp details missing the ERC-20 address.',
    txReverted: 'Transaction reverted on chain.',
    txUnconfirmed: 'Transaction sent but not yet confirmed — still watching for the mint.',
    txNotSigned: 'Transaction not signed.',
    txFailed: 'Transaction failed.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Send only '},
      {t: nativeAsset, em: true},
      {t: ' on '},
      {t: networkLabel, em: true},
      {t: ". Other assets or chains sent this way won't credit and may be lost."},
    ],
    custody:
      'dpay never holds your keys — your wallet signs, and the chain-key asset mints 1:1 to your wallet on confirmation (~20 min).',
    gasNative: 'The network fee is paid in ETH — send a little more than you want to deposit.',
    gasErc20: "You'll need a small amount of ETH for Ethereum network gas fees.",
    scanToPair: 'Scan with your wallet to pair',
    openWalletHint: 'Open an installed wallet app on this device',
    openWallet: 'Open wallet on this device',
    walletListPair: 'MetaMask · Trust · Rabby · any WalletConnect wallet',
    walletList: 'MetaMask · Trust · Rabby · any WalletConnect-compatible wallet',
    explainNative:
      'Send ETH directly to the deposit contract — one transaction your wallet signs, with your deposit amount as the ETH value.',
    explainErc20: nativeAsset =>
      `${nativeAsset} is an Ethereum token — depositing it needs two transactions your wallet signs, not a send-to-address like Bitcoin.`,
    connectLabel: 'Connect Ethereum wallet',
    connect: 'Connect wallet',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `From ${shortAccount}`,
    confirmingLabel: 'Confirming in your wallet',
    deposit: 'Deposit',
    approveDepositLabel: 'Approve and deposit',
    approveDeposit: 'Approve & deposit',
    confirming: 'Confirm in your wallet…',
    depositingAmount: (amount, asset) => `Depositing ${amount} ${asset}`,
    watchingResumed:
      'Deposit pending (~20 min) — your wallet isn’t connected, but we’re still watching for the mint.',
    watchingFresh: 'Waiting for confirmation — your deposit will appear in about 20 minutes.',
    startNew: 'Start a new deposit',
    mintedToWallet: asset => `${asset} minted to your wallet.`,
  },

  sol: {
    createAtaLabel: 'Create USDC account',
    checkingAta: 'Checking your USDC account…',
    ataUnverified: "Couldn't check your USDC account.",
    ataUnverifiedDetail:
      "Your address is fine — we just can't reach Solana right now to confirm your USDC account on-chain. Check your connection and try again.",
    retryAtaLabel: 'Retry checking USDC account',
    retryAtaHint: 'Re-check whether your USDC account exists on-chain',
    checkAgain: 'Check again',
    backToRequest: 'Back to request',
    sendToAddress: (asset, network) => [
      {t: 'Send '},
      {t: asset, em: true},
      {t: ' to your '},
      {t: network},
      {t: ' address below.'},
    ],
    custody: asset => `dpay never holds your keys — ${asset} lands directly in your wallet on confirmation.`,
    devnetWarn: asset =>
      `Connected to Solana devnet. Do NOT send mainnet ${asset} here — it will not appear. Use devnet ${asset} only.`,
    waitingDeposit: 'Waiting for your deposit · checks every few seconds',
    checkNowHint: 'Re-check your balance right now',
    balanceAutoOnConfirm: 'Your balance updates automatically once the send confirms.',
    copyAssetAddress: asset => `Copy ${asset} address`,
    returnHint: 'Go back to the Pay tab with this asset selected',
  },

  ata: {
    absent: "You don't have a USDC account on this device yet.",
    cost: setupCost =>
      `Solana keeps your USDC in a one-time token account tied to this wallet. Creating it costs ${setupCost} (account rent + fee) from your SOL balance — it stays your account, on your keys. dpay never holds them.`,
    checkingSol: 'Checking your SOL balance…',
    needSol: setupCost =>
      `You need about ${setupCost} in this wallet first — receive SOL at your address, then create the account.`,
    showSolAddress: 'Show my SOL address',
    creating: 'Creating your USDC account — confirming on Solana…',
    createHint: setupCost => `Create your one-time USDC account for ${setupCost} from your SOL balance`,
  },

  trust: {
    fund: 'Fund from Trust Wallet',
    fundHint: asset => `Opens Trust Wallet to send ${asset} to your dpay address`,
    err: "Couldn't open Trust Wallet. Try again.",
  },
};

export type WithdrawMessages = {
  /** Shared with the deposit sheets — see `bothSheets`. */
  pressEsc: string;
  balanceAuto: string;
  copied: string;
  shared: string;
  copyAddress: string;
  amountLabel: (asset: string) => string;

  /** Form validation + review copy, identical on the IC and the Solana send sheets. */
  overBalance: (available: string) => string;
  badAddress: (asset: string) => string;
  toDestination: (destination: string) => string;
  enterAmount: string;

  /** IC user-principal rail (WithdrawSheet): ckBTC → BTC, ckETH → ETH, ckERC20 → the token. */
  ic: {
    /**
     * The three honest failure states. `approvalUnknown` / `withdrawalUnknown` are THROWN by the
     * submit loop and rendered verbatim — an unconfirmed step is pending, never a decline.
     */
    resumed: string;
    approvalUnknown: string;
    withdrawalUnknown: string;
    noRail: string;
    gasFeeErr: string;
    withdrawn: string;
    sentTo: string;
    copyDestinationLabel: string;
    withdrawing: (amount: string) => string;
    sendToNative: (networkLabel: string, nativeAsset: string) => string;
    availableMin: (available: string, min: string) => string;
    addressLabel: (asset: string) => string;
    useLastLabel: string;
    /** The remembered destination, already truncated by the caller. */
    useLast: (address: string) => string;
    amountPlaceholder: string;
    belowMin: (min: string) => string;
    /** ckERC20 burns ckETH for gas — dpay never swaps, so the user must hold it (Fork-C). */
    gasNote: string;
    inProgress: string;
    withdrawAmount: (amount: string) => string;
    resumeNote: string;
    reviewTitle: string;
    confirmLabel: string;
    retry: string;
  };

  /** Native Solana rail (SolanaWithdrawSheet): the device key signs and broadcasts directly. */
  sol: {
    createAtaLabel: string;
    backToScan: string;
    sent: string;
    txSignature: string;
    copySignatureLabel: string;
    copySignature: string;
    sending: (amount: string) => string;
    confirmingOnSolana: string;
    sendToSolana: (asset: string) => string;
    available: (available: string) => string;
    addressLabel: string;
    addressPlaceholder: string;
    usdcAmountPlaceholder: string;
    solAmountPlaceholder: string;
    /** Fees (and a possible recipient-account creation) are paid in SOL — said BEFORE the amount. */
    needsSol: string;
    reviewTitle: string;
    sendAmount: (amount: string) => string;
    recipientAtaNote: (cost: string) => string;
    confirmLabel: (asset: string) => string;
  };
};

export const withdrawEn: WithdrawMessages = {
  ...bothSheets,

  overBalance: available => `More than your available ${available}.`,
  badAddress: asset => `That doesn't look like a valid ${asset} address.`,
  toDestination: destination => `to ${destination}`,
  enterAmount: 'Enter an amount',

  ic: {
    resumed:
      'A withdrawal was in progress when the app closed. Retry re-sends the same envelopes — it cannot double-spend.',
    approvalUnknown: "Couldn't confirm the approval — check your balance when back online",
    withdrawalUnknown: "Couldn't confirm the withdrawal — it may still land; check your balance soon",
    noRail: 'This asset has no withdrawal rail configured',
    gasFeeErr: "Couldn't fetch the live gas fee — check your connection",
    withdrawn: 'Withdrawn ✓',
    sentTo: 'sent to',
    copyDestinationLabel: 'Copy destination address',
    withdrawing: amount => `Withdrawing ${amount}…`,
    sendToNative: (networkLabel, nativeAsset) => `Send your ${networkLabel} to a native ${nativeAsset} address`,
    availableMin: (available, min) => `Available: ${available} · min ${min}`,
    addressLabel: asset => `${asset} address`,
    useLastLabel: 'Use last saved address',
    useLast: address => `Use last: ${address}`,
    amountPlaceholder: '0.00050000',
    belowMin: min => `Below the ${min} minimum withdrawal.`,
    gasNote: "You need ckETH for gas. Add ckETH first if you don't have any.",
    inProgress: 'Withdrawal in progress',
    withdrawAmount: amount => `Withdraw ${amount}`,
    resumeNote:
      'Already signed — Retry re-sends the same envelopes (it cannot double-spend). Editing the form starts a fresh withdrawal instead.',
    reviewTitle: 'Review withdrawal',
    confirmLabel: 'Confirm withdrawal',
    retry: 'Retry withdrawal',
  },

  sol: {
    createAtaLabel: 'Create my USDC account',
    backToScan: 'Back to scan',
    sent: 'Sent ✓',
    txSignature: 'transaction signature',
    copySignatureLabel: 'Copy transaction signature',
    copySignature: 'Copy signature',
    sending: amount => `Sending ${amount}…`,
    confirmingOnSolana: 'Confirming on Solana — this can take up to a minute.',
    sendToSolana: asset => `Send your ${asset} to a Solana address`,
    available: available => `Available: ${available}`,
    addressLabel: 'Solana address',
    addressPlaceholder: 'Receiver base58 address',
    usdcAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: 'Sending USDC needs a little SOL in the wallet for network fees — add some first.',
    reviewTitle: 'Review send',
    sendAmount: amount => `Send ${amount}`,
    recipientAtaNote: cost =>
      `If they don't have a USDC account yet, this creates it for them (one-time ≈${cost} paid by you).`,
    confirmLabel: asset => `Confirm ${asset} send`,
  },
};
