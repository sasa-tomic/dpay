/**
 * i18n/domains/en/wallet.ts — the `wallet` + `education` message domains (types + English, co-located).
 *
 * WALLET covers the wallet shell and its asset surfaces: the header (settings/theme/account/
 * balance), the tab bar, the Balances sheet, the Transactions ledger, the shared fund-first panel,
 * the share confirmation, and the asset/catalog DISPLAY strings (`play money for testing`, the
 * `<symbol> · <network>` subtitle joiner, the fail-closed `Unsupported` sentinel, testnet naming).
 *
 * EDUCATION covers everything that teaches the dpay model: the campaign line, the 3-scene
 * walkthrough, the payment rehearsal, the contextual coaching tips, and the Trip Readiness
 * passport (stamps, archive page, capstone). `config/education.ts` and `lib/readiness.ts` compose
 * their export shapes (`walkthroughScenes()`, `rehearsalSteps()`, `passportStamps()`) out of the
 * copy below — the ids, visual keys and display ORDER stay with the logic that owns them; only the
 * words live here. Those are FUNCTIONS, not constants, precisely because a locale switch replaces
 * this object wholesale: anything captured at module load would keep rendering the old language.
 *
 * Conventions are the catalog's (see i18n/keys.ts): interpolation is a typed FUNCTION, never a
 * '{{placeholder}}'; no pluralization machinery; no fallbacks. Currency glyphs (∂ $ ₿ Ξ ◎), asset
 * symbols (DEMO/BTC/USDC/SOL) and network names (Bitcoin/Ethereum/Solana) are locale-invariant
 * product identity and are NOT in this catalog.
 */
import type {CoachTipKey, RehearsalStepId, WalkthroughSceneId} from '../../../config/education';
import type {ReadinessKey} from '../../../lib/readiness';

/** One walkthrough scene's words. The scene's id, illustration key and order live in education.ts. */
export type WalkthroughSceneCopy = {eyebrow: string; title: string; body: string};
/** One rehearsal beat's words. The beat's id, illustration key and order live in education.ts. */
export type RehearsalStepCopy = {title: string; body: string};
/** One coaching tip's words. Its surface key + glyph live in education.ts / CoachTip.tsx. */
export type CoachTipCopy = {title: string; body: string};
/** One passport stamp's words: the two-line inked label, the next-step hint, the strip phrase. */
export type PassportStampCopy = {label: string; hint: string; short: string};

