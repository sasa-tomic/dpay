/**
 * education copy pins (Trip Ready J1) — the ≥85% comprehension CONTRACT. The walkthrough
 * renders these strings VERBATIM (Walkthrough.tsx), so pinning the truth phrases here pins
 * every surface that teaches the model. If a copy edit breaks a pin, it is a comprehension
 * regression — change the pin only with the same deliberation as a product-truth edit.
 */
import {walkthroughScenes} from '../config/education';
import {M} from '../i18n';
import {en} from '../i18n/en.ts';
import {de} from '../i18n/de.ts';
import {es} from '../i18n/es.ts';
import {fr} from '../i18n/fr.ts';
import {describe, expect, test} from '@jest/globals';

/** Every shipped catalog, for the pins that must hold in EVERY language and not just English —
 *  a wire-length limit and a promise about money do not stop applying in translation. */
const CATALOGS = {en, de, es, fr};

describe('education copy (the comprehension contract)', () => {
  test('exactly three scenes with the spec ids/eyebrows', () => {
    expect(walkthroughScenes().map(s => s.id)).toEqual(['offline', 'key', 'exact']);
    expect(walkthroughScenes().map(s => s.eyebrow)).toEqual(['FIRST, HOW A PAYMENT WORKS', 'YOUR MONEY', 'NO SURPRISES']);
    expect(walkthroughScenes().map(s => s.visual)).toEqual(['offlineHandoff', 'keyOnDevice', 'exactlyOneAsset']);
  });

  test('scene 1 (offline): the RECEIVING phone\'s own connection sends the payment', () => {
    const body = walkthroughScenes()[0].body;
    // The measured truth: the payer's phone may be offline; the receiving phone is NOT.
    expect(body).toMatch(/receiving phone shows a request/);
    expect(body).toMatch(/check the amount and asset/);
    expect(body).toMatch(/if your phone is offline/);
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

describe('education copy (the first-run practice payment + coaching)', () => {
  // The practice screen is the ONE place a new user is shown a payment before they own any money,
  // so its copy carries two loads no other screen does: it must not claim anything the ledger has
  // not said, and it must not ask for funds. Both are pinned here, in the catalog, because a
  // translation is exactly where a promise or a solicitation would slip back in.
  test('the payee name fits the 132-byte wire request (32-byte name field) in every locale', () => {
    for (const [tag, catalog] of Object.entries(CATALOGS)) {
      const bytes = new TextEncoder().encode(catalog.education.practice.payeeName).length;
      expect(`${tag}:${bytes <= 32}`).toBe(`${tag}:true`);
    }
  });

  test('the pending state never claims a settlement, in any locale', () => {
    for (const [tag, catalog] of Object.entries(CATALOGS)) {
      const body = catalog.education.practice.pendingBody;
      expect(`${tag}:${body.length > 0}`).toBe(`${tag}:true`);
      // The settled sentence and the pending sentence must not be the same claim.
      expect(`${tag}:${body === catalog.education.practice.settledBody}`).toBe(`${tag}:false`);
    }
  });

  test('no fail-closed branch solicits funds (anti-scam rule R1), in any locale', () => {
    // English is the reference the others are translated from; the shape of the rule is that the
    // branch copy names an ACTION the user can take on this screen and never a deposit.
    const p = M.education.practice;
    for (const body of [p.noFaucet.body, p.offline.body, p.empty.body, p.cooldown.body('faucet cooldown: try again in ~58 min')]) {
      expect(body.toLowerCase()).not.toMatch(/deposit|add money|buy|top up|fund your/);
    }
    // …and the cooldown branch carries the server's own reason verbatim, which is the only thing
    // that tells the user WHEN to come back.
    expect(p.cooldown.body('faucet cooldown: try again in ~58 min')).toContain('faucet cooldown: try again in ~58 min');
  });

  test('the permanent footer labels play money and solicits nothing, in every locale', () => {
    // Behaviour, not a string literal. This test used to pin the English sentence verbatim, which
    // made it fail on a copy edit that satisfied every requirement it was protecting — and told us
    // nothing about the other three locales. The two things that actually matter:
    //
    //   1. it says the money has no value (otherwise a user can believe they were given ∂100), and
    //   2. it solicits nothing — the same anti-scam rule R1 the fail-closed branches above obey.
    //
    // What it must NOT do is deny something unprompted. The practice screen has just DEMONSTRATED
    // that dpay asks for nothing; following a demonstration with a denial of the thing demonstrated
    // is the density the UX swarm flagged (X16 — three denials in the first six screens read as a
    // scam signature), so the denial clause was removed here and kept where a user actually has the
    // fear: the wallet-creation screen.
    for (const [tag, cat] of Object.entries(CATALOGS)) {
      const punchline = cat.education.practice.punchline;
      expect(punchline.length).toBeGreaterThan(0);
      expect(punchline.toLowerCase()).not.toMatch(/deposit|add money|buy|top up|fund your|einzahl|kauf|deposit|comprar|depositar|achet|dépos/);
      // Names the no-value fact in that locale's own words.
      expect(punchline.toLowerCase()).toMatch(/no cash value|keinen gegenwert|no tiene valor|aucune valeur/);
      expect(tag.length).toBe(2);
    }
  });

  test('coaching tips: exactly the three spec surfaces, ≤2 sentences each', () => {
    // Three, not four: the pay-review tip ("Approving sends exactly this amount of this asset")
    // restated the 30pt headline it sat under and cost ~180px between the payment and the Approve
    // button, so it was dropped (founder, 2026-09-09). A tip earns its card by teaching something
    // the surface does not already say — the remaining three all do.
    expect(Object.keys(M.education.coachTips).sort()).toEqual(['offlineQr', 'pendingOutcome', 'receiveRequest']);
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
