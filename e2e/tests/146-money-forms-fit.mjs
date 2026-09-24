// Flow 146 — the two forms a user types MONEY into fit the screen they are shown on.
//
// WHY THIS EXISTS. The suite drives both of these forms end to end — flows 113-117 open a charge and pay a
// checkout charge, 104–107 send to an address — and neither ever asked whether the form was ON SCREEN.
// It was not. Measured at 390px: the cashier charge-open form hung 71.7px off BOTH edges of a 358px
// column (the `CHF` prefix off-screen left, the button's corner radii off-screen right, the hint
// clipped at both ends), and the Send-to-address form hung 17.4px off both edges with its Max
// button a further 28.7px past the right. Every one of those flows was GREEN throughout, and so was
// the pixel gate: an element rendered outside the viewport contributes no pixels to compare, so a
// baseline agrees with itself while the user sees a mutilated form.
//
// SO THIS MEASURES INSTEAD OF COMPARING. The assertion is geometric and reads the numbers a person
// would: the mode surface may not be wider than the column it is mounted in, and no rendered box
// inside it may cross either viewport edge. That is the invariant both defects broke — a surface
// nested inside a centring parent is sized to its own content, which flexbox does not clamp to the
// parent's width — and it fails loudly with the offending element named.
//
// BOTH LOCALES, because the copy under each amount field is the longest sentence on its screen and
// German is the app's longest rendering of it. Language is not the cause (English measured the
// identical 533px checkout root), which is why it is a SEPARATE pass rather than the only one: the
// structural fix has to hold for the widest copy the app ships.
//
// Selector contract: `btn-code-checkout`, `amount-input`, `btn-checkout-open`, `btn-pay-send`,
// `send-address-input`, `btn-send-max`, `btn-lang-de`, `btn-settings`, `btn-settings-close`.
import {
  setup, assert, onboardWallet, accountOf, faucetAccount, openBalances, selectCurrency,
} from '../harness/lib.mjs';

const VCHF = 7;      // the checkout's one asset — and the row this flow sends from
const SEED = 500_000_000;

export const meta = {
  id: '146',
  name: 'money-forms-fit',
  journey: 'pay',
  covers: ['checkout', 'merchant-checkout', 'send-to-address', 'layout', 'viewport-fit', 'receive', 'vchf', 'i18n', 'regression'],
  verifies: 'The two forms a user types money into — the checkout charge-open (the shared Receive amount row with the checkout checkbox checked) and Send-to-address — render entirely inside the phone viewport in both a short and the app’s longest locale: each form’s mode surface is no wider than its content column, and every rendered box in it (the unit prefix, the amount fields, the Max button, the hints and the primary buttons) sits between the two viewport edges with no horizontal page scroll.',
  timeoutMs: 90000,
};

/** Sub-pixel layout rounding. A real overflow here is tens of pixels; half a pixel is the renderer. */
const SLOP = 0.5;

/**
 * Geometry of the form an anchor element sits in, read from the live DOM.
 *
 * The mode surface is found the way the STYLE defines it rather than by class name (react-native-web
 * hashes those): walk up from the anchor to the first ancestor that grows and centres its children.
 * Its parent is the content column it must fit inside.
 */
