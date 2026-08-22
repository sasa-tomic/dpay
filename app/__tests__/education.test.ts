/**
 * education copy pins (Trip Ready J1) — the ≥85% comprehension CONTRACT. The walkthrough
 * renders these strings VERBATIM (Walkthrough.tsx), so pinning the truth phrases here pins
 * every surface that teaches the model. If a copy edit breaks a pin, it is a comprehension
 * regression — change the pin only with the same deliberation as a product-truth edit.
 */
import {CAMPAIGN_LINE, JourneyHowItWorksTitle, WALKTHROUGH_SCENES} from '../config/education';
import {describe, expect, test} from '@jest/globals';

describe('education copy (the comprehension contract)', () => {
  test('exactly three scenes with the spec ids/eyebrows', () => {
    expect(WALKTHROUGH_SCENES.map(s => s.id)).toEqual(['offline', 'key', 'exact']);
    expect(WALKTHROUGH_SCENES.map(s => s.eyebrow)).toEqual(['HOW DPAY PAYS', 'YOUR MONEY', 'NO SURPRISES']);
    expect(WALKTHROUGH_SCENES.map(s => s.visual)).toEqual(['offlineHandoff', 'keyOnDevice', 'exactlyOneAsset']);
  });

  test('scene 1 (offline): the SHOP\'s own connection sends the payment', () => {
    const body = WALKTHROUGH_SCENES[0].body;
    // The measured truth: the payer's phone may be offline; the shop is NOT.
    expect(body).toMatch(/own internet connection/);
    expect(body).toMatch(/no signal/);
    // The banned claim — NEVER "nobody needs internet".
    expect(body.toLowerCase()).not.toMatch(/nobody needs internet|no one needs internet|without the internet/);
  });

  test('scene 2 (key): dpay cannot approve; there is no dpay account', () => {
    const body = WALKTHROUGH_SCENES[1].body;
    expect(body).toMatch(/cannot approve a payment/);
    expect(body).toMatch(/no dpay account/);
    expect(body).toMatch(/holds no funds/);
  });

  test('scene 3 (exact): one exact asset; dpay never converts', () => {
    const body = WALKTHROUGH_SCENES[2].body;
    expect(body).toMatch(/one exact asset/);
    expect(body).toMatch(/never converts/);
    expect(body).toMatch(/review the amount and approve/);
  });

  test('scene 2 does not duplicate the Onboarding form\'s custody line verbatim', () => {
    // The walkthrough says it first in full; the create form keeps its shorter line ("No account.
    // Your key never leaves this phone. Not even dpay can move your money." — commit 28ccd85).
    const onboardLine = 'Your key never leaves this phone';
    expect(WALKTHROUGH_SCENES[1].body).not.toContain(onboardLine);
  });

  test('campaign line + settings entry strings', () => {
    expect(CAMPAIGN_LINE).toBe('Roaming off. Payment on.');
    expect(JourneyHowItWorksTitle).toBe('How dpay works');
  });
});