export type WalletMessages = {
  /** Header utility cluster: the gear, the theme flip, the account eyebrow. */
  header: {
    settings: string;
    settingsHint: string;
    /** `target` is the mode one tap lands in (Light/Dark) — the icon names the TARGET. */
    themeSwitch: (target: string) => string;
    themeSwitchHint: string;
    /** The eyebrow above the username, and its accessible name. */
    account: string;
    accountLabel: string;
    /** The web wordmark's back-link to the marketing site (web build only). */
    home: string;
    homeHint: string;
  };

  /** The header balance pressable (opens the Balances sheet). */
  balance: {
    label: string;
    hint: string;
    /** Shown instead of `hint` while a pay engine holds the selection lock. */
    lockedHint: string;
    /** Online: the polled balance is authoritative. Offline: the honest approximation. */
    of: (asset: string) => string;
    approx: (asset: string) => string;
    /**
     * The offline balance itself, marked as best-known rather than authoritative. Takes the
     * already-formatted amount so the marker can lead, trail, or become a word — `~` is not the
     * universal "approximately" mark.
     */
    approxAmount: (amount: string) => string;
    /** Android hardware-back double-press hint. */
    backAgainToExit: string;
  };

  /**
   * The HOME CURRENCY — the one currency the wallet is "in" (app/config/currency.ts).
   *
   * Copy rule, and it is a money-honesty rule rather than a style one: `name` is the CURRENCY the
   * user chose, and it is never used as a unit next to an amount. The amount always carries the
   * token's own unit (`12.40 VCHF`), because VCHF is a third party's franc-denominated token whose
   * peg dpay does not verify. "Swiss francs" as a heading over `12.40 VCHF` is honest; "CHF 12.40"
   * is a claim.
   */
  homeCurrency: {
    /** The currency's own name, as a heading. Plural reads better as a section label than the code. */
    name: {CHF: string; USD: string; EUR: string};
    /** The chooser's title + subtitle. */
    chooseTitle: string;
    chooseBody: string;
    /** Why the rail dpay picks is the one it picks — short qualifiers, attached to its line by
     *  `railWithReason`. */
    railReason: {destination: string; funded: string; preference: string};
    /** One rail's line with its reason attached ("ckUSDC · Internet Computer — dpay's default rail"). */
    railWithReason: (line: string, reason: string) => string;
    /** The badge on the accounts-list row that IS the main currency. */
    mainBadge: string;
    /** The header eyebrow above the headline amount. */
    mainLabel: (currency: string) => string;
    /** Settings row. */
    settingsTitle: string;
    settingsHint: string;
    /** Chooser confirm. */
    confirm: string;
    /** The catalog carries no rail for ANY currency — a broken asset list, named as such. */
    noneAvailable: string;
    a11y: (currency: string) => string;
  };

  /** The catalog's per-rail liquidity statement — the rail-health lines (RailLiquidityNote).
   *  `token` is the LEDGER token (VEUR), never the currency glyph. */
  railHealth: {
    thin: (token: string) => string;
    deep: string;
  };

  /** The chooser's per-rail detail panel: its back affordance + the ramp statements derivable
   *  from the catalog's onramp/offramp facts (config/currency.ts `railRampLine`). */
  railDetail: {
    back: string;
    rampNone: string;
    rampSellPartner: (partner: string) => string;
    rampBothDirect: string;
  };

  tab: {pay: string; receive: string; transactions: string};

  /** The fund-funnel resume link on Receive → My address. */
  backToPaying: (asset: string) => string;

  /** Demo faucet outcomes, surfaced inline under the Balances row. */
  faucet: {
    unavailableOnRelay: string;
    failed: string;
    unavailable: string;
    offline: string;
  };

  /** The Balances sheet — the wallet's asset hub. */
  balances: {
    title: string;
    close: string;
    intro: string;
    demoFunds: string;
    demoFundsLabel: string;
    demoFundsHint: string;
    needsSetup: string;
    select: (symbol: string) => string;
    selectHint: string;
    selectSolanaHint: (symbol: string) => string;
    showTestnet: string;
    hideTestnet: string;
    showTestnetHint: string;
    hideTestnetHint: string;
    escToClose: string;
  };

  /** The Transactions tab. */
  ledger: {
    empty: string;
    emptyHint: string;
    recent: string;
    allAssets: string;
    all: string;
    filter: (label: string) => string;
    to: (who: string) => string;
    from: (who: string) => string;
    /**
     * The counterparty on a gateway mint row, which carries no name of its own. Deliberately NOT
     * `balances.demoFunds`: that one names the faucet BUTTON. These two collide in English only —
     * a locale is free to render "who paid you" and "get test money" differently, and sharing the
     * key would take that choice away.
     */
    mintCounterparty: string;
    /**
     * The note on a row whose transaction FAILED on-chain. Solana charges the fee even when the
     * transfer is rolled back, so the row's honest amount is a small debit — which alone would read
     * as a tiny successful payment. This line is what stops that.
     */
    failed: string;
    /**
     * The honesty note under the list when the Solana reader could not read some transactions
     * (`SolanaHistory.dropped > 0`): they are missing from this list but still exist on-chain.
     * A note, never an error — everything the list DOES show is still true.
     */
    dropped: (count: number) => string;
  };

  /** The shared "add funds before you pay" panel's recheck link (both rails). */
  fund: {checking: string; checkAgain: string};

  /** Asset/catalog display strings. */
  asset: {
    /** The DEMO row's subtitle — the one asset with no network. */
    demoSubtitle: string;
    /** The subtitle joiner for every other asset. NOTE: `config/assets.ts#shortNetworkTag`
      * splits the result on this exact ' · ' separator to build the collision chip tag. */
    networkLabel: (symbol: string, network: string) => string;
    /** The fail-closed sentinel: no honest name/amount could be resolved. */
    unsupported: string;
    /** A testnet currency's display name, and the fallback when no backing symbol exists. */
    testnetName: (base: string) => string;
    testnet: string;
  };

  /** The native Share sheet's confirmation (nothing was copied — the sheet WAS the feedback). */
  share: {shared: string};
};

