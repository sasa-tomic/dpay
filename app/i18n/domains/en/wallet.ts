/**
 * i18n/domains/en/wallet.ts - the `wallet` + `education` message domains (types + English, co-located).
 *
 * WALLET covers the wallet shell and its asset surfaces: the header (settings/theme/account/
 * balance), the tab bar, the Balances sheet, the Transactions ledger, the shared fund-first panel,
 * the share confirmation, and the asset/catalog DISPLAY strings (`play money for testing`, the
 * `<symbol> · <network>` subtitle joiner, the fail-closed `Unsupported` sentinel, testnet naming).
 *
 * EDUCATION covers everything that teaches the dpay model: the campaign line, the 3-scene
 * walkthrough, the first-run practice payment, the contextual coaching tips, and the Trip Readiness
 * passport (stamps, archive page, capstone). `config/education.ts` and `lib/readiness.ts` compose
 * their export shapes (`walkthroughScenes()`, `passportStamps()`) out of the
 * copy below - the ids, visual keys and display ORDER stay with the logic that owns them; only the
 * words live here. Those are FUNCTIONS, not constants, precisely because a locale switch replaces
 * this object wholesale: anything captured at module load would keep rendering the old language.
 *
 * Conventions are the catalog's (see i18n/keys.ts): interpolation is a typed FUNCTION, never a
 * '{{placeholder}}'; no pluralization machinery; no fallbacks. Currency glyphs (∂ $ ₿ ◊ •), asset
 * symbols (DEMO/BTC/USDC/SOL) and network names (Bitcoin/Ethereum/Solana) are locale-invariant
 * product identity and are NOT in this catalog.
 */
import type {CoachTipKey, WalkthroughSceneId} from '../../../config/education';
import type {ReadinessKey} from '../../../lib/readiness';

/** One walkthrough scene's words. The scene's id, illustration key and order live in education.ts. */
export type WalkthroughSceneCopy = {eyebrow: string; title: string; body: string};
/** One coaching tip's words. Its surface key + glyph live in education.ts / CoachTip.tsx. */
export type CoachTipCopy = {title: string; body: string};
/** One passport stamp's words: the two-line inked label, the next-step hint, the strip phrase. */
export type PassportStampCopy = {label: string; hint: string; short: string};

