/**
 * education.ts — THE single education-copy source (Trip Ready Wave 1A, 2026-08-22).
 *
 * Every surface that teaches the dpay model reads from here: the first-run
 * walkthrough (Walkthrough.tsx) renders WALKTHROUGH_SCENES verbatim, and the
 * Settings replay renders the same scenes. The jest pins in
 * `__tests__/education.test.ts` are the ≥85% comprehension CONTRACT — the three
 * product truths are phrased once, here, and never paraphrased elsewhere:
 *
 *   1. The payer's phone may be offline, but the SHOP sends the payment on its own
 *      internet connection. NEVER claim "nobody needs internet".
 *   2. The key stays on the device; dpay holds no funds, cannot approve a payment,
 *      and there is no dpay account.
 *   3. The shop asks for one exact asset; you review and approve; dpay never
 *      converts another balance.
 *
 * Scene 2 deliberately does NOT duplicate the Onboarding form's custody line
 * (commit 28ccd85) verbatim — the walkthrough says it first in full, the create
 * form keeps its shorter line, and Settings' About keeps the custody statement.
 */

/** The campaign line — the promise in five words. Rendered as the walkthrough send-off. */
export const CAMPAIGN_LINE = 'Roaming off. Payment on.';

/** Illustration keys the Walkthrough maps to its animated scenes (no emoji, no stock art). */
export type WalkthroughVisual = 'offlineHandoff' | 'keyOnDevice' | 'exactlyOneAsset';

export type WalkthroughScene = {
  id: 'offline' | 'key' | 'exact';
  eyebrow: string;
  title: string;
  body: string;
  visual: WalkthroughVisual;
};

/** Exactly three scenes — the whole model in one minute (spec Journey 1). */
export const WALKTHROUGH_SCENES: readonly WalkthroughScene[] = [
  {
    id: 'offline',
    eyebrow: 'HOW DPAY PAYS',
    title: 'Pay without signal',
    body: 'Your phone can pay with no signal at all. The shop sends the payment for you, using its own internet connection.',
    visual: 'offlineHandoff',
  },
  {
    id: 'key',
    eyebrow: 'YOUR MONEY',
    title: 'Your key stays on this device',
    body: 'dpay holds no funds and cannot approve a payment for you. There is no dpay account — only your key.',
    visual: 'keyOnDevice',
  },
  {
    id: 'exact',
    eyebrow: 'NO SURPRISES',
    title: 'Pay the exact requested asset',
    body: 'The shop asks for one exact asset. You review the amount and approve. dpay never converts another balance.',
    visual: 'exactlyOneAsset',
  },
] as const;

/** Settings replay entry (SettingsSheet → "How dpay works") + the replay Modal's title. */
export const JourneyHowItWorksTitle = 'How dpay works';
