/**
 * i18n/selfcheck.ts — on-device proof that the `Intl` surface the money formatter depends on is
 * actually present in the SHIPPING JS engine.
 *
 * WHY THIS EXISTS: `lib/format.ts` renders every amount the user approves. Localizing its
 * separators means depending on `Intl.NumberFormat`; localizing the clock means depending on
 * `Intl.DateTimeFormat`. Hermes builds Intl OPTIONALLY — the `hermes-android` AAR carries the
 * `com/facebook/hermes/intl/*` JNI bridge that backs it onto Android's ICU — while the headless
 * browser the e2e suite drives ALWAYS has a full Intl. So a missing-Intl regression (an RN/Hermes
 * upgrade, a different engine flavor) would be INVISIBLE to the entire offline suite and would
 * surface as broken amounts on a real phone. The device gate greps for `DPAY_INTL_SELFCHECK PASS`.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: exact separator glyphs. CLDR/ICU data ships WITH the
 * Android system image, so de-DE's group separator is '.' on one API level and may differ on
 * another; pinning glyphs here would be a false gate that fails on a correct device. We assert the
 * SHAPE the formatter actually needs: a non-empty decimal separator, and a ','-decimal locale that
 * genuinely disagrees with a '.'-decimal one (i.e. real per-locale data, not a stub returning
 * en-US for every tag — the exact way a trimmed ICU degrades).
 *
 * NOT PROBED, BY DESIGN: `Intl.PluralRules`, `Intl.Locale` and `Intl.RelativeTimeFormat` are
 * ABSENT from Hermes (verified against `libhermesvm.so`, whose symbol table exposes only
 * Collator / DateTimeFormat / NumberFormat / getCanonicalLocales). Do NOT write app code against
 * them: the browser would pass and the APK would throw.
 */

export type IntlProbe = {ok: boolean; reason: string; deviceLocale: string};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Read a locale's group + decimal separators the way the formatter will: via `formatToParts`, so
 * the separators are extracted as DATA and applied to an exact BigInt digit string, rather than
 * routing a money amount through `Number` (lossy above 2^53 — see lib/format.ts + lib/amount.ts).
 * Returns null when the engine yields no decimal part, which is the signal that Intl is a stub.
 */
export function separatorsFor(tag: string): {group: string; decimal: string} | null {
  const parts = new Intl.NumberFormat(tag).formatToParts(12345.6);
  let group = '';
  let decimal = '';
  for (const p of parts) {
    if (p.type === 'group') group = p.value;
    if (p.type === 'decimal') decimal = p.value;
  }
  return decimal.length > 0 ? {group, decimal} : null;
}

export function runIntlSelfCheck(): IntlProbe {
  const fail = (reason: string): IntlProbe => ({ok: false, reason, deviceLocale: ''});
  const g = globalThis as {Intl?: typeof Intl};
  if (typeof g.Intl === 'undefined') return fail('Intl is undefined');
  if (typeof Intl.NumberFormat !== 'function') return fail('Intl.NumberFormat missing');
  if (typeof Intl.DateTimeFormat !== 'function') return fail('Intl.DateTimeFormat missing');

  // 1) The device tag — the SOURCE the locale resolver negotiates from (RFC 4647 lookup). On
  //    Hermes this is backed by java.util.Locale.getDefault(); in the browser by navigator.language.
  let deviceLocale: string;
  try {
    deviceLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch (e) {
    return fail(`DateTimeFormat().resolvedOptions() threw: ${msg(e)}`);
  }
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]+)*$/.test(deviceLocale)) {
    return fail(`device locale is not a BCP-47 tag: "${deviceLocale}"`);
  }
  const withLocale = (reason: string): IntlProbe => ({ok: false, reason, deviceLocale});

  // 2) formatToParts must yield real separators, and they must actually VARY by locale. A trimmed
  //    ICU that answers en-US for every tag would silently render German amounts as "1,5" meaning
  //    one-and-a-half to us but fifteen to the reader — a money bug, so this is a hard gate.
  let en: {group: string; decimal: string} | null;
  let de: {group: string; decimal: string} | null;
  try {
    en = separatorsFor('en-US');
    de = separatorsFor('de-DE');
  } catch (e) {
    return withLocale(`NumberFormat.formatToParts threw: ${msg(e)}`);
  }
  if (!en) return withLocale('en-US yielded no decimal separator');
  if (!de) return withLocale('de-DE yielded no decimal separator');
  if (en.decimal !== '.') return withLocale(`en-US decimal separator is "${en.decimal}", expected "."`);
  if (en.group.length === 0) return withLocale('en-US yielded no group separator');
  if (de.decimal === en.decimal) {
    return withLocale(`de-DE decimal separator equals en-US ("${de.decimal}") — ICU data looks stubbed`);
  }

  // 3) The clock. fmtTime needs hour+minute formatting, and the 12h/24h choice must follow the
  //    locale (en-US is 12h, de-DE is 24h) — today's hardcoded AM/PM is simply wrong for DE/FR.
  try {
    const at = new Date(Date.UTC(2026, 7, 26, 13, 19, 0));
    const opts = {hour: 'numeric', minute: '2-digit', timeZone: 'UTC'} as const;
    const enTime = new Intl.DateTimeFormat('en-US', opts).format(at);
    const deTime = new Intl.DateTimeFormat('de-DE', opts).format(at);
    if (enTime.length === 0 || deTime.length === 0) return withLocale('DateTimeFormat produced an empty time');
    if (!new Intl.DateTimeFormat('en-US', opts).resolvedOptions().hour12) {
      return withLocale('en-US did not resolve to a 12-hour clock — ICU data looks stubbed');
    }
  } catch (e) {
    return withLocale(`DateTimeFormat(hour/minute) threw: ${msg(e)}`);
  }

  return {ok: true, reason: '', deviceLocale};
}
