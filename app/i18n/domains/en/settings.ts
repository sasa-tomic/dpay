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
  /** Web-only footer hint; the Esc key closes the sheet. */
  escToClose: string;

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
    showAsHexHint: string;
    showAsWords: string;
    showAsWordsA11y: string;
    showAsWordsHint: string;
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
    confirmHint: string;
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
    serverHint: string;
    apply: string;
    applyA11y: string;
    applyHint: string;
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
  escToClose: 'Press Esc to close',

  backup: {
    ...copyWordsEn,
    label: 'Backup',
    warning: 'This seed recovers BOTH your IC and Solana funds. Store it safely. Never share it.',
    copyWordsHint: 'Copies your 24 recovery words to the clipboard',
    copySeed: 'Copy seed',
    seedCopied: 'Seed copied',
    seedShared: 'Seed shared',
    copySeedHint: 'Copies your recovery seed to the clipboard',
    showAsHex: 'Show as hex',
    showAsHexA11y: 'Show seed as hex',
    showAsHexHint: 'Switches to the raw 64-hex recovery seed view',
    showAsWords: 'Show as words',
    showAsWordsA11y: 'Show seed as words',
    showAsWordsHint: 'Switches to the 24-word recovery phrase view',
    hide: 'Hide',
    hideA11y: 'Hide seed',
    reveal: 'Reveal seed',
    revealA11y: 'Reveal recovery seed',
    revealHint: 'Shows your seed on screen — anyone viewing your screen can copy it',
    cancelA11y: 'Cancel backup',
    action: 'Back up wallet',
    entry: 'Back up wallet…',
    entryHint: 'Reveals your recovery seed — backs up both your IC and Solana funds',
  },

  restore: {
    label: 'Restore',
    warning:
      "This replaces your current wallet with the one recovered from this seed. Back up your current wallet first if you haven't — its funds are only reachable via its own seed.",
    seedPlaceholder: '24 recovery words or 64 hex characters',
    seedA11y: 'Recovery seed',
    seedHint: 'Your 24 recovery words (or the 64-hex seed from Backup) that recover your wallet',
    action: 'Restore wallet',
    actionHint: 'Replaces your current wallet with the one recovered from this seed',
    busy: 'Restoring…',
    cancelA11y: 'Cancel restore',
    entry: 'Restore wallet…',
    entryHint: 'Import a wallet from your 64-hex recovery seed — replaces your current wallet',
    errEmpty: 'Enter your 24 recovery words or 64-hex seed.',
    errWords:
      'Some words are wrong or missing. Check you have all 24 words spelled correctly — or paste the 64-hex seed instead.',
  },

  reset: {
    label: 'Reset',
    warning:
      'This erases your wallet identity from this device. Funds at this address become irrecoverable. This cannot be undone.',
    confirm: 'Yes, reset everything',
    confirmHint: 'Permanently erase your wallet from this device — funds become irrecoverable',
    cancelA11y: 'Cancel reset',
    action: 'Reset wallet',
    entry: 'Reset wallet…',
    entryHint: 'Opens a confirmation dialog — permanently erases your wallet from this device',
  },

  learn: {
    label: 'Learn',
    passportHint: 'Shows your trip readiness passport — the four capability stamps',
    passportCount: filled => `${filled}/4`,
    howItWorksHint: 'Replays the three-scene walkthrough of how dpay pays',
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
    hint: "Server configuration for the wallet's relay",
    serverNote: 'The server your wallet talks to. Changes apply when you tap Apply.',
    serverLabel: 'Server',
    serverPlaceholder: 'http://<ip>:8787',
    serverHint: 'The server your wallet talks to',
    apply: 'Apply',
    applyA11y: 'Apply server URL',
    applyHint: 'Switch your wallet to the entered server URL',
  },

  about: {
    label: 'About',
    custody:
      'dpay is non-custodial. Your money is controlled only by the key on this device. There is no dpay account, and dpay cannot move, freeze, or recover your funds. Your 24 backup words are the only recovery.',
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

  /** The create path's post-backup beat: a passport stamp lands, then the rehearsal. */
  recoverySaved: {
    stamp: string;
    line: string;
    sub: string;
  };

  /** The BIP-39 backup gate — the words, the warning, and the acknowledgement. */
  backup: CopyWordsCopy & {
    title: string;
    /** The ownership line, above the warning. */
    ritual: string;
    warning: string;
    copyWordsHint: string;
    /** The checkbox's visible text AND its accessibilityLabel. */
    ack: string;
  };

  /** Recover an existing wallet: 24 words (default) or the 64-hex seed. */
  restore: {
    phraseLabel: string;
    phrasePlaceholder: string;
    phraseHint: string;
    phraseNote: string;
    seedLabel: string;
    seedPlaceholder: string;
    seedHint: string;
    seedNote: string;
    enterHex: string;
    enterWords: string;
    action: string;
    busy: string;
    hintMnemonic: string;
    hintHex: string;
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
    hint: string;
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
    "That seed doesn't look right. Paste your 24 recovery words or the 64-hex seed exactly as you wrote it down.",
  errWords: 'Some words are wrong or missing. Check you have all 24 words spelled correctly.',

  recoverySaved: {
    stamp: 'Recovery saved',
    line: 'Only these words can bring your wallet back.',
    sub: 'You have them. Nobody else does.',
  },

  backup: {
    ...copyWordsEn,
    title: 'Back up your wallet',
    ritual:
      'This is the moment your wallet becomes truly yours — only these words can bring your money back.',
    warning:
      "Write down these 24 words and store them safely. They're the ONLY way to recover your wallet if you lose this device. There is no dpay account to sign back into. Lose these words and this phone, and your money is gone. Not even we can recover it.",
    copyWordsHint: 'Copies all 24 recovery words to the clipboard, without the position numbers',
    ack: "I've written down all 24 words",
  },

  restore: {
    phraseLabel: 'Recovery phrase',
    phrasePlaceholder: 'Enter your 24 recovery words',
    phraseHint: 'The 24 recovery words from your backup',
    phraseNote: 'Enter the 24 words from your backup. One seed recovers both your IC and Solana funds.',
    seedLabel: 'Recovery seed',
    seedPlaceholder: '64 hex characters',
    seedHint: 'The 64-hex seed shown by Backup that recovers your wallet',
    seedNote: 'One seed recovers both your IC and Solana funds.',
    enterHex: 'Enter hex instead',
    enterWords: 'Enter words instead',
    action: 'Restore wallet',
    busy: 'Restoring…',
    hintMnemonic: 'Recover your wallet from your 24 recovery words',
    hintHex: 'Recover your wallet from the recovery seed',
    cancelA11y: 'Cancel restore',
    cancelHint: 'Go back to creating a new wallet',
    entryHint: 'Recover a wallet from your 24-word recovery phrase',
  },

  usernameLabel: 'Choose a username',
  usernamePlaceholder: 'e.g. Alice',
  usernameA11y: 'Username',
  usernameHint: 'The name others see when you request or receive a payment',

  ownSeed: {
    useOwn: 'Use my own seed instead',
    useRandom: 'Generate a random seed instead',
    toggleHint:
      'Show a field to paste the 24 recovery words or 64-hex seed of an existing wallet, instead of generating a fresh one',
    placeholder: 'Your 24 words or 64-hex seed',
    a11y: 'Own seed',
    hint: 'Optional: the 24 recovery words or 64-hex seed to build this wallet from, instead of a new random one',
    note: 'Leave empty to generate a fresh random seed.',
  },

  create: {
    action: 'Create wallet',
    busy: 'Creating…',
    hint: 'Create a wallet key on this device; no deposit or purchase is required',
  },

  demoNote: 'Creating a wallet does not deposit, buy, or move any money.',
  demoGlyphNote: ' is practice money with no cash value — ∂1 is just one DEMO unit.',
};
