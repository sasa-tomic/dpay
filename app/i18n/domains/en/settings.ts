/**
 * i18n/domains/en/settings.ts — the Settings sheet + the Onboarding (create/restore/backup) flow.
 *
 * Two namespaces, one file: they are the app's two "wallet identity" surfaces and they share the
 * same recovery vocabulary (the 24 words, the 64-hex seed, the copy-feedback ladder), so keeping
 * them together is what lets that vocabulary have exactly ONE English source instead of two that
 * drift. `CopyWordsCopy` below is that shared source — spread into both `settings.backup` and
 * `onboarding.backup`.
 *
 * Conventions (see keys.ts for the reasoning):
 *   • Interpolation is a typed function, never a '{{placeholder}}' string.
 *   • `…A11y` = the accessibilityLabel when it differs from the visible text; `…Hint` = the
 *     accessibilityHint. Where the label and the visible text are the SAME sentence, there is one
 *     key and both sites read it.
 *   • A ternary that picks between 2-3 labels stays in the component; each label is its own key.
 */

/**
 * The "Copy words" button ladder, identical on both surfaces that reveal the BIP-39 phrase.
 * `copyWords` is the resting label AND the resting accessibilityLabel; `wordsCopied`/`wordsShared`
 * are the accessibilityLabels while the confirmation shows, `copiedCheck`/`sharedCheck` the
 * visible text for the same moment (clipboard on web, Share sheet on native).
 */
export type CopyWordsCopy = {
  copyWords: string;
  wordsCopied: string;
  wordsShared: string;
  copiedCheck: string;
  sharedCheck: string;
};

const copyWordsEn: CopyWordsCopy = {
  copyWords: 'Copy words',
  wordsCopied: 'Words copied',
  wordsShared: 'Words shared',
  copiedCheck: 'Copied ✓',
  sharedCheck: 'Shared ✓',
};