export const walletEn: WalletMessages = {
  header: {
    settings: 'Settings',
    settingsHint: 'Open relay, reset, and advanced settings',
    themeSwitch: target => `Switch theme to ${target}`,
    themeSwitchHint: 'Toggles the theme between Light and Dark; set Auto in Settings',
    account: 'ACCOUNT',
    accountLabel: 'Account',
    home: 'dpay home',
    homeHint: 'Open the main dpay site',
  },

  balance: {
    label: 'Balances — switch currency or receive',
    hint: 'Open the full asset list, switch the displayed currency, or receive',
    lockedHint: 'Finish or cancel the current payment first',
    of: asset => `${asset} balance`,
    approx: asset => `~ ${asset} approx.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Press back again to exit',
  },

  homeCurrency: {
    name: {CHF: 'Swiss francs', USD: 'US dollars', EUR: 'Euros'},
    chooseTitle: 'Which currency do you think in?',
    chooseBody: 'dpay shows this currency first and pays in it by default. You can hold any of the others too, and change this any time in Settings.',
    railReason: {destination: 'the payment asks for this rail', funded: 'you hold a balance here', preference: 'dpay\'s default rail'},
    railWithReason: (line, reason) => `${line} — ${reason}`,
    mainBadge: 'Main',
    mainLabel: currency => `${currency} · Main`,
    settingsTitle: 'Main currency',
    settingsHint: 'The currency dpay shows first and pays in by default',
    confirm: 'Continue',
    noneAvailable: 'No currencies could be loaded. Check the server address in Settings, then reopen dpay.',
    a11y: currency => `Choose ${currency}`,
  },

  railHealth: {
    thin: token => `Very little ${token} exists on-chain today — receiving can be hard, and paying needs someone who holds it.`,
    deep: 'Circulates widely on-chain today.',
  },

  railDetail: {
    back: 'Back',
    rampNone: 'No fiat ramp today — it moves wallet to wallet.',
    rampSellPartner: partner => `${partner} lists this token as sellable; buying is not available today.`,
    rampBothDirect: 'Deposit and cash-out to its native chain are wired in dpay.',
  },

  tab: {pay: 'Pay', receive: 'Receive', transactions: 'Transactions'},

  backToPaying: asset => `Back to paying ${asset}`,

  faucet: {
    unavailableOnRelay: 'Demo top-up isn’t available on this relay',
    failed: 'Top-up failed',
    unavailable: 'Faucet unavailable',
    offline: 'Offline — try again when connected',
  },

  balances: {
    title: 'Balances',
    close: 'Close balances',
    intro: 'Tap a currency to show it on your home screen. Receive or send it from the Receive and Pay tabs.',
    demoFunds: 'Demo funds',
    demoFundsLabel: 'Get demo funds',
    demoFundsHint: 'Add ∂100 of demo money to this wallet',
    needsSetup: 'Needs setup',
    select: symbol => `Select ${symbol}`,
    selectHint: "Show this asset's balance on your home screen",
    selectSolanaHint: symbol => `Show ${symbol} on your home screen and use the Solana rail for Pay/Receive`,
    showTestnet: 'Show testnet assets',
    hideTestnet: 'Hide testnet assets',
    showTestnetHint: 'Reveal testnet currencies in this list',
    hideTestnetHint: 'Hide testnet currencies from this list',
    escToClose: 'Press Esc to close',
  },

  ledger: {
    empty: 'No payments yet.',
    emptyHint: 'Tap Receive to create a payment request, or Pay to scan one.',
    recent: 'Recent',
    allAssets: 'All assets',
    all: 'All',
    filter: label => `Filter ${label}`,
    to: who => `to ${who}`,
    from: who => `from ${who}`,
    mintCounterparty: 'Demo funds',
    failed: 'Failed — only the network fee was charged',
    dropped: count => count === 1
      ? '1 Solana transaction could not be read — it still exists on-chain, but is not shown here.'
      : `${count} Solana transactions could not be read — they still exist on-chain, but are not shown here.`,
  },

  fund: {checking: 'Checking…', checkAgain: 'Check again'},

  asset: {
    demoSubtitle: 'play money for testing',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    unsupported: 'Unsupported',
    testnetName: base => `${base} testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Shared ✓'},
};

export type EducationMessages = {
  /** The promise in four words — the walkthrough send-off and the offline-peak moment. */
  campaignLine: string;
  /** The Settings replay row + the replay Modal's title. */
  howItWorksTitle: string;

  walkthrough: {
    /** The three scenes' words, keyed by scene id (order + illustration live in education.ts). */
    scenes: Record<WalkthroughSceneId, WalkthroughSceneCopy>;
    /** The travel-document corner tag on each scene's stage plate. */
    stageTags: readonly [string, string, string];
    close: string;
    skip: string;
    skipHint: string;
    back: string;
    backLabel: string;
    next: string;
    nextLabel: string;
    nextHint: string;
    getStarted: string;
    getStartedHint: string;
    /** The scene-3 illustration's request-card eyebrow. */
    shopRequests: string;
  };

  rehearsal: {
    /** The page's own title line — mounting the page IS seeing the flow. */
    title: string;
    /** The sheet-chrome header title. */
    sheetTitle: string;
    /** The three beats' words, keyed by step id (order + illustration live in education.ts). */
    steps: Record<RehearsalStepId, RehearsalStepCopy>;
    stageTags: readonly [string, string, string];
    /** The closing comprehension pin: approval + handoff need no signal. */
    punchline: string;
    skip: string;
    skipHint: string;
    try: string;
  };

  /** One-time contextual coaching, keyed by the surface its truth applies to. */
  coachTips: Record<CoachTipKey, CoachTipCopy>;
  coachDismiss: (title: string) => string;
  coachDismissHint: string;

  /** The Trip Readiness passport: the home strip, the archive page, the capstone. */
  passport: {
    title: string;
    /** The four stamps' words, keyed by capability (order lives in lib/readiness.ts). */
    stamps: Record<ReadinessKey, PassportStampCopy>;
    close: (title: string) => string;
    /** The home strip's accessible name. */
    stripLabel: (filled: number) => string;
    /** The archive's only number. */
    count: (filled: number) => string;
    goToStep: (hint: string) => string;
    goToStepHint: string;
    nextTag: string;
    nextLabel: (hint: string) => string;
    nextHint: string;
    doneHint: string;
    /** The durable TRIP READY mark (also the strip's complete-state hint). */
    ready: string;
    readyLine: string;
    /** The capstone band — an explicit newline keeps the two inked lines. */
    capstone: string;
    capstoneMicro: string;
    /** A stamp's award date, as a real passport page shows it. */
    stampDate: (monthIndex: number, day: number) => string;
  };

  /** The first truly-offline confirmed payment's moment, then its quiet remnant. */
  peak: {micro: string; settled: string};
};

/** Month abbreviations for the passport stamp date — English caps, as inked on a document page. */
const EN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const educationEn: EducationMessages = {
  campaignLine: "Signal? Don't need it.",
  howItWorksTitle: 'How dpay works',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'HOW DPAY PAYS',
        title: 'Pay without signal',
        body: 'Your phone can pay with no signal at all. The shop sends the payment for you, using its own internet connection.',
      },
      key: {
        eyebrow: 'YOUR MONEY',
        title: 'Your key stays on this device',
        body: 'dpay holds no funds and cannot approve a payment for you. There is no dpay account — only your key.',
      },
      exact: {
        eyebrow: 'NO SURPRISES',
        title: 'Pay the exact requested asset',
        body: 'The shop asks for one exact asset. You review the amount and approve. dpay never converts another balance.',
      },
    },
    stageTags: ['01 — SIGNAL', '02 — KEY', '03 — ASSET'],
    close: 'Close how dpay works',
    skip: 'Skip walkthrough',
    skipHint: 'Go straight to creating your wallet',
    back: 'Back',
    backLabel: 'Previous scene',
    next: 'Next',
    nextLabel: 'Next scene',
    nextHint: 'Show the next scene',
    getStarted: 'Get started',
    getStartedHint: 'Continue to creating your wallet',
    shopRequests: 'Shop requests',
  },

  rehearsal: {
    title: 'One honest payment',
    sheetTitle: 'Rehearsal',
    steps: {
      request: {
        title: 'The shop requests',
        body: "The shop picks an exact asset and amount — its terminal turns that into a request code.",
      },
      approve: {
        title: 'You review and approve',
        body: "Your phone shows exactly what you're paying. Nothing moves until you approve it with your key.",
      },
      settle: {
        title: 'The shop settles',
        body: "The shop's own connection sends the payment — confirmed in seconds on its screen.",
      },
    },
    stageTags: ['01 — REQUEST', '02 — APPROVE', '03 — SETTLE'],
    punchline: "That's it. Your phone can be offline for approval and handoff.",
    skip: 'Explore wallet',
    skipHint: 'Skip the rehearsal and open your wallet',
    try: 'Try with demo funds',
  },

  coachTips: {
    payReview: {
      title: 'You approve the exact payment',
      body: 'Approving sends exactly this amount of this asset — from your balance, signed by your key.',
    },
    receiveRequest: {
      title: 'Show your request code',
      body: "Show this code to your customer. Their phone scans it and approves; your connection confirms.",
    },
    offlineQr: {
      title: 'Signed — not settled',
      body: "No signal? This signed code is your proof of payment. The receiver's connection settles it — status updates when you're back.",
    },
    pendingOutcome: {
      title: 'Still pending',
      body: "Pending means the outcome isn't known yet. Never assume it succeeded — check back here.",
    },
  },
  coachDismiss: title => `Dismiss tip: ${title}`,
  coachDismissHint: "Hide this tip; it won't show again",

  passport: {
    title: 'Trip readiness',
    stamps: {
      recoverySaved: {label: 'BACKED\nUP', hint: 'Copy your backup words in Settings', short: 'back up to go'},
      flowUnderstood: {label: 'SAW THE\nFLOW', hint: 'Watch the rehearsal when creating a wallet — or make any payment', short: 'see how it works to go'},
      fundsReady: {label: 'FUNDS\nLOADED', hint: 'Add any funds — demo funds count', short: 'add funds to go'},
      paymentTested: {label: 'FIRST\nPAYMENT', hint: 'Complete a payment — pay or receive', short: 'one payment to go'},
    },
    close: title => `Close ${title}`,
    stripLabel: filled => `Trip readiness ${filled} of 4`,
    count: filled => `${filled} OF 4`,
    goToStep: hint => `Go: ${hint}`,
    goToStepHint: 'Open the surface where this step happens',
    nextTag: 'Next',
    nextLabel: hint => `Next: ${hint}`,
    nextHint: 'Go to the surface where this step happens',
    doneHint: 'Retire the trip readiness strip',
    ready: 'Trip ready',
    readyLine: 'You can pay even when your phone has no signal.',
    capstone: 'Trip\nReady',
    capstoneMicro: 'Nothing left to set up. Go have the trip.',
    stampDate: (monthIndex, day) => `${EN_MONTHS[monthIndex]} ${day}`,
  },

  peak: {
    micro: 'No signal the whole time.',
    settled: 'paid with no signal',
  },
};
