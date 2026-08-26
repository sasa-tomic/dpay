/**
 * education copy pins (Trip Ready J1) — the ≥85% comprehension CONTRACT. The walkthrough
 * renders these strings VERBATIM (Walkthrough.tsx), so pinning the truth phrases here pins
 * every surface that teaches the model. If a copy edit breaks a pin, it is a comprehension
 * regression — change the pin only with the same deliberation as a product-truth edit.
 */
import {rehearsalSteps, walkthroughScenes} from '../config/education';
import {M} from '../i18n';
import {describe, expect, test} from '@jest/globals';

describe('education copy (the comprehension contract)', () => {
  test('exactly three scenes with the spec ids/eyebrows', () => {
    expect(walkthroughScenes().map(s => s.id)).toEqual(['offline', 'key', 'exact']);
    expect(walkthroughScenes().map(s => s.eyebrow)).toEqual(['HOW DPAY PAYS', 'YOUR MONEY', 'NO SURPRISES']);
    expect(walkthroughScenes().map(s => s.visual)).toEqual(['offlineHandoff', 'keyOnDevice', 'exactlyOneAsset']);
  });

  test('scene 1 (offline): the SHOP\'s own connection sends the payment', () => {
    const body = walkthroughScenes()[0].body;
    // The measured truth: the payer's phone may be offline; the shop is NOT.
    expect(body).toMatch(/own internet connection/);
    expect(body).toMatch(/no signal/);
    // The banned claim — NEVER "nobody needs internet".
    expect(body.toLowerCase()).not.toMatch(/nobody needs internet|no one needs internet|without the internet/);
  });

  test('scene 2 (key): dpay cannot approve; there is no dpay account', () => {
    const body = walkthroughScenes()[1].body;
    expect(body).toMatch(/cannot approve a payment/);
    expect(body).toMatch(/no dpay account/);
    expect(body).toMatch(/holds no funds/);
  });

  test('scene 3 (exact): one exact asset; dpay never converts', () => {
    const body = walkthroughScenes()[2].body;
    expect(body).toMatch(/one exact asset/);
    expect(body).toMatch(/never converts/);
    expect(body).toMatch(/review the amount and approve/);
  });

  test('scene 2 does not duplicate the Onboarding form\'s custody line verbatim', () => {
    // The walkthrough says it first in full; the create form keeps its shorter line ("No account.
    // Your key never leaves this phone. Not even dpay can move your money." — commit 28ccd85).
    const onboardLine = 'Your key never leaves this phone';
    expect(walkthroughScenes()[1].body).not.toContain(onboardLine);
  });

  test('campaign line + settings entry strings', () => {
    expect(M.education.campaignLine).toBe("Signal? Don't need it.");
    expect(M.education.howItWorksTitle).toBe('How dpay works');
  });
});

describe('education copy (Trip Ready J2B — rehearsal + coaching)', () => {
  test('exactly three rehearsal steps with the spec ids/visuals', () => {
    expect(rehearsalSteps().map(s => s.id)).toEqual(['request', 'approve', 'settle']);
    expect(rehearsalSteps().map(s => s.visual)).toEqual(['shopRequest', 'payerReview', 'shopSettles']);
    expect(rehearsalSteps().map(s => s.title)).toEqual(['The shop requests', 'You review and approve', 'The shop settles']);
  });

  test('step 1 (request): the SHOP picks the exact asset + amount', () => {
    const body = rehearsalSteps()[0].body;
    expect(body).toMatch(/exact asset and amount/);
    expect(body).toMatch(/request code/);
  });

  test('step 2 (approve): the phone shows exactly what is paid; the user\'s key approves', () => {
    const body = rehearsalSteps()[1].body;
    expect(body).toMatch(/exactly what/);
    expect(body).toMatch(/your key/);
    // Never implies dpay approves or moves funds on the user's behalf.
    expect(body.toLowerCase()).not.toMatch(/dpay (approves|pays|sends)/);
  });

  test('step 3 (settle): the SHOP\'s own connection settles, fast', () => {
    const body = rehearsalSteps()[2].body;
    expect(body).toMatch(/shop's own connection/);
    expect(body).toMatch(/seconds/);
  });

  test('the punchline: approval + handoff work offline (the comprehension pin)', () => {
    expect(M.education.rehearsal.punchline).toBe("That's it. Your phone can be offline for approval and handoff.");
  });

  test('coaching tips: exactly the four spec surfaces, ≤2 sentences each', () => {
    expect(Object.keys(M.education.coachTips).sort()).toEqual(['offlineQr', 'payReview', 'pendingOutcome', 'receiveRequest']);
    for (const tip of Object.values(M.education.coachTips)) {
      expect(tip.title.length).toBeGreaterThan(0);
      // ≤2 sentences, but a one-or-two-word rhetorical opener ("No signal?") that leads into
      // the next clause doesn't count as its own sentence — it's a lead-in. True sentence
      // count = splits, minus 1 if the first fragment is a ≤3-word question/exclamation lead-in.
      const parts = tip.body.split(/(?<=[.!?])\s+/);
      const leadIn = parts.length > 1 && /^[A-Za-z ]{1,12}[?!]$/.test(parts[0]);
      expect(parts.length - (leadIn ? 1 : 0)).toBeLessThanOrEqual(2);
    }
  });

  test('each tip names its one right truth', () => {
    // payReview: the exact asset/amount truth + the user's own key.
    expect(M.education.coachTips.payReview.body).toMatch(/exactly this amount of this asset/);
    expect(M.education.coachTips.payReview.body).toMatch(/your key/);
    // receiveRequest: the RECEIVER's connection confirms.
    expect(M.education.coachTips.receiveRequest.body).toMatch(/your connection confirms/);
    // offlineQr: signed proof + the receiver's connection settles.
    expect(M.education.coachTips.offlineQr.body).toMatch(/proof of payment/);
    expect(M.education.coachTips.offlineQr.body).toMatch(/settles it/);
    // pendingOutcome: the outcome is NOT known yet — never assume success.
    expect(M.education.coachTips.pendingOutcome.body).toMatch(/isn't known yet/);
    expect(M.education.coachTips.pendingOutcome.body).toMatch(/assume/i);
  });

  test('coaching tips never claim certainty the rail cannot give', () => {
    // No tip implies a pending outcome succeeded, and none promises instant settlement.
    for (const tip of Object.values(M.education.coachTips)) {
      const lower = tip.body.toLowerCase();
      expect(lower).not.toMatch(/is (guaranteed|always instant)|will definitely|sent successfully/);
    }
  });
});
