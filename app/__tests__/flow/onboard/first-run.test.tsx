/**
 * Flows 154 + 155 — first-run honesty — the jest twins of `e2e/tests/154-first-run-no-solicitation.mjs`
 * and `155-first-run-backup-resume.mjs`.
 *
 * 154: over a relay that hands out nothing, five first-run surfaces (walkthrough, create form,
 *      backup gate, practice's no-faucet branch, currency chooser) solicit nothing, the wallet
 *      lands on no unprompted panel, and the positive control holds: Home DOES offer Add money,
 *      as a choice.
 * 155: the backup gate is the wallet's creation point — no identity is written while the words are
 *      unacknowledged, a kill (remount) lands back on the SAME 24 words, and only the
 *      acknowledgement writes the identity and clears the pending record.
 *
 * 154 runs against the file's OWN faucet-less relay (`hermeticFlow({relay: {faucet: false}})` —
 * `GET /api/v1/capabilities` reports demo_faucet:false off the relay's real knob), so the
 * no-faucet branch comes from the app's real capability logic over a genuinely faucet-less
 * server.
 */
import {describe, it, expect} from '@jest/globals';
import {mountApp} from '../harness/mount';
import {
  assertIncludes, chooseHomeCurrencyIfPresent, skipWalkthroughIfPresent,
  waitForEnabled, waitForWallet, WALLET_READY,
} from '../harness/lib';
import {hermeticDescribe, hermeticFlow} from '../harness/hermetic';

hermeticFlow({relay: {faucet: false}});

/** Everything that would count as asking a first-run user for money, per surface. */
const SOLICITATIONS = [
  'deposit-address', 'pay-fund', 'pay-fund-go',
  'btn-topup', 'btn-home-add-funds', 'btn-receive-address',
];
/** The subset that is a SOLICITATION wherever it appears. */
const UNPROMPTED = ['deposit-address', 'pay-fund', 'pay-fund-go'];

function assertAbsent(m: {isPresent: (id: string) => boolean}, ids: string[], where: string): void {
  for (const id of ids) {
    expect({where, id, present: m.isPresent(id)}).toEqual({where, id, present: false});
  }
}
const assertNoSolicitation = (m: {isPresent: (id: string) => boolean}, where: string): void =>
  assertAbsent(m, SOLICITATIONS, where);

async function readWords(m: {readText: (id: string) => string}): Promise<string[]> {
  const words: string[] = [];
  for (let i = 0; i < 24; i++) {
    words.push(m.readText(`mnemonic-word-${i}`).replace(/^\d+\s*/, '').trim());
  }
  return words;
}

hermeticDescribe('flow 154 — first-run-no-solicitation', () => {
  it('five first-run surfaces solicit nothing; the wallet lands on no panel; Add funds stays one deliberate tap away', async () => {
    const m = await mountApp();

    // 1. The walkthrough.
    await m.driver.findByTestID('walkthrough', {timeoutMs: 10_000});
    assertNoSolicitation(m.driver, 'walkthrough');
    await skipWalkthroughIfPresent(m);

    // 2. The create form.
    await m.driver.findByTestID('btn-create', {timeoutMs: 8000});
    assertNoSolicitation(m.driver, 'create form');
    await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-nosolicit', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});

    // 3. The backup gate.
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    assertNoSolicitation(m.driver, 'backup gate');
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});

    // 4. Practice, on its no-faucet branch — the screen with the strongest excuse to ask, and it
    //    must not. It says the server hands out none, explains itself in the user's terms, and
    //    offers the way on — but NO primary action at all.
    await m.driver.findByTestID('practice', {timeoutMs: 15_000});
    await m.driver.findByTestID('practice-nofaucet', {timeoutMs: 15_000});
    assertNoSolicitation(m.driver, 'practice (no faucet)');
    expect(m.driver.isPresent('practice-nofaucet-go')).toBe(false);
    assertIncludes(m.driver.readText('practice-nofaucet').toLowerCase(), 'practice money',
      'and it must still explain itself in the user\'s terms');
    expect(m.driver.isPresent('btn-practice-continue')).toBe(true);
    await m.driver.click('btn-practice-continue', {timeoutMs: 5000});

    // 5. The currency chooser — the first thing the app asks for, and it asks for a choice, not money.
    await m.driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    assertNoSolicitation(m.driver, 'currency chooser');
    await chooseHomeCurrencyIfPresent(m);

    // 6. The wallet itself, landing on Home. Nothing is STANDING there asking — no address, no
    //    fund panel — on a wallet the app has just failed to fund.
    await waitForWallet(m, {timeoutMs: 10_000});
    assertAbsent(m.driver, UNPROMPTED, 'the wallet\'s landing screen');

    // POSITIVE CONTROL. Funding is one deliberate tap away — without this check the flow would
    // pass on a build that had simply lost the ability to fund anything.
    await m.driver.findByTestID('btn-home-add-funds', {timeoutMs: 8000});

    await m.unmount();
  }, 90_000);
});

hermeticDescribe('flow 155 — first-run-backup-resume', () => {
  it('no identity while the words are unacknowledged; a kill re-lands on the SAME 24 words; only the acknowledgement writes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {getItem: (k: string) => Promise<string | null>};
    const m = await mountApp();

    await skipWalkthroughIfPresent(m);
    await m.driver.typeByPlaceholder('e.g. Alice', 'e2e-resume', {timeoutMs: 8000});
    await m.driver.click('btn-create', {timeoutMs: 4000});
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 8000});
    const before = await readWords(m.driver);
    expect(before.every((w) => w.length > 0)).toBe(true);

    // The wallet does not exist yet — it is PENDING. That is the whole mechanism.
    expect(await AsyncStorage.getItem('dpay.identity.v1')).toBeNull();
    expect(await AsyncStorage.getItem('dpay.identity.pending.v1')).not.toBeNull();

    // THE KILL. A remount is exactly what the phone dying does: every in-memory machine is gone
    // and only what was persisted survives.
    await m.remount();

    // 1 + 2: back ON the gate, with the same words.
    await m.driver.findByTestID('mnemonic-backup', {timeoutMs: 10_000});
    expect(m.driver.isPresent(WALLET_READY)).toBe(false);
    expect(m.driver.isPresent('practice')).toBe(false);
    expect(m.driver.isPresent('btn-create')).toBe(false);
    const after = await readWords(m.driver);
    expect(after.join(' ')).toBe(before.join(' '));
    // 3: still nothing written, so a second kill lands here too.
    expect(await AsyncStorage.getItem('dpay.identity.v1')).toBeNull();

    // Only the acknowledgement creates the wallet.
    await m.driver.click('mnemonic-backup-checkbox', {timeoutMs: 4000});
    await waitForEnabled(m, 'btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.click('btn-mnemonic-continue', {timeoutMs: 4000});
    await m.driver.findByTestID('practice', {timeoutMs: 15_000});
    const persisted = JSON.parse((await AsyncStorage.getItem('dpay.identity.v1')) ?? 'null') as {publicHex?: string} | null;
    expect(persisted && typeof persisted.publicHex === 'string' && persisted.publicHex.length === 64).toBe(true);
    expect(await AsyncStorage.getItem('dpay.identity.pending.v1')).toBeNull();

    await m.unmount();
  }, 90_000);
});