export type WalletMessages = {
  /** Header utility cluster: the gear and the theme flip. */
  header: {
    settings: string;
    /** `target` is the mode one tap lands in (Light/Dark) - the icon names the TARGET. */
    themeSwitch: (target: string) => string;
    /** The web wordmark's back-link to the marketing site (web build only). */
    home: string;
  };

  /** The header balance pressable (opens the Balances sheet). */
  balance: {
    label: string;
    /** Shown as the chip's hint while a pay engine holds the selection lock. */
    lockedHint: string;
    /** Online: the polled balance is authoritative. Offline: the honest approximation. */
    approx: (asset: string) => string;
    /**
     * The offline balance itself, marked as best-known rather than authoritative. Takes the
     * already-formatted amount so the marker can lead, trail, or become a word - `~` is not the
     * universal "approximately" mark.
     */
    approxAmount: (amount: string) => string;
    /** Android hardware-back double-press hint. */
    backAgainToExit: string;
  };

  /**
   * The HOME CURRENCY - the one currency the wallet is "in" (app/config/currency.ts).
   *
   * Copy rule, and it is a money-honesty rule rather than a style one: `name` is the CURRENCY the
   * user chose, and it is never used as a unit next to an amount. The amount always carries the
   * token's own unit (`12.40 VCHF`), because VCHF is a third party's franc-denominated token whose
   * peg dpay does not verify. "Swiss francs" as a heading over `12.40 VCHF` is honest; "CHF 12.40"
   * is a claim.
   */
  homeCurrency: {
    /** The currency's own name, as a heading. Plural reads better as a section label than the code.
     *  The token currencies' names are network proper nouns (the same rule the asset rows'
     *  `network` field follows) - identical across locales by design. */
    name: {CHF: string; USD: string; EUR: string; BTC: string; ETH: string; ICP: string; SOL: string};
    /** The chooser's title + subtitle. */
    chooseTitle: string;
    chooseBody: string;
    /** Why the rail dpay picks is the one it picks - short qualifiers, attached to its line by
     *  `railWithReason`. Only the ACTIONABLE reasons are here: `RailReason` also has `preference`,
     *  which orders the rails but is never disclosed (docs/specs/2026-09-07-ux-decisions.md). */
    railReason: {destination: string; funded: string};
    /** One rail's line with its reason attached ("ckUSDC · Internet Computer - you hold a balance here"). */
    railWithReason: (line: string, reason: string) => string;
    /** The badge on the accounts-list row that IS the main currency. */
    mainBadge: string;
    /** Settings row. */
    settingsTitle: string;
    settingsHint: string;
    /** Chooser confirm. */
    confirm: string;
    /** Continue pressed with nothing picked. The button LOOKS pressable, so it IS pressable and
     *  answers with the step that is missing - a control that swallows the tap in silence is the
     *  dead end the founder's 2026-08-29 rule forbids (`OPEN_ISSUES.md`, UX swarm X5). */
    pickFirst: string;
    /** The catalog carries no rail for ANY currency - a broken asset list, named as such. */
    noneAvailable: string;
    a11y: (currency: string) => string;
  };

  /** The catalog's per-rail liquidity statement - the rail-health lines (RailLiquidityNote).
   *  The note renders ON the rail it describes, so it never names the token (founder 2026-09-19:
   *  the thin statement is 2-3 words, not an essay). */
  railHealth: {
    thin: string;
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

  tab: {pay: string; receive: string; transactions: string; home: string};

  /**
   * The HOME TAB - the landing surface, currency-first (2026-09-24 redesign). Its headline is the
   * MAIN CURRENCY's summed balance in the CURRENCY unit (fork #4): the eyebrow names the code
   * ("Balance CHF"), the amount renders with the currency's own unit placement ("4.54 Fr"). The
   * offline approximation marker (`balance.approx`) outranks everything - a wallet that is not
   * connected renders its best-known figure, marked.
   */
  home: {
    /**
     * The action row (fork #1): Add funds / Convert / Withdraw funds / [...]. Pay and Receive
     * stay on the bottom tab bar - they are one tap from anywhere, so the row is money in, out,
     * and across. `more` names the overflow menu the icon opens.
     */
    actions: {
      addFunds: string;
      convert: string;
      withdraw: string;
      more: string;
    };
    /** The eyebrow above the headline amount: the currency as its SHORT code. */
    balanceEyebrow: (code: string) => string;
    /** The overflow menu (the [...] sheet): its entries, and the close affordance. */
    menu: {
      ledger: string;
      remove: string;
      close: string;
    };
    /**
     * The Remove refusals - the guard's reasons as practical next steps (founder rule
     * 2026-08-29: every refusal says what to do). `nonzero` names the balance that must move.
     */
    removeRefusal: {
      nonzero: (amount: string) => string;
      unreadable: string;
      last: string;
    };
    /** The inline activity feed - the newest ledger rows, capped, with the see-all link. */
    activity: {
      title: string;
      seeAll: string;
    };
    /** The headline block IS the affordance that opens the CURRENCY LIST. `openLabel` names the
     *  ACTION for the screen reader - never a second copy of the eyebrow sentence. */
    accounts: {
      openLabel: string;
    };
  };

  /**
   * The ACCOUNTS route - the CURRENCY LIST (the 2026-09-24 redesign): one row per visible
   * currency, a summed currency-unit balance, Convert on every row; the row tap sets MAIN.
   */
  accounts: {
    title: string;
    /** States the list's one gesture: tapping a currency row sets it as the main currency. */
    intro: string;
    back: string;
    /** The divider that separates the practice rail from the currencies holding real value. Whole
     *  sentence, never a glyph (anti-scam rule R3: play money is labelled wherever it appears). */
    practice: string;
    /** The row tap's hint - selection IS the action (the spec supersedes tap protection). */
    setMainHint: string;
    /** [Add new currency] - the button at the list's end and its route. */
    addCurrency: string;
  };

  /**
   * The ADD-CURRENCY route - the full supported-currency list (2026-09-24 redesign): search on
   * top, split into stable currencies and Other; in-wallet currencies are marked, hidden ones
   * carry their Add button (the Remove semantics' way back).
   */
  addCurrency: {
    title: string;
    /** The search field's placeholder. */
    search: string;
    /** The two sections: the fiat stables, then everything else. */
    stable: string;
    other: string;
    /** The mark on a currency already in the wallet (not re-addable). */
    inWallet: string;
    /** The hidden currency's button. */
    add: string;
    /** The honest empty state: the search matched nothing. */
    none: string;
  };

  /** The ADDRESS BOOK route - the browse/manage surface over the per-asset saved destinations
   *  (services/addressBook.ts, previously reachable only as send-form autocomplete chips).
   *  Addresses render through the SAME shared vocabulary as the chips (`M.withdraw.send.unnamed`,
   *  `M.withdraw.send.forgetLabel`) so the book and the form can never disagree on what an
   *  unnamed or removed entry is called. */
  addressBook: {
    title: string;
    /** The one-line orientation under the title. Names the device-local scope (no account, no
     *  sync) - the same honesty the custody statement makes. */
    intro: string;
    back: string;
    /** The honest empty line + its way out (founder rule: every state says what to do next). */
    empty: string;
    addEntry: string;
    /** The add form's asset chooser heading. */
    assetLabel: string;
    addressLabel: string;
    addressPlaceholder: string;
    addressHint: string;
    nameLabel: string;
    namePlaceholder: string;
    save: string;
    rename: string;
    /** `who` is the entry's current label, or its short address when unnamed. */
    renameHint: (who: string) => string;
  };

  /** The fund-funnel resume link on Receive → My address. */
  backToPaying: (asset: string) => string;

  /** Demo faucet outcomes, surfaced inline under the Balances row. */
  faucet: {
    unavailableOnRelay: string;
    failed: string;
    unavailable: string;
    offline: string;
  };

  /** The asset hub - the Home tab's inline accounts list (the Balances sheet's successor; O4 S3).
   *  The sheet-chrome keys (title/close/escToClose) retired with the sheet; the row copy lives on. */
  balances: {
    demoFunds: string;
    demoFundsLabel: string;
    demoFundsHint: string;
    needsSetup: string;
    select: (symbol: string) => string;
    selectHint: string;
    showTestnet: string;
    hideTestnet: string;
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
    /** A pool counterparty the registries can no longer name (round-1 item 9): the neutral
     *  wording, never a principal styled as a counterparty. Lowercase like from()/to(). */
    fromPool: string;
    /** The same neutral wording for the outgoing leg (a deposit into a pool contract the
     *  registries can no longer name). Lowercase like from()/to(). */
    toPool: string;
    /**
     * The fee annotation on a log row whose payment netted a fee in (founder rule 2026-09-14):
     * fees ride the row ONLY as this line beside the GROSS headline - hidden when unknown/zero.
     */
    fees: (fee: string) => string;
    /**
     * The counterparty on a gateway mint row, which carries no name of its own. Deliberately NOT
     * `balances.demoFunds`: that one names the faucet BUTTON. These two collide in English only -
     * a locale is free to render "who paid you" and "get test money" differently, and sharing the
     * key would take that choice away.
     */
    mintCounterparty: string;
    /**
     * The note on a row whose transaction FAILED on-chain. Solana charges the fee even when the
     * transfer is rolled back, so the row's honest amount is a small debit - which alone would read
     * as a tiny successful payment. This line is what stops that.
     */
    failed: string;
    /**
     * The honesty note under the list when the Solana reader could not read some transactions
     * (`SolanaHistory.dropped > 0`): they are missing from this list but still exist on-chain.
     * A note, never an error - everything the list DOES show is still true.
     */
    dropped: (count: number) => string;
    /** The Transactions list's AGE line (`Ledger`'s `tx-stale-note`, populated branch only): the
     *  oldest rail's last SUCCESSFUL refresh is older than HISTORY_STALE_AFTER_MS. An age
     *  statement, never a failure verdict and never a cause - the founder 2026-10-16 wording
     *  ("shown if refreshing actually fails for real for some time"). */
    staleSince: (minutes: number) => string;
  };

  /** The shared "add funds before you pay" panel's recheck link (both rails). */
  fund: {checking: string; checkAgain: string};

  /** Asset/catalog display strings. */
  asset: {
    /** The DEMO row's subtitle - the one asset with no network. */
    demoSubtitle: string;
    /** The subtitle joiner for every other asset. NOTE: `config/assets.ts#shortNetworkTag`
      * splits the result on this exact ' · ' separator to build the collision chip tag. */
    networkLabel: (symbol: string, network: string) => string;
    /** The subtitle for a CHAIN-KEY asset, which lives on two chains at once: it is `backing` on
      * `from` that has been bridged onto `to`, where it settles and where its receive address is.
      * Naming only ONE of them is wrong in both directions - "USDC · Ethereum" invites a user to
      * send Ethereum USDC to an Internet Computer principal, and "USDC · Internet Computer" hides
      * the chain the deposit actually runs on. The arrow carries the direction, which is what makes
      * the pair readable rather than merely present (founder, 2026-09-09). */
    bridgedLabel: (symbol: string, from: string, to: string) => string;
    /** The fail-closed sentinel: no honest name/amount could be resolved. */
    unsupported: string;
    /** A testnet currency's display name, and the fallback when no backing symbol exists. */
    testnetName: (base: string) => string;
    testnet: string;
  };

  /** The native Share sheet's confirmation (nothing was copied - the sheet WAS the feedback). */
  share: {shared: string};
};

export const walletEn: WalletMessages = {
  header: {
    settings: 'Settings',
    themeSwitch: target => `Switch theme to ${target}`,
    home: 'dpay home',
  },

  balance: {
    label: 'Balances',
    lockedHint: 'Finish or cancel the current payment first',
    approx: asset => `~ ${asset} approx.`,
    approxAmount: amount => `~${amount}`,
    backAgainToExit: 'Press back again to exit',
  },

  homeCurrency: {
    name: {CHF: 'Swiss francs', USD: 'US dollars', EUR: 'Euros', BTC: 'Bitcoin', ETH: 'Ether', ICP: 'Internet Computer', SOL: 'Solana'},
    chooseTitle: 'Which currency do you think in?',
    chooseBody: 'Display only.',
    railReason: {destination: 'the payment asks for it', funded: 'you hold funds'},
    railWithReason: (line, reason) => `${line} - ${reason}`,
    mainBadge: 'Main',
    settingsTitle: 'Main currency',
    settingsHint: 'Shown first; the default when paying.',
    confirm: 'Continue',
    pickFirst: 'Pick a currency first.',
    noneAvailable: 'No currencies loaded. Check the server address in Settings, then reopen dpay.',
    a11y: currency => `Choose ${currency}`,
  },

  railHealth: {
    thin: 'Thin liquidity',
    deep: 'Circulates widely.',
  },

  railDetail: {
    back: 'Back',
    rampNone: 'No fiat ramp - wallet to wallet only.',
    rampSellPartner: partner => `${partner} - sell only today.`,
    rampBothDirect: 'Deposit and cash-out are wired in.',
  },

  tab: {pay: 'Pay', receive: 'Receive', transactions: 'Transactions', home: 'Home'},

  home: {
    actions: {
      addFunds: 'Add funds',
      convert: 'Convert',
      withdraw: 'Withdraw',
      more: 'More',
    },
    balanceEyebrow: code => `Balance ${code}`,
    menu: {
      ledger: 'Transactions',
      remove: 'Remove',
      close: 'Close',
    },
    removeRefusal: {
      nonzero: amount => `Move or convert ${amount} first.`,
      unreadable: 'Balance unreadable. Reconnect, then try again.',
      last: 'Keep at least one currency.',
    },
    activity: {
      title: 'Activity',
      seeAll: 'See all',
    },
    accounts: {
      openLabel: 'Open accounts',
    },
  },

  accounts: {
    title: 'Accounts',
    intro: 'Tap a currency to make it main.',
    back: 'Back',
    practice: 'Practice money. No shop takes it.',
    setMainHint: 'Sets it as your main currency',
    addCurrency: 'Add currency',
  },

  addCurrency: {
    title: 'Add currency',
    search: 'Search',
    stable: 'Stable currencies',
    other: 'Other',
    inWallet: 'In wallet',
    add: 'Add',
    none: 'No matches.',
  },

  addressBook: {
    title: 'Address book',
    intro: 'Saved only on your phone.',
    back: 'Back',
    empty: 'No saved addresses yet. Addresses you send to appear automatically.',
    addEntry: 'Add address',
    assetLabel: 'For',
    addressLabel: 'Address',
    addressPlaceholder: 'Paste address',
    addressHint: 'As you would send to it',
    nameLabel: 'Name',
    namePlaceholder: 'e.g. Alice',
    save: 'Save',
    rename: 'Rename',
    renameHint: who => `Rename ${who}`,
  },

  backToPaying: asset => `Back to paying ${asset}`,

  faucet: {
    unavailableOnRelay: 'Top-up unavailable on this relay',
    failed: 'Top-up failed',
    unavailable: 'Faucet unavailable',
    offline: 'Offline - try again when connected',
  },

  balances: {
    demoFunds: 'Demo funds',
    demoFundsLabel: 'Get demo funds',
    demoFundsHint: 'Adds ∂100 demo money',
    needsSetup: 'Needs setup',
    select: symbol => `Select ${symbol}`,
    selectHint: 'Used for Pay and Receive',
    showTestnet: 'Show testnet assets',
    hideTestnet: 'Hide testnet assets',
  },

  ledger: {
    empty: 'No payments yet.',
    emptyHint: 'Tap Receive to request, or Pay to scan.',
    recent: 'Recent',
    allAssets: 'All assets',
    all: 'All',
    filter: label => `Filter ${label}`,
    to: who => `to ${who}`,
    from: who => `from ${who}`,
    fromPool: 'from a pool',
    toPool: 'to a pool',
    fees: fee => `− ${fee} fees`,
    mintCounterparty: 'Demo funds',
    failed: 'Failed - only the fee was charged',
    dropped: count => count === 1
      ? '1 Solana transaction couldn’t be read - it still exists on-chain.'
      : `${count} Solana transactions couldn’t be read - they still exist on-chain.`,
    staleSince: minutes => `Transaction list is stale - last refreshed ${minutes} min ago.`,
  },

  fund: {checking: 'Checking…', checkAgain: 'Check again'},

  asset: {
    demoSubtitle: 'play money for testing',
    networkLabel: (symbol, network) => `${symbol} · ${network}`,
    bridgedLabel: (symbol, from, to) => `${symbol} · ${from} → ${to}`,
    unsupported: 'Unsupported',
    testnetName: base => `${base} testnet`,
    testnet: 'Testnet',
  },

  share: {shared: 'Shared ✓'},
};

export type EducationMessages = {
  /** The promise in four words - the walkthrough send-off and the offline-peak moment. */
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
    back: string;
    next: string;
    getStarted: string;
    /** The scene-3 illustration's request-card eyebrow. */
    shopRequests: string;
  };

  /**
   * The first-run PRACTICE payment (spec docs/specs/2026-09-08-first-run-redesign.md §3): one
   * real ∂1.00 DEMO transfer to a pinned practice payee, made alone, on this device, before the
   * app asks the user to decide anything.
   *
   * Copy rule, the catalog's own: interpolation is a typed FUNCTION and never a spliced verb, and
   * every state gets a COMPLETE sentence per branch rather than one sentence with a hole in it
   * (`fundBody` is the model). Outcome HEADLINES are deliberately absent from this block for the
   * two states the pay screen already names - a settled practice payment reads `M.nfc.paidAmount`
   * and a pending one reads `M.pay.sent`, because they are the same events and one copy is the
   * point.
   */
  practice: {
    /** The sheet-chrome header title. */
    sheetTitle: string;
    /** The request card's corner tag - the walkthrough's stage-tag grammar. */
    eyebrow: string;
    /**
     * The practice payee's display name. It rides the 132-byte wire request, whose name field is
     * 32 BYTES - every locale's translation must fit that, in UTF-8.
     */
    payeeName: string;
    /** The page's own title line. */
    title: string;
    /** The one line under the request card. */
    cardLine: string;
    /** The real, polled practice balance above the card. */
    balance: (amount: string) => string;
    review: string;
    skip: string;
    /**
     * The one line practice adds to the real review: why practising needs a connection when the
     * product does not. Both halves in one sentence - the exception and the rule.
     */
    bothSides: string;
    /** The ledger settled it: what actually happened, then what is left. */
    settledBody: string;
    settledBalance: (amount: string) => string;
    /** Signed and sent, outcome unknown. Never a success, never a failure. */
    pendingBody: string;
    /** The ledger refused it. `reason` is the ledger's own decoded words, shown verbatim. */
    refusedTitle: string;
    refusedBody: string;
    /** The ONE exit from every outcome - practice never blocks the first run. */
    continue: string;
    /** The permanent footer: play money, and nothing is being sold. */
    punchline: string;
    /**
     * The fail-closed branches. Each names what the user can do next (founder rule 2026-08-29) and
     * NONE of them offers a deposit address or an add-money action: nothing may ask a new user for
     * funds before the app has given them anything (anti-scam rule R1).
     */
    noFaucet: {title: string; body: string};
    cooldown: {title: string; body: (reason: string) => string};
    offline: {title: string; body: string};
    empty: {title: string; body: string};
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
    nextTag: string;
    nextLabel: (hint: string) => string;
    doneHint: string;
    /** The durable TRIP READY mark (also the strip's complete-state hint). */
    ready: string;
    readyLine: string;
    /** The capstone band - an explicit newline keeps the two inked lines. */
    capstone: string;
    capstoneMicro: string;
    /** A stamp's award date, as a real passport page shows it. */
    stampDate: (monthIndex: number, day: number) => string;
  };

  /** The first truly-offline confirmed payment's moment, then its quiet remnant. */
  peak: {micro: string; settled: string};
};

