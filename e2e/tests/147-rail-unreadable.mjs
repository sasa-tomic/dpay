// Flow 147 — a balance the wallet cannot READ says so, on the row, in the running app — and since
// R3 it says WHY, because the three ways a read can produce no fact are three different facts
// about the world (spec 2026-09-09-relay-ha-and-solana-proxy §"What the app says when the relay is
// down and the phone is not": three states, never collapsed into one), classified at the transport
// seam (`SolanaReadFailure` in app/solana.ts) and never guessed at the component:
//   * REFUSED — the endpoint ANSWERED and did not serve us (the measured case: the baked Helius
//     key's HTTP 429, "max usage reached", observed 2026-09-08). The rail is down, the phone is
//     online: the line names the network, states nothing moved, and that dpay keeps retrying on
//     its own (no button is promised that nothing implements — against a rate limit an extra
//     manual read is the cause, not the cure).
//   * UNREACHABLE — the rail's path is down WHILE THE PHONE IS ONLINE. The blame lands on dpay's
//     side — since the R2 cutover the Solana path IS dpay's relay, and the line says so: it names
//     the cause, states the money is untouched, names what still works (Internet Computer PAYMENTS
//     — signed envelopes go straight to icp-api.io; balance reads do go through the relay, so
//     balances are NOT claimed) and that payments can still be SIGNED offline (their later
//     broadcast still needs a rail — never implied otherwise), and gives the escape — Settings ▸
//     Advanced points the wallet at any Solana endpoint, removing dpay's choice from the path
//     entirely.
//   * OFFLINE — nothing answered anywhere, the IC boundary probe included. The wallet cannot
//     see that far, so the line names NO cause and offers NO escape: it states the observation
//     (the phone seems offline), the money fact, the automatic recovery, and that QR payments
//     still work offline.
// The refusal is branded (`dpayEndpointRefused`, app/solana/errors.ts) and wins before the oracle
// runs; transport failures are split by `__DPAY_TEST_SOLANA_CONNECTIVITY` — the hermetic test
// override this flow injects per stage, so no stage's answer depends on a live probe. (The real
// oracle probes the IC boundary ORIGIN — icp-api.io, or `__DPAY_TEST_IC_GATEWAY` where the
// harness redirects IC traffic — never the relay.)
//
// Plus the properties this flow already owned: one network's outage is ONE line no matter how many
// accounts that network carries (X9 — it used to be repeated verbatim on every affected account);
// the IC rows on the same screen stay silent (the failure is scoped to the rail that failed); and
// (2026-09-08, M2) the LANDING SCREEN says it too — home=EUR's preferred rail is EURC·Solana, so
// the home rail IS the rail that fails, and the landing screen states the SAME sentence the
// accounts route stated (one fact, one owner).
//
// Selector contract: `balance` (the header chip that opens the accounts route), `asset-sol`,
// `rail-unreadable-solana`, `asset-vchf`, `home-headline-amount`, `tab-home`.
import {
  setup, assert, assertIncludes, onboardWallet, openBalances,
  skipWalkthroughIfPresent, skipPracticeIfPresent, waitForEnabled,
} from '../harness/lib.mjs';

export const meta = {
  id: '147',
  name: 'rail-unreadable',
  journey: 'system',
  covers: ['solana', 'balances', 'home', 'rpc-error', 'honest-copy', 'fail-closed', 'offline-classification', 'escape-hatch'],
  verifies: 'An unreadable rail says WHY, in ONE line for the network, and the three causes never collapse (R3): an endpoint that answered and refused (HTTP 429) is told apart from a rail path that is down while the phone is online, and from a phone with no connectivity at all — refused names the network, says nothing moved, and that dpay keeps retrying; unreachable names dpay\'s relay as the cause, says the money is untouched, names what still works (Internet Computer payments; payments can still be signed offline) and gives the Settings ▸ Advanced escape, made actionable by tapping the note (Settings opens with the Advanced disclosure expanded); offline names no cause and no escape, promises the update on reconnection, and keeps offline QR payments. One outage is one line no matter how many accounts that network carries; a rail that answers, and every IC row on the same screen, say nothing. The LANDING screen states the same sentence as the accounts route when the home currency\'s own rail is the one that cannot be read.',
  timeoutMs: 90000,
};

/** How many outage banners for the Solana network are on screen right now? X9's assertion is a
 *  COUNT: three Solana accounts share one endpoint, so one failure is ONE fact. */
