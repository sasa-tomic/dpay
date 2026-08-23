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
 *
 * Trip Ready J2B (same day) extends the source: REHEARSAL_STEPS (+ punchline) is the
 * 3-beat first-create payment rehearsal (Rehearsal.tsx) and COACHING_TIPS is the
 * one-time contextual coaching copy (CoachTip.tsx), keyed by surface. Same rule:
 * phrased once, here, rendered verbatim, pinned by __tests__/education.test.ts.
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

/**
 * Trip Ready J3 — the payment REHEARSAL: a 3-beat storyboard of one honest payment
 * (request → approve → settle) shown once after the recovery backup on first create.
 * Each step must stay truthful for BOTH rails (IC + SOL): the shop asks for an exact
 * asset+amount, the payer reviews and approves with their own key, and the shop's own
 * connection settles — the payer's phone never needs signal for steps 2 and 3.
 */
export type RehearsalVisual = 'shopRequest' | 'payerReview' | 'shopSettles';
/** The one-page rehearsal's title line (mounting the page IS seeing the flow). */
export const REHEARSAL_TITLE = 'One honest payment';
export type RehearsalStep = {id: 'request' | 'approve' | 'settle'; title: string; body: string; visual: RehearsalVisual};
export const REHEARSAL_STEPS: readonly RehearsalStep[] = [
  {
    id: 'request',
    title: 'The shop requests',
    body: "The shop picks an exact asset and amount — its terminal turns that into a request code.",
    visual: 'shopRequest',
  },
  {
    id: 'approve',
    title: 'You review and approve',
    body: "Your phone shows exactly what you're paying. Nothing moves until you approve it with your key.",
    visual: 'payerReview',
  },
  {
    id: 'settle',
    title: 'The shop settles',
    body: "The shop's own connection sends the payment — confirmed in seconds on its screen.",
    visual: 'shopSettles',
  },
];
/** The rehearsal's closing line — the comprehension pin: approval + handoff need no signal. */
export const REHEARSAL_PUNCHLINE = "That's it. Your phone can be offline for approval and handoff.";

/**
 * Trip Ready J4 — contextual first-use coaching. One small dismissible tip, anchored to
 * the surface where its truth applies, shown only until dismissed (journey `seen`
 * markers). Copy rules: ≤2 sentences, plain, and each tip names its one right truth —
 * never a generic "tip", never a celebration.
 */
export type CoachTipKey = 'payReview' | 'receiveRequest' | 'offlineQr' | 'pendingOutcome';
export type CoachTip = {key: CoachTipKey; title: string; body: string};
export const COACHING_TIPS: Record<CoachTipKey, CoachTip> = {
  payReview: {
    key: 'payReview',
    title: 'You approve the exact payment',
    body: 'Approving sends exactly this amount of this asset — from your balance, signed by your key.',
  },
  receiveRequest: {
    key: 'receiveRequest',
    title: 'Show your request code',
    body: "Show this code to your customer. Their phone scans it and approves; your connection confirms.",
  },
  offlineQr: {
    key: 'offlineQr',
    title: 'Signed — not settled',
    body: "No signal? This signed code is your proof of payment. The receiver's connection settles it — status updates when you're back.",
  },
  pendingOutcome: {
    key: 'pendingOutcome',
    title: 'Still pending',
    body: "Pending means the outcome isn't known yet. Never assume it succeeded — check back here.",
  },
};