export type SettingsMessages = {
  title: string;
  close: string;

  /** Reveal the recovery seed — words by default, raw hex behind a toggle. */
  backup: CopyWordsCopy & {
    label: string;
    /** Shown at BOTH steps of the two-step gate (the confirm and the revealed view). */
    warning: string;
    copyWordsHint: string;
    copySeed: string;
    seedCopied: string;
    seedShared: string;
    copySeedHint: string;
    showAsHex: string;
    showAsHexA11y: string;
    showAsWords: string;
    showAsWordsA11y: string;
    hide: string;
    hideA11y: string;
    reveal: string;
    revealA11y: string;
    revealHint: string;
    cancelA11y: string;
    /** The action, named plainly — also the entry button's accessibilityLabel. */
    action: string;
    /** The entry button's visible text; the ellipsis signals the confirm step. */
    entry: string;
    entryHint: string;
  };

  /** Import a wallet from a pasted seed, replacing the current one. */
  restore: {
    label: string;
    warning: string;
    seedPlaceholder: string;
    seedA11y: string;
    seedHint: string;
    action: string;
    actionHint: string;
    busy: string;
    cancelA11y: string;
    entry: string;
    entryHint: string;
    /** Validation failures for the pasted seed — shown inline, never silently ignored. */
    errEmpty: string;
    errWords: string;
  };

  /** The destructive action, behind a confirmation. */
  reset: {
    label: string;
    warning: string;
    confirm: string;
    cancelA11y: string;
    action: string;
    entry: string;
    entryHint: string;
  };

  learn: {
    label: string;
    passportHint: string;
    /** Trip-readiness progress, e.g. "2/4". */
    passportCount: (filled: number) => string;
    howItWorksHint: string;
  };

  /** The address-book route entry — browse, name, add and remove the saved destinations
   *  (services/addressBook.ts, rendered by AddressesTab). */
  addressBook: {
    label: string;
    entry: string;
    entryHint: string;
  };

  /** Light / Dark / Auto. Also the source for config/theme.ts's label helpers. */
  theme: {
    /** The section heading AND the radiogroup's accessibilityLabel. */
    label: string;
    light: string;
    dark: string;
    auto: string;
    /** One segment's accessibilityLabel, e.g. "Theme: Auto". */
    choice: (label: string) => string;
  };

  /**
   * The language picker. The language NAMES are deliberately NOT here: a picker shows every
   * language in its own language ("Deutsch" stays "Deutsch" on an English phone), so the endonyms
   * are data in i18n/locale.ts, not copy — translating them is what produces the "Tedesco/German/
   * Allemand" mess that leaves a user unable to find their own language. Only the heading, the
   * follow-the-device option, and the per-segment accessible name are translated.
   */
  language: {
    label: string;
    auto: string;
    choice: (label: string) => string;
  };

  /** The collapsed disclosure holding the relay ("Server") URL. */
  advanced: {
    label: string;
    show: string;
    hide: string;
    hint: string;
    serverNote: string;
    /** The input's heading AND its accessibilityLabel. */
    serverLabel: string;
    serverPlaceholder: string;
    apply: string;
    applyA11y: string;
    /**
     * The Solana RPC endpoint (`setSolanaRpcUrl`, config/constants.ts). It was configurable in code
     * and applied at boot from storage, but reachable from NO screen — so on a phone a dead
     * provider key meant waiting for a store release, which is exactly what the 2026-09-08 outage
     * cost. Same shape as the server row above: a draft, an explicit Apply, and an empty value
     * meaning "follow the relay list again" (R2: the default endpoint is the relay’s proxy route;
     * an operator-set provider removes dpay from the path).
     *
     * `solanaError` is not written here — `setSolanaRpcUrl` throws its own actionable refusals
     * (not https, a devnet host, unparseable) and the sheet renders those verbatim.
     */
    solanaNote: string;
    /** The input's heading AND its accessibilityLabel. */
    solanaLabel: string;
    solanaPlaceholder: string;
    solanaApplyA11y: string;
    evmNote: string;
    evmLabel: string;
    evmPlaceholder: string;
    evmApplyA11y: string;
    icGatewayNote: string;
    icGatewayLabel: string;
    icGatewayPlaceholder: string;
    icGatewayApplyA11y: string;
  };

  about: {
    label: string;
    /** The custody statement. The one place Settings makes the non-custodial claim. */
    custody: string;
    /** The link's visible text AND its accessibilityLabel. */
    privacy: string;
  };
};

