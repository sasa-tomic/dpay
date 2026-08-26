/**
 * education.ts — the STRUCTURE of the education surfaces: scene/step ids, illustration keys, and
 * display ORDER. The words themselves live in the message catalog (`M.education`, defined in
 * i18n/domains/wallet.ts) — this module composes them into the shapes every consumer already
 * imports, so `WALKTHROUGH_SCENES`/`REHEARSAL_STEPS`/`COACHING_TIPS`/`CAMPAIGN_LINE` keep working
 * unchanged (jest pins in `__tests__/education.test.ts`, e2e flow 90, and
 * `crates/dpay-relay/assets/landing.html`, which single-sources CAMPAIGN_LINE).
 *
 * The comprehension CONTRACT is unchanged and still enforced by `__tests__/education.test.ts` —
 * the three product truths are phrased once, in the catalog, and never paraphrased elsewhere:
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
import {M} from '../i18n/index.ts';

/** The campaign line — the promise in four words. Rendered as the walkthrough send-off. */
export const CAMPAIGN_LINE = M.education.campaignLine;

/** Illustration keys the Walkthrough maps to its animated scenes (no emoji, no stock art). */
export type WalkthroughVisual = 'offlineHandoff' | 'keyOnDevice' | 'exactlyOneAsset';

/** The three scene ids — the catalog keys its scene copy by these. */
export type WalkthroughSceneId = 'offline' | 'key' | 'exact';

export type WalkthroughScene = {
  id: WalkthroughSceneId;
  eyebrow: string;
  title: string;
  body: string;
  visual: WalkthroughVisual;
};

/** Exactly three scenes — the whole model in one minute (spec Journey 1). */
export const WALKTHROUGH_SCENES: readonly WalkthroughScene[] = [
  {id: 'offline', visual: 'offlineHandoff', ...M.education.walkthrough.scenes.offline},
  {id: 'key', visual: 'keyOnDevice', ...M.education.walkthrough.scenes.key},
  {id: 'exact', visual: 'exactlyOneAsset', ...M.education.walkthrough.scenes.exact},
];

/** Settings replay entry (SettingsSheet → "How dpay works") + the replay Modal's title. */
export const JourneyHowItWorksTitle = M.education.howItWorksTitle;

/**
 * Trip Ready J3 — the payment REHEARSAL: a 3-beat storyboard of one honest payment
 * (request → approve → settle) shown once after the recovery backup on first create.
 * Each step must stay truthful for BOTH rails (IC + SOL): the shop asks for an exact
 * asset+amount, the payer reviews and approves with their own key, and the shop's own
 * connection settles — the payer's phone never needs signal for steps 2 and 3.
 */
export type RehearsalVisual = 'shopRequest' | 'payerReview' | 'shopSettles';
/** The one-page rehearsal's title line (mounting the page IS seeing the flow). */
export const REHEARSAL_TITLE = M.education.rehearsal.title;
/** The three beat ids — the catalog keys its step copy by these. */
export type RehearsalStepId = 'request' | 'approve' | 'settle';
export type RehearsalStep = {id: RehearsalStepId; title: string; body: string; visual: RehearsalVisual};
export const REHEARSAL_STEPS: readonly RehearsalStep[] = [
  {id: 'request', visual: 'shopRequest', ...M.education.rehearsal.steps.request},
  {id: 'approve', visual: 'payerReview', ...M.education.rehearsal.steps.approve},
  {id: 'settle', visual: 'shopSettles', ...M.education.rehearsal.steps.settle},
];
/** The rehearsal's closing line — the comprehension pin: approval + handoff need no signal. */
export const REHEARSAL_PUNCHLINE = M.education.rehearsal.punchline;

/**
 * Trip Ready J4 — contextual first-use coaching. One small dismissible tip, anchored to
 * the surface where its truth applies, shown only until dismissed (journey `seen`
 * markers). Copy rules: ≤2 sentences, plain, and each tip names its one right truth —
 * never a generic "tip", never a celebration.
 */
export type CoachTipKey = 'payReview' | 'receiveRequest' | 'offlineQr' | 'pendingOutcome';
export type CoachTip = {key: CoachTipKey; title: string; body: string};
export const COACHING_TIPS: Record<CoachTipKey, CoachTip> = {
  payReview: {key: 'payReview', ...M.education.coachTips.payReview},
  receiveRequest: {key: 'receiveRequest', ...M.education.coachTips.receiveRequest},
  offlineQr: {key: 'offlineQr', ...M.education.coachTips.offlineQr},
  pendingOutcome: {key: 'pendingOutcome', ...M.education.coachTips.pendingOutcome},
};