const measureForm = (anchorTestID) => {
  const anchor = document.querySelector(`[data-testid="${anchorTestID}"]`);
  if (!anchor) return {error: `the form is not on screen (no ${anchorTestID})`};
  let node = anchor.parentElement, surface = null;
  while (node && node !== document.body) {
    const cs = getComputedStyle(node);
    if (cs.flexGrow === '1' && cs.alignItems === 'center') { surface = node; break; }
    node = node.parentElement;
  }
  if (!surface) return {error: `no mode surface above ${anchorTestID}`};

  const round = (v) => Math.round(v * 10) / 10;
  const box = (el) => { const r = el.getBoundingClientRect(); return {left: round(r.left), right: round(r.right), width: round(r.width)}; };
  const name = (el) => el.getAttribute('data-testid') ?? `<${el.tagName.toLowerCase()}> ${(el.textContent ?? '').trim().slice(0, 40)}`;

  // Every painted box in the form, plus the surface itself — a clipped prefix is a child of a child,
  // so nothing may be excluded by depth.
  const painted = [surface, ...surface.querySelectorAll('*')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const worstLeft = painted.reduce((a, b) => (b.getBoundingClientRect().left < a.getBoundingClientRect().left ? b : a));
  const worstRight = painted.reduce((a, b) => (b.getBoundingClientRect().right > a.getBoundingClientRect().right ? b : a));

  return {
    viewportW: window.innerWidth,
    documentScrollW: document.documentElement.scrollWidth,
    column: box(surface.parentElement),
    surface: box(surface),
    worstLeft: {what: name(worstLeft), ...box(worstLeft)},
    worstRight: {what: name(worstRight), ...box(worstRight)},
  };
};

/** Are these testIDs all rendered with a real box? The positive control against a vacuous pass. */
const arePainted = (testIDs) => testIDs.map((id) => {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (!el) return {id, painted: false};
  const r = el.getBoundingClientRect();
  return {id, painted: r.width > 0 && r.height > 0};
});

/** Assert the form is wholly inside the viewport, naming the box that is not when it is not. */
function assertFits(m, painted, where) {
  assert(!m.error, `${where}: ${m.error}`);
  const shown = JSON.stringify(m);
  for (const p of painted) assert(p.painted, `${where}: "${p.id}" must be rendered — ${shown}`);
  // The root-cause invariant: a nested surface sized to its own content grows past the column and
  // takes the whole form with it.
  assert(m.surface.width <= m.column.width + SLOP,
    `${where}: the form's mode surface (${m.surface.width}px) is wider than its column (${m.column.width}px) — ${shown}`);
  assert(m.worstLeft.left >= -SLOP,
    `${where}: "${m.worstLeft.what}" is ${-m.worstLeft.left}px off the left edge — ${shown}`);
  assert(m.worstRight.right <= m.viewportW + SLOP,
    `${where}: "${m.worstRight.what}" is ${m.worstRight.right - m.viewportW}px off the right edge — ${shown}`);
  assert(m.documentScrollW <= m.viewportW + SLOP,
    `${where}: the page scrolls horizontally (${m.documentScrollW}px of content in a ${m.viewportW}px viewport) — ${shown}`);
}

/** Receive ▸ Request payment ▸ the checkout checkbox. The code-form choice persists across visits and
 *  the checkbox TOGGLES (unlike the Send form's segmented toggle, whose click SETS), so a blind
 *  click on the second visit would flip BACK to the dpay code — guard on the form being up. */
async function openChargeForm(driver) {
  await driver.click('tab-receive', {timeoutMs: 5_000});
  if (!(await driver.isPresent('btn-checkout-open'))) await driver.click('btn-code-checkout', {timeoutMs: 5_000});
  await driver.findByTestID('btn-checkout-open', {timeoutMs: 8_000});
}

/** Pay ▸ Send to address — the segmented toggle SETS its value, so the blind click is a no-op when
 *  the send form is already the active segment. */
async function openSendForm(driver) {
  await driver.click('tab-pay', {timeoutMs: 5_000});
  if (await driver.isPresent('btn-pay-send')) await driver.click('btn-pay-send', {timeoutMs: 5_000});
  await driver.findByTestID('send-address-input', {timeoutMs: 8_000});
}

/** Measure + assert both forms in whatever language the app is currently in. */
async function bothForms(driver, locale) {
  await openChargeForm(driver);
  const checkout = await measureIn(driver, 'amount-input', ['amount-input', 'btn-checkout-open']);
  console.log(`[146-money-forms-fit] checkout-open (${locale}): ${JSON.stringify(checkout.m)}`);
  assertFits(checkout.m, checkout.painted, `checkout-open form (${locale})`);
  await driver.screenshot(`146-checkout-form-${locale}`);

  await openSendForm(driver);
  const send = await measureIn(driver, 'send-address-input', ['send-address-input', 'send-scan', 'btn-send-max']);
  console.log(`[146-money-forms-fit] send (${locale}): ${JSON.stringify(send.m)}`);
  assertFits(send.m, send.painted, `send-to-address form (${locale})`);
  await driver.screenshot(`146-send-form-${locale}`);
}

async function measureIn(driver, anchor, mustPaint) {
  return {
    m: await driver.eval(measureForm, anchor),
    painted: await driver.eval(arePainted, mustPaint),
  };
}

export async function run() {
  const start = Date.now();
  console.log('[146-money-forms-fit] setup (relay + web + browser; the session relay serves the checkout)…');
  const env = await setup();
  try {
    const {driver, relayBaseURL} = env;
    await onboardWallet(driver, 'Bahnhof Kiosk');
    // VCHF is the one asset a dpay checkout takes, so it is the one whose Receive tab reaches the
    // counter rather than the refusal panel — and funding it is what makes the send form render
    // instead of the fund-first gate.
    const me = await accountOf(driver);
    const funded = await faucetAccount(relayBaseURL, me.publicHex, SEED, {currency: VCHF});
    assert(funded.ok, `the wallet must be funded in VCHF, got HTTP ${funded.status}`);
    await openBalances(driver);
    await selectCurrency(driver, 'vchf');

    await bothForms(driver, 'en');

    console.log('[146-money-forms-fit] switching to German…');
    await driver.click('btn-settings', {timeoutMs: 5_000});
    await driver.click('btn-lang-de', {timeoutMs: 5_000});
    await driver.click('btn-settings-close', {timeoutMs: 5_000});
    await bothForms(driver, 'de');

    console.log(`[146-money-forms-fit] GREEN in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } finally {
    await env.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(() => { console.log('[146-money-forms-fit] done'); process.exit(0); }, (e) => {
    console.error('146-money-forms-fit RED:', e.stack || e.message || e);
    process.exit(1);
  });
}