export const settingsEn: SettingsMessages = {
  title: 'Settings',
  close: 'Close settings',

  backup: {
    ...copyWordsEn,
    label: 'Backup',
    warning: 'This seed recovers BOTH your IC and Solana funds. Store it safely — never share it.',
    copyWordsHint: 'Copies your 24 recovery words to the clipboard',
    copySeed: 'Copy seed',
    seedCopied: 'Seed copied',
    seedShared: 'Seed shared',
    copySeedHint: 'Copies your recovery seed to the clipboard',
    showAsHex: 'Show as hex',
    showAsHexA11y: 'Show seed as hex',
    showAsWords: 'Show as words',
    showAsWordsA11y: 'Show seed as words',
    hide: 'Hide',
    hideA11y: 'Hide seed',
    reveal: 'Reveal seed',
    revealA11y: 'Reveal recovery seed',
    revealHint: 'Shows your seed on screen — anyone viewing your screen can copy it',
    cancelA11y: 'Cancel backup',
    action: 'Back up wallet',
    entry: 'Back up wallet…',
    entryHint: 'Reveals your recovery seed',
  },

  restore: {
    label: 'Restore',
    warning:
      "Replaces your current wallet with the one from this seed. Back up your current wallet first — its money is reachable only with its own seed.",
    seedPlaceholder: '24 recovery words or 64 hex characters',
    seedA11y: 'Recovery seed',
    seedHint: 'Your 24 recovery words, or the 64-hex seed from Backup',
    action: 'Restore wallet',
    actionHint: 'Replaces your current wallet',
    busy: 'Restoring…',
    cancelA11y: 'Cancel restore',
    entry: 'Restore wallet…',
    entryHint: 'Import a wallet from a seed — replaces your current wallet',
    errEmpty: 'Enter your 24 recovery words or 64-hex seed.',
    errWords:
      'Some words are wrong or missing. Check all 24 words are spelled correctly, or paste the 64-hex seed instead.',
  },

  reset: {
    label: 'Reset',
    warning:
      'This erases your wallet from this device. Money at this address becomes unrecoverable.',
    confirm: 'Yes, reset everything',
    cancelA11y: 'Cancel reset',
    action: 'Reset wallet',
    entry: 'Reset wallet…',
    entryHint: 'Permanently erases your wallet from this device',
  },

  learn: {
    label: 'Learn',
    passportHint: 'Shows your trip readiness passport',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Replays the walkthrough of how dpay pays',
  },

  addressBook: {
    label: 'Address book',
    entry: 'Saved addresses…',
    entryHint: 'Name, add and remove the destinations you have sent to',
  },

  theme: {
    label: 'Theme',
    light: 'Light',
    dark: 'Dark',
    auto: 'Auto',
    choice: label => `Theme: ${label}`,
  },

  language: {
    label: 'Language',
    auto: 'Auto',
    choice: label => `Language: ${label}`,
  },

  advanced: {
    label: 'Advanced',
    show: 'Show advanced settings',
    hide: 'Hide advanced settings',
    hint: 'Server and network endpoints this wallet talks to',
    serverNote: 'One address per line. The first that answers is used. Tap Apply to save.',
    serverLabel: 'Server',
    serverPlaceholder: 'http://<ip>:8787',
    apply: 'Apply',
    applyA11y: 'Apply server URL',
    solanaNote: 'Reads balances and sends payments through Solana. Empty follows your server list; your own provider takes dpay out of the path.',
    solanaLabel: 'Solana endpoint',
    solanaPlaceholder: 'https://<provider>/?api-key=<key>',
    solanaApplyA11y: 'Apply Solana endpoint',
    evmNote: 'Reads balances and settles ZCHF on Ethereum and Arbitrum One through dpay’s relay. Empty follows the server; your own endpoint serves ALL chains — it must prove the right chain before anything is sent.',
    evmLabel: 'EVM endpoint (all chains)',
    evmPlaceholder: 'https://<provider>',
    evmApplyA11y: 'Apply EVM endpoint',
    // F2 — the IC gateway override. Operator-facing (demos/testing against a local replica), not a
    // user feature; the note says so honestly, mirroring the Solana endpoint row's disclosure.
    icGatewayNote: 'Operator only: the base URL this wallet sends IC transactions to. Empty uses the public gateway; set a local replica for demos and tests.',
    icGatewayLabel: 'IC gateway',
    icGatewayPlaceholder: 'http://10.0.2.2:4943',
    icGatewayApplyA11y: 'Apply IC gateway',
  },

  about: {
    label: 'About',
    custody:
      'dpay is non-custodial: only the key on this device controls your money. There is no dpay account. dpay cannot move, freeze, or recover it — your 24 backup words are the only recovery.',
    privacy: 'Privacy policy',
  },
};

