/**
 * education.ts — the STRUCTURE of the education surfaces: scene/step ids, illustration keys, and
 * display ORDER. The words themselves live in the message catalog (`M.education`, defined in
 * i18n/domains/en/wallet.ts) — this module composes them into the shapes their surfaces render
 * (jest pins in `__tests__/education.test.ts`, e2e flow 90, and `crates/dpay-relay/assets/
 * landing.html`, which single-sources the campaign line from the catalog).
 *
 * Every export here is a FUNCTION, and deliberately so. A module-level constant would evaluate
 * `M.education.…` once, at import time; a runtime locale switch replaces `M`'s nested objects
 * wholesale (`Object.assign(M, catalog)` — the same in-place trick `applyPalette` uses for S/C),
 * so a captured composition would render the old language forever after a switch. Composing per
 * call puts these reads on exactly the same footing as the inline `M.some.key` reads in every
 * component: read during render, always current.
 *
 * Single-key copy is NOT wrapped here. A named alias for one catalog key is indirection without
 * value — call sites read `M.education.campaignLine` / `.howItWorksTitle` / `.rehearsal.title` /
 * `.rehearsal.punchline` / `.coachTips[key]` directly. Only genuine COMPOSITION (structure the
 * catalog does not own, merged with copy) earns a function below.
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

/** Exactly three scenes — the whole model in one minute (spec Journey 1).
 *  The id/visual/order table and the copy stay merged in one literal rather than split into a
 *  locale-independent table plus a merge step: at three rows the table IS the readable artifact
 *  (each scene is one line, structure and words side by side), and the split would cost two
 *  tables and a zip to say the same thing. */
export function walkthroughScenes(): readonly WalkthroughScene[] {
  return [
    {id: 'offline', visual: 'offlineHandoff', ...M.education.walkthrough.scenes.offline},
    {id: 'key', visual: 'keyOnDevice', ...M.education.walkthrough.scenes.key},
    {id: 'exact', visual: 'exactlyOneAsset', ...M.education.walkthrough.scenes.exact},
  ];
}

/**
 * Trip Ready J3 — the payment REHEARSAL, reframed 2026-09-07 as a concrete two-phone DEMO
 * practice guide (request → scan/approve → switch roles), shown once after the recovery
 * backup on first create. It is guidance, not a simulation: it never claims a transfer
 * happened or that the app funded the wallet, and DEMO is named as valueless practice
 * money. The offline-settlement truth itself lives in walkthrough scene 1.
 */
export type RehearsalVisual = 'shopRequest' | 'payerReview' | 'shopSettles';
/** The three beat ids — the catalog keys its step copy by these. */
export type RehearsalStepId = 'request' | 'approve' | 'settle';
export type RehearsalStep = {id: RehearsalStepId; title: string; body: string; visual: RehearsalVisual};
/** The three beats in display order (same one-literal reasoning as `walkthroughScenes`). */
export function rehearsalSteps(): readonly RehearsalStep[] {
  return [
    {id: 'request', visual: 'shopRequest', ...M.education.rehearsal.steps.request},
    {id: 'approve', visual: 'payerReview', ...M.education.rehearsal.steps.approve},
    {id: 'settle', visual: 'shopSettles', ...M.education.rehearsal.steps.settle},
  ];
}

/**
 * Trip Ready J4 — contextual first-use coaching. One small dismissible tip, anchored to
 * the surface where its truth applies, shown only until dismissed (journey `seen`
 * markers). Copy rules: ≤2 sentences, plain, and each tip names its one right truth —
 * never a generic "tip", never a celebration.
 *
 * Only the KEY set lives here (it is the surface id CoachTip.tsx maps to a glyph, and the
 * `seen` marker journey.ts stores); the words are read straight from `M.education.coachTips`.
 */
export type CoachTipKey = 'payReview' | 'receiveRequest' | 'offlineQr' | 'pendingOutcome';
