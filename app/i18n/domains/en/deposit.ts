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
    copyDepositAddress: string;
    statusTitle: string;
    watching: string;
    checkingEvery: (seconds: number) => string;
    checkNowLabel: string;
    mintedAmount: (amount: string) => string;
  };

  /**
   * Direct-ICRC rail (IcrcDepositSheet): no minter — receiving IS a plain ICRC-1 transfer to the
   * user's own account (VCHF/ICP). Founder hard rule 2026-08-29: practical instructions always.
   */
  icrc: {
    /**
     * THE one instruction line (10x-verbosity pass 2026-09-17). It merged the old sendToAccount +
     * whereFrom pair, which restated each other; the exchange route survives the merge because
     * "send it from any wallet" is a complete instruction only for someone who already has one —
     * the target user is a tourist who does not, and the exchange withdrawal is the second route
     * that actually exists. No product is named: which wallet or exchange dpay would send a user
     * to is a founder decision and is deliberately not made here.
     */
    whereFrom: (symbol: string, network: string) => InstrRun[];
    /** The destination-only loss warning: what this address accepts, and that anything else sent
     *  here won't credit. The old "no card or bank transfer" clause told a user holding a crypto
     *  wallet nothing they could act on. */
    onlyAccepts: (symbol: string, network: string) => string;
    /** Practical instruction: no memo/reference gymnastics needed for a plain transfer. */
    noMemo: string;
    feeLine: (fee: string) => string;
    /** Honest receive detection: ledger balance strictly above the watched baseline. */
    receivedAmount: (amount: string) => string;
    /** "Already on the IC?" section on the family deposit sheets (IcrcAccountSection). */
    alsoTitle: string;
    alsoBody: (symbol: string) => InstrRun[];
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
    /**
     * The submit() outcomes, and they are this many because only the DEPOSIT transaction can ever
     * mint. `txReverted` / `txUnconfirmed` speak about a deposit that IS on chain; the `approve*`
     * keys speak about the ERC-20 allowance step, after which the deposit was never sent — so they
     * must never read as "your deposit is on its way".
     */
    txReverted: string;
    /** Broadcast, outcome unknown — the receipt timed out OR the receipt read itself failed. */
    txUnconfirmed: string;
    approveReverted: string;
    approveUnconfirmed: string;
    /**
     * The send produced no transaction id, so dpay knows neither that it was sent nor that it was
     * not — the one outcome that is neither "sent" nor "failed". Two keys because the risk differs:
     * an unattributed DEPOSIT may still credit (retrying can pay twice), an unattributed APPROVE can
     * never mint anything (retrying is safe).
     *
     * Each is the INSTRUCTION HALF only. The sentence in front of it — which of the two things
     * happened, a wallet that answered without an id or a wallet that never answered — is the
     * `TransactionHashMissing` message (`M.errors.ethWallet.hashMissing` / `sendTimedOut`), because
     * only the error knows that. These strings must therefore never open with a claim about the
     * wallet; they used to say "Your wallet accepted the deposit", which is false on the silent
     * branch and was written before that branch existed.
     */
    depositHashUnknown: string;
    approveHashUnknown: string;
    txNotSigned: string;
    txFailed: string;
    /**
     * Appended to whichever "the deposit never went out" line applies when the ERC-20 approval was
     * already CONFIRMED on chain: the allowance is live, and the retry asks for two signatures.
     */
    allowanceStands: string;
    sendOnly: (nativeAsset: string, networkLabel: string) => InstrRun[];
    /**
     * The mint mechanics + timing, FOLDED (10x pass 2026-09-17) behind the sheet's ONE Details
     * control together with `explainNative`/`explainErc20` — replaced the on-card custody line,
     * whose non-custodial half is already stated at onboarding and in Settings and changed no
     * user decision here.
     */
    mintLine: string;
    /** The Details disclosure's label — the fold control for `mintLine` + the explain pair. */
    details: string;
    /** Who pays gas: native ETH comes out of the sent amount; an ERC-20 needs ETH held separately. */
    gasNative: string;
    gasErc20: string;
    scanToPair: string;
    /**
     * The same-device half of the pairing screen (the QR above it is the other-device half).
     *
     * WHY NAMED WALLET BUTTONS EXIST AT ALL, stated here once: `@walletconnect/sign-client` brings
     * a wallet to the foreground for a signing request only when a deeplink choice was recorded for
     * it, and recording one requires KNOWING which wallet was opened. The phone's own `wc:` chooser
     * never says which app it launched, so a pairing made through it leaves the later
     * "Approve & deposit" request sitting invisibly in a backgrounded wallet — which is exactly
     * what `otherWalletHint` warns about, and why it is a fallback rather than the main route.
     */
    orOpenHere: string;
    openNamedWallet: (name: string) => string;
    otherWallet: string;
    otherWalletHint: string;
    /** A named wallet that would not open — say WHICH, and what is left to try. */
    couldntOpenWallet: (name: string) => string;
    walletList: string;
    /** Why this rail asks for a wallet instead of showing an address. FOLDED behind the Details
     *  control (10x pass 2026-09-17) — it is the mental model, not a step. */
    explainNative: string;
    explainErc20: (nativeAsset: string) => string;
    connectLabel: string;
    connect: string;
    amountPlaceholder: string;
    /** The connected Ethereum account, already shortened by the caller. */
    fromAccount: (shortAccount: string) => string;
    confirmingLabel: string;
    /**
     * NATIVE ONLY, and it must hold for BOTH pairing routes: a wallet opened by name reopens itself
     * for the signing request (that route records the deeplink choice — see `openWalletWithUri` in
     * wallet.ts), while one paired through the system chooser or a scanned QR does not, leaving
     * "Confirm in your wallet…" describing a screen the user cannot see. So the line promises
     * nothing and covers both. The web extension pops up by itself — showing this there would be
     * the lie in the other direction.
     */
    switchToWalletApp: string;
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
    createAtaLabel: (asset: string) => string;
    checkingAta: (asset: string) => string;
    /** Fail-closed, never a false claim: the account could not be CHECKED, so nothing is asserted. */
    ataUnverified: (asset: string) => string;
    /** The detail when NO classified cause exists (rail off / 'unavailable') — class-agnostic. */
    ataUnverifiedDetail: (asset: string) => string;
    /** Per-class details (R4, spec 2026-09-09-relay-ha-and-solana-proxy): the sheet picks the
     *  sentence from the transport seam's `SolanaReadFailure` classification (app/solana.ts) —
     *  never guessed at the component. `unreachable` names dpay's relay (post-R2 the Solana RPC
     *  path IS the relay's proxy), says the money is untouched and what still works — it never
     *  blames the user's connection for a service outage. `offline` keeps the connection-honest
     *  spelling; `refused` names the endpoint; `unreadable` names the untrustworthy answer. */
    ataUnverifiedRefused: (asset: string) => string;
    ataUnverifiedOffline: (asset: string) => string;
    ataUnverifiedUnreachable: (asset: string) => string;
    ataUnverifiedUnreadable: (asset: string) => string;
    retryAtaLabel: (asset: string) => string;
    checkAgain: string;
    backToRequest: string;
    sendToAddress: (asset: string, network: string) => InstrRun[];
    /** Also rendered by the token-account setup card below. */
    devnetWarn: (asset: string) => string;
    waitingDeposit: string;
    copyAssetAddress: (asset: string) => string;
  };

  /** The one-tap token-account setup card (SolanaAtaSetupCard), shared by receive AND send. Every
   *  sentence names the asset it is about (USDC, EURC, …) — never a hard-coded token. */
  ata: {
    absent: (asset: string) => string;
    /** The one-time rent + fee is DISCLOSED before the tap — no silent cost on a money screen. */
    cost: (setupCost: string, asset: string) => string;
    checkingSol: string;
    needSol: (setupCost: string) => string;
    showSolAddress: string;
    creating: (asset: string) => string;
    createHint: (setupCost: string, asset: string) => string;
  };

  /** One-tap funding from Trust Wallet (Android only). */
  trust: {
    fund: string;
    fundHint: (asset: string) => string;
    err: string;
  };

  /** "Don't have any yet?" — the step BEFORE the address (founder direction 2026-09-09; design and
   *  measured provider evidence in docs/specs/2026-09-09-funding-routes-plan.md).
   *
   *  Every figure rendered here is a provider's OWN published number, relayed with the date it was
   *  read and never computed by dpay (docs/REGULATORY.md §4 item 7). `upTo` vs `from` is the
   *  load-bearing distinction: no provider publishes a price, only a ceiling or a floor, so copy
   *  that dropped the qualifier would state a maximum as if it were what the user pays. */
  funding: {
    title: string;
    /** The route: buy this token on `chain`, then send it to the address this sheet is already
     *  showing. `chain` is the chain THE ADDRESS LIVES ON, which for an Internet Computer account is
     *  the IC and not the chain the token is backed by — the distinction that made the first version
     *  of this screen tell a ckUSDC holder to send Ethereum USDC to an IC principal. */
    buyThenSend: (token: string, chain: string) => InstrRun[];
    /** No address exists: the deposit is a transaction the user's OWN wallet signs on `chain`, and
     *  the fee is a SEPARATE holding of `gasToken` they must already have. Never "send it to the
     *  address above" — there is none, and the sentence loses money if it is followed. */
    bridgeWithGas: (token: string, chain: string, gasToken: string) => InstrRun[];
    /** The same wallet-signed deposit for the chain's own coin, which pays its own fee — so it asks
     *  for a margin rather than a second holding. */
    bridgeSelfGas: (token: string, chain: string) => InstrRun[];
    /** No provider anywhere sells the target asset, so it is reached through `viaToken` and a swap
     *  the user signs on their own device. */
    buyThenConvert: (viaToken: string, target: string) => InstrRun[];
    /** A test coin: no cash value, nobody sells it, and the practical instruction is a faucet
     *  rather than a provider (founder rule 2026-08-29 — every step gets an action). */
    testnetOnly: (symbol: string, chain: string) => string;
    /** The same faucet, for a coin that reaches the wallet through a signed transaction rather than
     *  an address — so the sentence cannot end with "send it here". */
    testnetOnlyWallet: (symbol: string, chain: string) => string;
    /** The Swiss bank alternative to VCHF, bounded by the approval it actually holds. */
    bankRoute: (provider: string) => string;
    /** Heading over the provider list, stating plainly that dpay is not choosing. */
    providersTitle: string;
    /** One published method rate, prefixed by its method: `card 2.5%`, `bank 0.5%`. */
    costCard: (rate: string) => string;
    costBank: (rate: string) => string;
    /** SEPA bank transfer, named as Transak publishes it — a specific rail, not a generic bank. */
    costSepa: (rate: string) => string;
    /** Apple Pay and Google Pay — one label for both, as Transak publishes them together. */
    costWalletPay: (rate: string) => string;
    /** A published MINIMUM — used both for a provider's overall minimum and inside a method
     *  rate ("0.99%, min €1"). */
    costMin: (amount: string) => string;
    costSpread: (rate: string) => string;
    /** A fixed amount published ON TOP of a percentage (Transak card: "3.5% + €1"). */
    plusFixed: (fixed: string) => string;
    /** A cost the provider DISCLOSES but publishes only as a range — the per-currency figure
     *  does not exist, so the range renders as a range with its variation named, never as its
     *  top or a midpoint. */
    nonUsdUplift: (from: string, to: string) => string;
    /** Conditional-rate qualifiers, rendered in parentheses after the rate they qualify. Ramp's
     *  transfer variants stay verbatim — they are the provider's own method names. */
    qEur: string;
    qNonEur: string;
    qUsdEurGbp: string;
    qOtherCurrencies: string;
    qManual: string;
    qEasy: string;
    qPix: string;
    /** A published CEILING — never a price. */
    upTo: (pct: string) => string;
    /** A published FLOOR — also never a price. */
    from: (pct: string) => string;
    /** Attribution + the two caveats that make the figures honest: they are the providers' own, on
     *  a date, and the real total includes a margin most of them do not itemise. */
    attribution: (readOn: string) => string;
    /** Said out loud so a list of names cannot be read as a recommendation. */
    noEndorsement: string;
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
    copyDepositAddress: 'Copy deposit address',
    statusTitle: 'Status',
    watching: 'Watching for your deposit',
    checkingEvery: seconds => `checking every ${seconds}s`,
    checkNowLabel: 'Check deposit status now',
    mintedAmount: amount => `${amount} minted`,
  },

  icrc: {
    whereFrom: (symbol, network) => [
      {t: 'Send '},
      {t: symbol, em: true},
      {t: ' from any wallet app that holds it on '},
      {t: network, em: true},
      {t: ' — or withdraw it from an exchange that supports the network.'},
    ],
    onlyAccepts: (symbol, network) =>
      `This address receives ${symbol} sent on ${network} — anything else won't credit.`,
    noMemo: 'No memo or reference needed.',
    feeLine: fee => `Network fee ${fee}`,
    receivedAmount: amount => `${amount} received`,
    alsoTitle: 'Already on the Internet Computer?',
    alsoBody: symbol => [
      {t: 'Send '},
      {t: symbol, em: true},
      {t: ' from any Internet Computer wallet directly to your IC address below — no memo needed.'},
    ],
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
    connectFailed: 'Could not connect to your wallet. Open your wallet app, approve the connection request there, then try again.',
    noWalletApp: 'No wallet app found. Scan the QR with a wallet on another device instead.',
    walletDisconnected: 'Wallet disconnected.',
    amountRequired: 'Enter an amount greater than zero.',
    missingErc20Address: 'Onramp details missing the ERC-20 address.',
    txReverted: 'Transaction reverted on chain.',
    txUnconfirmed: 'Transaction sent but not yet confirmed — still watching for the mint.',
    approveReverted:
      'The approval reverted on chain, so the deposit was never sent and no funds left your wallet. Try again — your wallet will ask you to approve first, then to deposit.',
    approveUnconfirmed:
      'Your approval was sent but not confirmed, so the deposit was never sent and no funds left your wallet. Wait a moment, then try again: your wallet will ask you to approve once more, which is expected and only costs gas.',
    depositHashUnknown:
      'Check the recent activity in your wallet app before you try again — if the deposit is there, it will still credit in about 20 minutes, and depositing again would send the money twice.',
    approveHashUnknown:
      'No deposit was made and no funds left your wallet. Check the recent activity in your wallet app, then try again — it will ask you to approve first, which is expected and only costs gas.',
    txNotSigned: 'Transaction not signed.',
    txFailed: 'Transaction failed.',
    allowanceStands:
      'Your spending approval is already confirmed on chain and no funds have left your wallet. Trying again will ask you to approve and then deposit, both signatures as before.',
    sendOnly: (nativeAsset, networkLabel) => [
      {t: 'Send only '},
      {t: nativeAsset, em: true},
      {t: ' on '},
      {t: networkLabel, em: true},
      {t: ". Other assets or chains sent this way won't credit and may be lost."},
    ],
    mintLine: 'Your deposit mints 1:1 to your wallet on confirmation (~20 min).',
    details: 'Details',
    gasNative: 'The network fee is paid in ETH — send a little more than you want to deposit.',
    gasErc20: "You'll need a small amount of ETH for Ethereum network gas fees.",
    scanToPair: 'Scan with your wallet to pair',
    orOpenHere: 'Or open a wallet on this phone:',
    openNamedWallet: name => `Open ${name}`,
    otherWallet: 'Another wallet',
    otherWalletHint:
      "Pairing works, but dpay can't reopen it later — switch to the wallet yourself to approve the deposit.",
    couldntOpenWallet: name =>
      `Couldn't open ${name} — it may no longer be installed. Pick another wallet below, or scan the QR with a wallet on another device.`,
    walletList: 'MetaMask · Trust · Rabby · any WalletConnect-compatible wallet',
    explainNative:
      'Send ETH directly to the deposit contract — one transaction your wallet signs, with your deposit amount as the ETH value.',
    explainErc20: nativeAsset =>
      `${nativeAsset} is an Ethereum token — depositing it needs two transactions your wallet signs: first the approval, then the deposit.`,
    connectLabel: 'Connect Ethereum wallet',
    connect: 'Connect wallet',
    amountPlaceholder: '0.00',
    fromAccount: shortAccount => `From ${shortAccount}`,
    confirmingLabel: 'Confirming in your wallet',
    switchToWalletApp: 'Your wallet should open to approve this. If it doesn’t, switch to it yourself — then come back here.',
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
    createAtaLabel: asset => `Create ${asset} account`,
    checkingAta: asset => `Checking your ${asset} account…`,
    ataUnverified: asset => `Couldn't check your ${asset} account.`,
    ataUnverifiedDetail: asset =>
      `Your address is fine — we just can't reach Solana right now to confirm your ${asset} account on-chain. Check your connection and try again.`,
    ataUnverifiedRefused: asset =>
      `Your address is fine — Solana’s endpoint refused the request, so your ${asset} account could not be confirmed on-chain. Nothing moved, and dpay keeps retrying — try again in a moment.`,
    ataUnverifiedOffline: asset =>
      `Your address is fine — you appear to be offline, so your ${asset} account could not be confirmed on-chain. Nothing moved; check again once you’re back online.`,
    ataUnverifiedUnreachable: asset =>
      `Your address is fine — dpay’s relay can’t reach Solana right now, so your ${asset} account could not be confirmed on-chain. Your connection is not the problem; your money is untouched and your Internet Computer payments still work. Try again in a moment.`,
    ataUnverifiedUnreadable: asset =>
      `Your address is fine — Solana answered with data this wallet cannot read, so your ${asset} account could not be confirmed on-chain. Nothing moved; try again in a moment.`,
    retryAtaLabel: asset => `Retry checking ${asset} account`,
    checkAgain: 'Check again',
    backToRequest: 'Back to request',
    sendToAddress: (asset, network) => [
      {t: 'Send '},
      {t: asset, em: true},
      {t: ' to your '},
      {t: network},
      {t: ' address below.'},
    ],
    devnetWarn: asset =>
      `Connected to Solana devnet. Do NOT send mainnet ${asset} here — it will not appear. Use devnet ${asset} only.`,
    waitingDeposit: 'Waiting for your deposit · checks every few seconds',
    copyAssetAddress: asset => `Copy ${asset} address`,
  },

  ata: {
    absent: asset => `You don't have a ${asset} account on this device yet.`,
    cost: (setupCost, asset) =>
      `Creating your ${asset} account costs ${setupCost} (one-time rent + fee, from your SOL balance) — it stays yours, on your keys.`,
    checkingSol: 'Checking your SOL balance…',
    needSol: setupCost =>
      `You need about ${setupCost} in this wallet first — receive SOL at your address, then create the account.`,
    showSolAddress: 'Show my SOL address',
    creating: asset => `Creating your ${asset} account — confirming on Solana…`,
    createHint: (setupCost, asset) => `Create your one-time ${asset} account for ${setupCost} from your SOL balance`,
  },

  trust: {
    fund: 'Fund from Trust Wallet',
    fundHint: asset => `Opens Trust Wallet to send ${asset} to your dpay address`,
    err: "Couldn't open Trust Wallet. Try again.",
  },

  funding: {
    title: "Don't have any yet?",
    buyThenSend: (token, chain) => [
      {t: 'Buy '},
      {t: token, em: true},
      {t: ' from any exchange or card provider that pays out on '},
      {t: chain, em: true},
      {t: ', then send it to the address above.'},
    ],
    bridgeWithGas: (token, chain, gasToken) => [
      {t: 'There is no address for this one. Buy '},
      {t: token, em: true},
      {t: ' on '},
      {t: chain, em: true},
      {t: ' into a wallet you control, and keep a little '},
      {t: gasToken, em: true},
      {t: ' in it for the network fee. Then connect that wallet here — it signs the transfer.'},
    ],
    bridgeSelfGas: (token, chain) => [
      {t: 'There is no address for this one. Buy '},
      {t: token, em: true},
      {t: ' on '},
      {t: chain, em: true},
      {t: ' into a wallet you control — a little more than you want to move, because the network fee comes out of it. Then connect that wallet here — it signs the transfer.'},
    ],
    buyThenConvert: (viaToken, target) => [
      {t: 'No provider sells '},
      {t: target, em: true},
      {t: ' directly. The route that works: buy '},
      {t: viaToken, em: true},
      {t: ' with a card, send it to the address above, then use Convert to swap it for '},
      {t: target, em: true},
      {t: '.'},
    ],
    testnetOnly: (symbol, chain) => `${symbol} is test money — it has no cash value and nobody sells it. Get some free from a public ${chain} faucet, then send it to the address above.`,
    testnetOnlyWallet: (symbol, chain) => `${symbol} is test money — it has no cash value and nobody sells it. Get some free from a public ${chain} faucet into a wallet you control, then connect that wallet here.`,
    bankRoute: provider => `From a Swiss bank account, ${provider} sells it directly by transfer. It needs full identity checks and takes bank-transfer time.`,
    providersTitle: 'Where people buy it',
    costCard: rate => `card ${rate}`,
    costBank: rate => `bank ${rate}`,
    costSepa: rate => `SEPA ${rate}`,
    costWalletPay: rate => `Apple & Google Pay ${rate}`,
    costMin: amount => `min ${amount}`,
    costSpread: rate => `plus ${rate} margin`,
    plusFixed: fixed => `+ ${fixed}`,
    nonUsdUplift: (from, to) => `non-USD purchases: minimum fee +${from} to ${to} higher, depending on currency`,
    qEur: 'EUR',
    qNonEur: 'non-EUR',
    qUsdEurGbp: 'USD, EUR, GBP',
    qOtherCurrencies: 'other currencies, incl. CHF',
    qManual: 'manual',
    qEasy: 'easy',
    qPix: 'Pix',
    upTo: pct => `up to ${pct}`,
    from: pct => `from ${pct}`,
    attribution: readOn => `Each provider's own published figures, read ${readOn}. They are limits, not prices — your exact fee is shown before you pay, and most providers also take a margin inside the rate they quote.`,
    noEndorsement: 'Listed alphabetically. dpay recommends none of them, is paid by none of them, and takes no part in your purchase.',
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

  /**
   * The unified send-to-address surface (SendSheet + AddressField): ONE destination field that
   * accepts any address, routed by which namespace it belongs to. Distinct from `ic` above, which
   * is the chain-key OFFRAMP copy (burn → native chain) — this section covers the destination
   * field itself, the route disclosure, the refusals, and the direct-ICRC / legacy-ICP send.
   */
  send: {
    destLabel: string;
    destPlaceholder: string;
    scanLabel: string;
    scanTitle: string;
    scanCancel: string;
    /** Route disclosure — what WILL happen, shown before the user commits. */
    routeIcrc: (network: string, fee: string) => string;
    /** The same route line when the asset being sent is a rail of the home currency's group
     *  (Objective 2, S5): the line names the RAIL (`railLineLabel`, e.g. "ckUSDC · Internet
     *  Computer"), not just the network — several rails carry this currency, and the sender
     *  should see which one this send settles on. */
    routeIcrcOnRail: (rail: string, fee: string) => string;
    /** Used when the asset's catalog row carries NO registered fee: the ledger charges its own
     *  default and we do not know the number, so we say so rather than print a made-up 0. */
    routeIcrcUnknownFee: (network: string) => string;
    /** The unknown-fee twin of `routeIcrcOnRail`. */
    routeIcrcOnRailUnknownFee: (rail: string) => string;
    /** The Solana rail's route line. No fee number: this rail signs on-device and broadcasts to an
     *  RPC, so nothing has quoted one — and the screen never prints a fee it does not know. */
    routeSolana: (network: string) => string;
    feeUnknown: string;
    routeLegacy: (fee: string) => string;
    routeNative: (chain: string, minutes: number, min: string) => string;
    /** Same line for a chain with NO withdraw floor — "minimum 0" reads as a malfunction. */
    routeNativeNoMin: (chain: string, minutes: number) => string;
    /**
     * Refusals. Each names what the pasted address IS and what to do instead — never a bare
     * "invalid address" (founder hard rule 2026-08-29: a dead end that only describes itself is
     * a bug).
     */
    refuseWrongChain: (pastedChain: string, asset: string, assetChain: string) => string;
    refuseLegacyNotIcp: (asset: string) => string;
    refuseUnrecognised: (asset: string) => string;
    refuseMistypedIc: string;
    refuseMistypedLegacy: string;
    /** A subaccount of the user's OWN principal. Refused, not warned: dpay reads and signs exactly
     *  one account per asset (owner + default subaccount), so funds parked at another subaccount of
     *  ours are invisible here and unspendable from here — permanently. A stranger's subaccount is
     *  paid normally; only our own is a dead end, so this names it and says there is nothing to do. */
    refuseOwnSubaccount: string;
    /** Sending to your own MAIN account is legal and almost always a mistake — warn, never block. */
    selfWarning: string;
    /** Amount row. */
    maxLabel: string;
    feeLine: (fee: string) => string;
    totalLine: (total: string) => string;
    /** Saved destinations (the address book). */
    savedTitle: string;
    saveNamePlaceholder: string;
    forgetLabel: (address: string) => string;
    unnamed: string;
    /** The contextual entry into the full address-book route, riding the saved list's title. */
    manage: string;
    manageHint: string;
    /** The send itself. */
    reviewTitle: string;
    networkRow: string;
    sendAmount: (amount: string) => string;
    sending: (amount: string) => string;
    sent: string;
    sentUnknown: string;
    sentUnknownBody: string;
    blockIndex: (index: string) => string;
    noLedger: string;
  };

  /** Native Solana rail (SolanaWithdrawSheet): the device key signs and broadcasts directly. */
  sol: {
    createAtaLabel: (asset: string) => string;    backToScan: string;
    sent: string;
    txSignature: string;
    copySignatureLabel: string;
    copySignature: string;
    sending: (amount: string) => string;
    confirmingOnSolana: string;
    sendToSolana: (asset: string) => string;
    available: (available: string) => string;
    /** Amount placeholder for a registry token send (SOL's own scale sits beside it). */
    tokenAmountPlaceholder: string;
    solAmountPlaceholder: string;
    /** Fees (and a possible recipient-account creation) are paid in SOL — said BEFORE the amount. */
    needsSol: (asset: string) => string;
    reviewTitle: string;
    sendAmount: (amount: string) => string;
    recipientAtaNote: (cost: string, asset: string) => string;
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

  send: {
    destLabel: 'Send to',
    destPlaceholder: 'Paste an address, or scan',
    scanLabel: 'Scan a destination QR code',
    scanTitle: 'Scan the destination address',
    scanCancel: 'Enter it by hand instead',

    routeIcrc: (network, fee) => `${network} · arrives in seconds · fee ${fee}`,
    routeIcrcOnRail: (rail, fee) => `${rail} · arrives in seconds · fee ${fee}`,
    routeIcrcUnknownFee: network => `${network} · arrives in seconds · the ledger's own fee applies`,
    routeIcrcOnRailUnknownFee: rail => `${rail} · arrives in seconds · the ledger's own fee applies`,
    routeSolana: network => `${network} · arrives in seconds · a small SOL network fee applies`,
    feeUnknown: 'set by the ledger',
    routeLegacy: fee => `ICP account · arrives in seconds · fee ${fee}`,
    routeNative: (chain, minutes, min) => `${chain} · about ${minutes} min · minimum ${min}`,
    routeNativeNoMin: (chain, minutes) => `${chain} · about ${minutes} min`,

    // No article immediately before an interpolated name: "a ${chain}" produces "a Ethereum".
    // English cannot pick a/an without knowing the next word, and there is no pluralisation
    // machinery here by design, so the sentence is shaped to avoid the problem entirely rather
    // than patched with a vowel test. The other locales already avoid it — their articles agree
    // with the noun ("eine ${chain}-Adresse", "una dirección de ${chain}"), not the variable.
    refuseWrongChain: (pastedChain, asset, assetChain) =>
      `${pastedChain} addresses can't receive ${asset} — it settles on ${assetChain}. Paste an address for that network instead.`,
    refuseLegacyNotIcp: asset =>
      `That's an ICP account identifier — the 64-character form. Only ICP itself can be sent to one; for ${asset}, ask the recipient for their Internet Computer principal (the dashed form).`,
    refuseUnrecognised: asset => `That doesn't look like an address ${asset} can be sent to.`,
    refuseMistypedIc: 'This Internet Computer address is incomplete or mistyped — check you copied all of it.',
    refuseMistypedLegacy: 'This ICP account address is incomplete or mistyped — check you copied all 64 characters.',
    refuseOwnSubaccount:
      "That's a subaccount of your own wallet, and dpay only shows and spends your main account — money sent there would stop appearing here. You already hold this asset: paste someone else's address to send it.",
    selfWarning: 'This is your own address. The funds come straight back and you still pay the fee.',

    maxLabel: 'Max',
    feeLine: fee => `Network fee ${fee}`,
    totalLine: total => `Total ${total}`,

    savedTitle: 'Saved addresses',
    saveNamePlaceholder: 'Name it (optional)',
    forgetLabel: address => `Remove the saved address ${address}`,
    unnamed: 'Unnamed',
    manage: 'Address book',
    manageHint: 'Browse, name and remove saved destinations',

    reviewTitle: 'Review',
    networkRow: 'Network',
    sendAmount: amount => `Send ${amount}`,
    sending: amount => `Sending ${amount}…`,
    sent: 'Sent',
    sentUnknown: 'Not confirmed yet',
    sentUnknownBody:
      "The transfer was submitted but hasn't been confirmed yet. It may still go through — check your balance in a moment rather than sending again.",
    blockIndex: index => `Ledger block ${index}`,
    noLedger: 'This asset has no ledger configured, so it cannot be sent.',
  },

  sol: {
    createAtaLabel: asset => `Create my ${asset} account`,
    backToScan: 'Back to scan',
    sent: 'Sent ✓',
    txSignature: 'transaction signature',
    copySignatureLabel: 'Copy transaction signature',
    copySignature: 'Copy signature',
    sending: amount => `Sending ${amount}…`,
    confirmingOnSolana: 'Confirming on Solana — this can take up to a minute.',
    sendToSolana: asset => `Send your ${asset} to a Solana address`,
    available: available => `Available: ${available}`,
    tokenAmountPlaceholder: '1.5',
    solAmountPlaceholder: '0.025',
    needsSol: asset => `Sending ${asset} needs a little SOL in the wallet for network fees — add some first.`,
    reviewTitle: 'Review send',
    sendAmount: amount => `Send ${amount}`,
    recipientAtaNote: (cost, asset) =>
      `If they don't have a ${asset} account yet, this creates it for them (one-time ≈${cost} paid by you).`,
    confirmLabel: asset => `Confirm ${asset} send`,
  },
};