export type OnboardingMessages = {
  tagline: string;
  /** The short custody line. The walkthrough tells the long version — do not duplicate it here. */
  custody: string;
  /** Shown on BOTH the backup gate and the faucet-failed screen. */
  continue: string;
  /** The pasted own-seed didn't parse as 24 words or 64 hex. */
  errOwnSeed: string;
  /** The restore mnemonic didn't validate. */
  errWords: string;
  /**
   * The wallet could not be saved when the backup was acknowledged. The words stay on screen and
   * this renders under them: the wallet does NOT exist yet, so the honest instruction is to try
   * the same button again rather than to write anything else down.
   */
  errSaveWallet: string;

  /** The create path's post-backup beat: a passport stamp lands, then the practice payment. */
  recoverySaved: {
    stamp: string;
    line: string;
  };

  /** The BIP-39 backup gate — the words, the warning, and the acknowledgement. */
  backup: CopyWordsCopy & {
    title: string;
    warning: string;
    copyWordsHint: string;
    /** The checkbox's visible text AND its accessibilityLabel. */
    ack: string;
  };

  /** Recover an existing wallet: 24 words (default) or the 64-hex seed. */
  restore: {
    phraseLabel: string;
    phrasePlaceholder: string;
    phraseNote: string;
    seedLabel: string;
    seedPlaceholder: string;
    seedHint: string;
    seedNote: string;
    enterHex: string;
    enterWords: string;
    action: string;
    busy: string;
    cancelA11y: string;
    cancelHint: string;
    entryHint: string;
  };

  usernameLabel: string;
  usernamePlaceholder: string;
  usernameA11y: string;
  usernameHint: string;

  /** Create from an EXISTING seed instead of a fresh random one. */
  ownSeed: {
    useOwn: string;
    useRandom: string;
    toggleHint: string;
    placeholder: string;
    a11y: string;
    hint: string;
    note: string;
  };

  create: {
    action: string;
    busy: string;
  };

  /** What the new wallet starts with, and what the demo-dollar glyph means. */
  demoNote: string;
  /** Follows the ∂ glyph, which is styled separately — hence the leading space. */
  demoGlyphNote: string;
};

export const onboardingEn: OnboardingMessages = {
  tagline: 'Tap or scan to pay — online or offline.',
  custody: 'No account. Your key never leaves this phone. Not even dpay can move your money.',
  continue: 'Continue',
  errOwnSeed:
    "That seed doesn't look right. Paste your 24 recovery words or 64-hex seed exactly as written down.",
  errWords: 'Some words are wrong or missing. Check all 24 words are spelled correctly.',
  errSaveWallet: 'This phone could not save your wallet, so it was not created yet. Tap Continue again to retry. If it keeps failing, free up phone storage.',

  recoverySaved: {
    stamp: 'Recovery saved',
    line: 'Only these words can bring your wallet back.',
  },

  backup: {
    ...copyWordsEn,
    title: 'Back up your wallet',
    warning:
      "Write down these 24 words and store them safely. They are the ONLY way to recover your wallet if you lose this device — there is no dpay account, and not even dpay can recover them.",
    copyWordsHint: 'Copies all 24 words without the position numbers',
    ack: "I've written down all 24 words",
  },

  restore: {
    phraseLabel: 'Recovery phrase',
    phrasePlaceholder: 'Enter your 24 recovery words',
    phraseNote: 'One seed recovers both your IC and Solana funds.',
    seedLabel: 'Recovery seed',
    seedPlaceholder: '64 hex characters',
    seedHint: 'The 64-hex seed shown by Backup',
    seedNote: 'One seed recovers both your IC and Solana funds.',
    enterHex: 'Enter hex instead',
    enterWords: 'Enter words instead',
    action: 'Restore wallet',
    busy: 'Restoring…',
    cancelA11y: 'Cancel restore',
    cancelHint: 'Go back to creating a new wallet',
    entryHint: 'Recover a wallet from your backup',
  },

  usernameLabel: 'Choose a username',
  usernamePlaceholder: 'e.g. Alice',
  usernameA11y: 'Username',
  usernameHint: 'The name others see when you request or receive a payment',

  ownSeed: {
    useOwn: 'Use my own seed instead',
    useRandom: 'Generate a random seed instead',
    toggleHint: 'Paste the seed of an existing wallet instead of generating one',
    placeholder: 'Your 24 words or 64-hex seed',
    a11y: 'Own seed',
    hint: 'Optional: the seed to build this wallet from',
    note: 'Leave empty to generate a fresh random seed.',
  },

  create: {
    action: 'Create wallet',
    busy: 'Creating…',
  },

  demoNote: 'Creating a wallet does not deposit, buy, or move any money.',
  demoGlyphNote: ' is practice money with no cash value — ∂1 is just one DEMO unit.',
};