const outageBanners = (driver) =>
  driver.eval(() => document.querySelectorAll('[data-testid="rail-unreadable-solana"]').length);

export async function run() {
  const start = Date.now();
  console.log('[147-rail-unreadable] setup (relay + web + browser + sol stub)…');
  const env = await setup({solStub: true});
  try {
    const {driver} = env;

    console.log('[147-rail-unreadable] onboarding…');
    await onboardWallet(driver, 'e2e-rail-unreadable');

    // One mutable state object walks the endpoint through answering and the two failure SHAPES the
    // seam distinguishes — the same per-stage dispatch shape flow 77 uses for its per-address
    // dispatch. `refused` throws the message the live endpoint returned, BRANDED exactly as
    // `SolanaEndpointRefused` brands itself (app/solana/errors.ts): the brand field is the only
    // thing `isEndpointRefusal` looks at — never `instanceof` (two module instances would silently
    // break it) and never message text. `transport` throws a plain fetch-shaped error, which is
    // the oracle's input and carries no opinion about who is down.
    await driver.eval(() => {
      const st = {mode: 'answer'}; // 'answer' | 'refused' | 'transport'
      globalThis.__DPAY_TEST_SOL_RPC_STATE = st;
      const fail = () => {
        if (st.mode === 'refused') {
          throw Object.assign(new Error('solana rpc rate limit (HTTP 429): max usage reached'), {dpayEndpointRefused: true, status: 429});
        }
        throw new Error('fetch failed');
      };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        // The balance poll is ONE request for every rail, so one failure flips every rail at once —
        // which is exactly what an exhausted key does (harness/solaccounts.mjs).
        getMultipleAccounts: (p) => (st.mode === 'answer' ? globalThis.__DPAY_SOL_ACCOUNTS(p, {lamports: 2000000000, token: {amount: '0', decimals: 6}}) : fail()),
        getBalance: () => (st.mode === 'answer' ? {value: 2000000000} : fail()),
        getTokenAccountBalance: () => (st.mode === 'answer' ? {value: {amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0'}} : fail()),
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      };
    });

    // --- the rail answers: a balance, and NO warning ------------------------------------------
    console.log('[147-rail-unreadable] a rail that answers renders its balance and nothing else…');
    await openBalances(driver);
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="asset-sol"]')?.textContent ?? '').includes('2 SOL'),
      {timeoutMs: 12_000},
    );
    assert((await outageBanners(driver)) === 0, 'a rail that answers carries no outage banner');

    // --- the endpoint answers 429: the row explains itself (REFUSED) ---------------------------
    // HONESTY: the endpoint ANSWERED, so this is a fact about the rail — the line may name the
    // network and promise the automatic retry. No connectivity override is set in this stage ON
    // PURPOSE: production never sets one, and the brand alone must do the classifying — if the
    // brand were ever lost, the oracle would probe the IC boundary origin (redirected by the
    // harness to the answering fake gateway), answer 'unreachable', and the
    // 'keeps retrying' assertion below would fail loudly instead of masking the regression.
    console.log('[147-rail-unreadable] endpoint answers HTTP 429 (refused) → the row explains…');
    await driver.eval(() => { globalThis.__DPAY_TEST_SOL_RPC_STATE.mode = 'refused'; });
    await driver.waitForFunction(
      () => document.querySelector('[data-testid="rail-unreadable-solana"]') != null,
      {timeoutMs: 12_000},
    );
    const line = await driver.readText('rail-unreadable-solana');
    assertIncludes(line, 'Solana', 'the line names the network that is not answering');
    assertIncludes(line, 'Nothing moved', 'the line states the funds did not move');
    assertIncludes(line, 'refused the request', 'the line states the classification — the endpoint answered and said no');
    assertIncludes(line, 'keeps retrying', 'the line states the recovery is automatic (there is no button to press)');
    // X9 — three Solana accounts are unreadable at once (one endpoint, one refusal). The banner is
    // stated ONCE for the network; before this it was repeated verbatim on each of them.
    const solRows = await driver.eval(() => document.querySelectorAll('[data-testid^="asset-sol"][data-testid$="-select"]').length);
    assert(solRows >= 3, `the screen must carry >=3 Solana accounts for the count to mean anything, saw ${solRows}`);
    assert((await outageBanners(driver)) === 1, 'one network outage renders exactly ONE banner');

    // The failure is scoped to the rail that failed — the IC rows claim nothing about it.
    const vchfRow = await driver.readText('asset-vchf');
    assert(!vchfRow.includes('unreadable'), 'an IC row on the same screen is untouched by a Solana endpoint failure');
    // Bring the row itself into frame so the artifact shows the state it documents.
    await driver.eval(() => document.querySelector('[data-testid="asset-sol"]')?.scrollIntoView({block: 'center'}));
    await driver.screenshot('147-rail-unreadable');

    // --- nothing answers on the rail's path while the phone IS online (UNREACHABLE) ------------
    // HONESTY: a transport failure observes NOTHING about the endpoint, so the copy may only blame
    // the service side AFTER the phone is proven online. The override pins that proof hermetically
    // ('online' short-circuits the oracle before any probe), so this stage cannot pass by luck of
    // a live IC boundary — and the copy must earn its keep: name the state and its premise, the
    // money fact, what still works (IC PAYMENTS go straight to icp-api.io — balances are NOT
    // claimed, they go through the relay; offline SIGNING restated exactly, never widened to
    // "offline payments are unaffected"), and the escape that removes dpay's choice from the path.
    console.log('[147-rail-unreadable] transport failure while online (unreachable) → the row blames dpay’s relay…');
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOL_RPC_STATE.mode = 'transport';
      globalThis.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
    });
    // The banner node stays mounted across the copy swap — wait on its TEXT, not its presence.
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="rail-unreadable-solana"]')?.textContent ?? '').includes('unreachable while you are online'),
      {timeoutMs: 12_000},
    );
    const unreachableLine = await driver.readText('rail-unreadable-solana');
    assertIncludes(unreachableLine, 'unreachable while you are online', 'the line names the state AND its premise — the phone is online');
    assertIncludes(unreachableLine, 'dpay’s relay can’t reach', 'the blame lands on dpay’s relay — the service side of the Solana path, never on the phone');
    assertIncludes(unreachableLine, 'Your money is untouched', 'the money fact is stated up front — dpay’s outage touched nothing');
    assertIncludes(unreachableLine, 'Internet Computer payments still work', 'the line names what still works — IC payments go straight to icp-api.io, never through the Solana path');
    assertIncludes(unreachableLine, 'still sign payments offline', 'the offline claim is restated exactly as SIGNING — broadcast still needs a rail, so it is never widened');
    assert(!unreachableLine.includes('Internet Computer balances'), 'IC balance reads DO go through the relay — the balances claim was false and is gone');
    assert(!unreachableLine.includes('offline QR payments are unaffected'), 'an offline-signed payment still needs the rail to broadcast — that old claim was false and is gone');
    assertIncludes(unreachableLine, 'Settings ▸ Advanced', 'the line gives the escape — point the wallet at any Solana endpoint');
    // The one-fact-one-line property must survive the cause change: still exactly ONE banner.
    assert((await outageBanners(driver)) === 1, 'one network outage still renders exactly ONE banner');
    await driver.screenshot('147-rail-unreadable-unreachable');

    // The escape is ACTIONABLE: tapping the note opens Settings with the Advanced disclosure
    // already EXPANDED — the section that sentence names (the Solana endpoint editor is the
    // advanced content) — and the sheet closes normally after.
    await driver.click('rail-unreadable-solana', {timeoutMs: 4_000});
    await driver.findByTestID('btn-settings-close', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.findByTestID('settings-sol-rpc', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.screenshot('147-rail-unreadable-escape');
    await driver.click('btn-settings-close', {timeoutMs: 4_000});
    await driver.waitGone('btn-settings-close', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});

    // --- nothing answers anywhere, the IC boundary probe included (OFFLINE) -----------------
    // HONESTY: this is the payer's normal, designed state, and the wallet cannot see far enough
    // to blame anyone — so the copy must not. Same plain-throwing endpoint; ONLY the override
    // flips to 'offline'. The line states the observation, the money fact, the automatic recovery,
    // and what still works — and it must NOT contain the escape, because Settings cannot fix a
    // phone with no connectivity and offering it would be an instruction nothing implements.
    console.log('[147-rail-unreadable] phone offline → the row names no cause…');
    await driver.eval(() => { globalThis.__DPAY_TEST_SOLANA_CONNECTIVITY = 'offline'; });
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="rail-unreadable-solana"]')?.textContent ?? '').includes('You seem offline'),
      {timeoutMs: 12_000},
    );
    const offlineLine = await driver.readText('rail-unreadable-solana');
    assertIncludes(offlineLine, 'You seem offline', 'the line states the observation — the phone — as the explanation, and names no one as the cause');
    assertIncludes(offlineLine, 'Nothing moved', 'the money fact, stated plainly as its own sentence');
    assertIncludes(offlineLine, 'update when you reconnect', 'the recovery is automatic — nothing to press, nothing promised');
    assertIncludes(offlineLine, 'QR payments still work offline', 'what still works is named exactly, not widened');
    assert(!offlineLine.includes('Settings'), 'the offline copy offers NO escape — the wallet cannot see far enough to blame anyone, and Settings cannot fix no connectivity');
    await driver.screenshot('147-rail-unreadable-offline');

    // --- the LANDING screen says it too, when the HOME rail is the one that failed (M2) ---------
    // A second wallet in the same session, onboarded onto EUR: its preferred rail is EURC·Solana,
    // so the home headline is a Solana number and the outage is the home currency's own outage.
    console.log('[147-rail-unreadable] home=EUR: the landing headline explains its own dash…');
    await driver.clearStorage();
    await driver.navigate(env.webBaseURL, `/?relay=${encodeURIComponent(env.relayBaseURL)}`, {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.waitReady({timeoutMs: 10_000});
    // clearStorage + navigation wiped EVERY page global: the driver's evaluateOnNewDocument
    // re-installs only the URL override and the accounts helper — the stub, its state object and
    // the connectivity override lived on the previous document and are gone (the old comment
    // claiming the flag survived the reload was wrong; it only ever worked because a missing stub
    // also fails the read). Re-install here, mirroring the first installation but pinned to its
    // 'transport' mode with the phone pinned 'online' — so this page's rail has been failing since
    // before any wallet existed and the headline can never flash a number first. This runs before
    // onboarding creates a wallet, so no SOL read can race a missing stub.
    await driver.eval(() => {
      globalThis.__DPAY_TEST_SOL_RPC_STATE = {mode: 'transport'};
      globalThis.__DPAY_TEST_SOLANA_CONNECTIVITY = 'online';
      const fail = () => { throw new Error('fetch failed'); };
      globalThis.__DPAY_TEST_SOLANA_RPC_STUB = {
        getGenesisHash: () => '5eykt4UsFv8PJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        getMultipleAccounts: fail,
        getBalance: fail,
        getTokenAccountBalance: fail,
        getAccountInfo: () => ({value: {data: ['', 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2039280}}),
      };
    });
    await skipWalkthroughIfPresent(driver);
    await driver.typeByPlaceholder('e.g. Alice', 'e2e-rail-unreadable-eur', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.click('btn-create', {timeoutMs: 4_000});
    await driver.findByTestID('mnemonic-backup', {waitUntil: 'domcontentloaded', timeoutMs: 8_000});
    await driver.click('mnemonic-backup-checkbox', {timeoutMs: 4_000});
    await waitForEnabled(driver, 'btn-mnemonic-continue', {timeoutMs: 4_000});
    await driver.click('btn-mnemonic-continue', {timeoutMs: 4_000});
    await skipPracticeIfPresent(driver);
    await driver.findByTestID('home-currency-title', {timeoutMs: 10_000});
    await driver.click('home-currency-EUR', {timeoutMs: 4_000});
    await driver.click('btn-home-currency-continue', {timeoutMs: 4_000});
    await driver.findByTestID('home-headline-amount', {timeoutMs: 10_000});

    // The headline is a dash AND a sentence — the UNREACHABLE one, this page's pinned state (wait
    // on the text, not the node's presence: the node is the same testID across all causes).
    await driver.waitForFunction(
      () => (document.querySelector('[data-testid="rail-unreadable-solana"]')?.textContent ?? '').includes('unreachable while you are online'),
      {timeoutMs: 12_000},
    );
    const headline = await driver.readText('home-headline-amount');
    assert(headline.includes('—'), `an unreadable home rail still shows no number, saw "${headline}"`);
    const homeLine = await driver.readText('rail-unreadable-solana');
    assertIncludes(homeLine, 'Solana', 'the landing screen names the network that is not answering');
    assertIncludes(homeLine, 'Your money is untouched', 'and states the money is untouched');
    assert(homeLine === unreachableLine, 'the landing screen and the accounts route say the SAME sentence — one fact, one owner');
    await driver.screenshot('147-rail-unreadable-home');

    console.log(`[147-rail-unreadable] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}