/** Month abbreviations for the passport stamp date. */
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const educationEn: EducationMessages = {
  campaignLine: "Signal? Don't need it.",
  howItWorksTitle: 'How dpay works',

  walkthrough: {
    scenes: {
      offline: {
        eyebrow: 'First, how a payment works',
        title: 'One phone requests, the other pays',
        body: 'The other phone shows a request. You scan it, check the amount, then approve. Their connection sends the payment if yours is offline.',
      },
      key: {
        eyebrow: 'Your money',
        title: 'Your key stays on your phone',
        body: 'dpay holds no money and cannot approve payments. There is no dpay account - only your key.',
      },
      exact: {
        eyebrow: 'No surprises',
        title: 'Pay the exact requested asset',
        body: 'The shop asks for one exact asset. You check the amount and approve. dpay never swaps.',
      },
    },
    stageTags: ['Signal', 'Key', 'Asset'],
    close: 'Close how dpay works',
    skip: 'Skip walkthrough',
    back: 'Back',
    next: 'Next',
    getStarted: 'Get started',
    shopRequests: 'Shop requests',
  },

  practice: {
    sheetTitle: 'Practice payment',
    eyebrow: 'Practice',
    payeeName: 'Practice shop',
    title: 'Make one payment, for real',
    cardLine: 'The code a shop shows.',
    balance: amount => `${amount} of practice money.`,
    review: 'Review payment',
    skip: 'Skip practice',
    bothSides: 'Practice needs a connection - your phone plays both sides. On a trip, only the shop does.',
    settledBody: 'Signed by your phone, settled by the practice ledger.',
    settledBalance: amount => `${amount} of practice money left.`,
    pendingBody: 'Signed and sent, not yet settled - nothing is confirmed. This is what pending looks like.',
    refusedTitle: 'Refused',
    refusedBody: 'Nothing moved.',
    continue: 'Continue setup',
    punchline: 'Practice money has no cash value.',
    noFaucet: {
      title: 'No practice money',
      body: 'This server has none right now. Nothing is wrong - carry on and pick your currency.',
    },
    cooldown: {
      title: 'Practice money, in a moment',
      body: reason => `This server gives out practice money once in a while - it recently did. It said: ${reason} Carry on; come back any time.`,
    },
    offline: {
      title: 'Practice needs a connection',
      body: 'Your phone plays both sides. Reconnect and try again, or carry on with setup.',
    },
    empty: {
      title: 'No practice money yet',
      body: 'Nothing is wrong - carry on and pick your currency.',
    },
  },

  coachTips: {
    receiveRequest: {
      title: 'Show it to your customer',
      body: 'Their phone scans and approves; your connection confirms.',
    },
    offlineQr: {
      title: 'Signed - not settled',
      body: "This signed code is your proof of payment. The receiver's connection settles it - status updates when you're back.",
    },
    pendingOutcome: {
      title: 'Still pending',
      body: "The outcome isn't known yet - never assume success; check back later.",
    },
  },
  coachDismiss: title => `Dismiss tip: ${title}`,
  coachDismissHint: "Hide this tip; it won't show again",

  passport: {
    title: 'Trip readiness',
    stamps: {
      recoverySaved: {label: 'Backed\nup', hint: 'Copy your backup words in Settings', short: 'back up to go'},
      flowUnderstood: {label: 'Saw the\nflow', hint: 'Make the practice payment - or any payment', short: 'see how it works to go'},
      fundsReady: {label: 'Funds\nloaded', hint: 'Add spendable money - practice funds do not count', short: 'add funds to go'},
      paymentTested: {label: 'First\npayment', hint: 'Complete a payment - pay or receive', short: 'one payment to go'},
    },
    close: title => `Close ${title}`,
    stripLabel: filled => `Trip readiness ${filled} of 4`,
    count: filled => `${filled} of 4`,
    goToStep: hint => `Go: ${hint}`,
    nextTag: 'Next',
    nextLabel: hint => `Next: ${hint}`,
    doneHint: 'Retire the strip',
    ready: 'Trip ready',
    readyLine: 'Pay even when your phone has no signal.',
    capstone: 'Trip\nReady',
    capstoneMicro: 'Nothing left to set up. Go have the trip.',
    stampDate: (monthIndex, day) => `${EN_MONTHS[monthIndex]} ${day}`,
  },

  peak: {
    micro: 'No signal the whole time.',
    settled: 'paid with no signal',
  },
};
