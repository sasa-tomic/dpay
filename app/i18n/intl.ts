/**
 * intl.ts — the locale's FORMATTING conventions, derived from ICU and applied to exact digits.
 *
 * The rule this module exists to enforce: `Intl` decides what the conventions ARE, and never
 * touches the number itself. Money in this app is carried as decimal-digit strings and computed
 * with `BigInt` (see lib/amount.ts) precisely so no amount ever routes through a `Number`; handing
 * a raw amount to `Intl.NumberFormat` would undo that at the last step, silently, for exactly the
 * large values where it matters. So we ask ICU for the separators, the grouping pattern and the
 * currency placement — all facts, not arithmetic — and then apply them to the digit string.
 *
 * Everything is DERIVED by probing `formatToParts`, never hardcoded per locale. Spanish is the
 * cheap proof that a table of assumptions would be wrong: es-ES writes `1000` ungrouped but
 * `10.000` grouped, and Hindi groups 3-then-2. Both fall out of the probe for free.
 *
 * Active state is a mutable module singleton swapped by `applyFormatLocale`, the same idiom as
 * `applyPalette` for styles and `M` for copy: read during render, never destructured and held.
 *
 * NOTE the Hermes constraint (see selfcheck.ts): only `Intl.NumberFormat`, `Intl.DateTimeFormat`
 * and `Intl.Collator` exist. `Intl.PluralRules`, `Intl.Locale` and `Intl.RelativeTimeFormat` are
 * ABSENT — code written against them passes in the browser and throws in the APK.
 */

/** How a locale breaks up the integer part, as CLDR describes it. */
type Grouping = {
  /** Digits in the rightmost group (3 nearly everywhere; 3 in hi-IN too). */
  primary: number;
  /** Digits in every group after that (3 in most locales, 2 in the Indian system). */
  secondary: number;
  /**
   * The shortest integer that gets grouped at all. 1 in en/de, 2 in es/pl — which is why es-ES
   * writes a bare `1000` but a separated `10.000`.
   */
  minDigits: number;
};

/** Where the currency symbol sits, and what (if anything) separates it from the digits. */
type Placement = {prefix: boolean; sep: string};

type Conventions = {
  tag: string;
  group: string;
  decimal: string;
  grouping: Grouping;
  placement: Placement;
  clock: Intl.DateTimeFormat;
  monthDay: Intl.DateTimeFormat;
  monthDayYear: Intl.DateTimeFormat;
};

/**
 * Probe ICU for one locale's number conventions.
 *
 * Throws rather than falling back if the engine has no real ICU data. That is deliberate: a
 * stubbed `Intl` cannot produce correct money, and quietly substituting English separators would
 * render a German amount as `1,5` — one-and-a-half to us, fifteen to the reader. The device gate
 * (`DPAY_INTL_SELFCHECK`) proves real ICU data is present before the app is considered shippable,
 * so this throw marks a genuinely impossible state loudly instead of hiding a money bug.
 */
function probe(tag: string): Omit<Conventions, 'tag' | 'clock' | 'monthDay' | 'monthDayYear'> {
  const nf = new Intl.NumberFormat(tag);
  // 8 significant digits force at least two group boundaries, so both the primary and the
  // secondary group size are observable in one sample.
  const parts = nf.formatToParts(11111111.1);
  const group = parts.find(p => p.type === 'group')?.value;
  const decimal = parts.find(p => p.type === 'decimal')?.value;
  if (!group || !decimal) {
    throw new Error(`[dpay] Intl has no usable number data for "${tag}" — cannot format money safely`);
  }

  // Integer digit-run lengths, right to left: en gives [2,3,3], hi-IN gives [3,2,2,1].
  const runs = parts.filter(p => p.type === 'integer').map(p => p.value.length).reverse();
  const primary = runs[0] ?? 3;
  const secondary = runs[1] ?? primary;

  // es/pl leave four-digit integers ungrouped; en/de do not. Ask, don't assume.
  const minDigits = nf.formatToParts(1000).some(p => p.type === 'group') ? 1 : 2;

  // Placement is read from a real currency format. The CODE is irrelevant — dpay renders its own
  // glyphs (∂/₿/◎ and the backing symbols) — only the side and the joining space are wanted.
  const cparts = new Intl.NumberFormat(tag, {style: 'currency', currency: 'USD'}).formatToParts(1);
  const ci = cparts.findIndex(p => p.type === 'currency');
  const ni = cparts.findIndex(p => p.type === 'integer');
  const prefix = ci >= 0 && ni >= 0 ? ci < ni : true;
  const between = ci < 0 || ni < 0
    ? ''
    : cparts.slice(Math.min(ci, ni) + 1, Math.max(ci, ni)).filter(p => p.type === 'literal').map(p => p.value).join('');

  return {group, decimal, grouping: {primary, secondary, minDigits}, placement: {prefix, sep: between}};
}

function build(tag: string): Conventions {
  return {
    tag,
    ...probe(tag),
    // 12h vs 24h, the separator, and the marker's wording are all the locale's business.
    clock: new Intl.DateTimeFormat(tag, {hour: 'numeric', minute: '2-digit'}),
    // Month-before-day is a US convention; asking ICU gets `4. Aug.` and `8月4日` right for free.
    monthDay: new Intl.DateTimeFormat(tag, {month: 'short', day: 'numeric'}),
    monthDayYear: new Intl.DateTimeFormat(tag, {month: 'short', day: 'numeric', year: 'numeric'}),
  };
}

let active: Conventions = build('en');

/** Swap the formatting conventions. Called by `applyLocale`; never call it on its own. */
export function applyFormatLocale(tag: string): void {
  if (tag !== active.tag) active = build(tag);
}

/** The tag currently driving formatting — for the device self-check's marker payload. */
export function activeFormatTag(): string {
  return active.tag;
}

/** The locale's decimal mark. */
export function decimalSep(): string {
  return active.decimal;
}

/**
 * Rewrite what the USER TYPED into the canonical `1234.56` form the amount parser contracts for.
 *
 * This exists because `keyboardType="decimal-pad"` renders a COMMA key on a German, French or
 * Spanish device. Without this step the parser rejects `1,50`, `toUnits` reports `'0'`, and the
 * Request/Withdraw button simply does nothing, with no error — a total loss of function across
 * most of Europe and Latin America, failing silently.
 *
 * Only the DECIMAL mark is translated. Group separators are deliberately NOT stripped, because
 * stripping them is where a wrong number gets built: `1.234` is twelve-hundred-ish to a German
 * reader and one-point-two-three-four to an English one, and the same user may type either on a
 * hardware keyboard. Leaving `.` alone means a German typing `1.5` gets 1.5 (what they meant),
 * while genuinely ambiguous grouped input like `1.234,56` fails the parser's shape check and is
 * refused outright. Refusing beats guessing when the guess is someone's money.
 */
export function canonicalizeDecimal(input: string): string {
  return active.decimal === '.' ? input : input.split(active.decimal).join('.');
}

/**
 * Insert group separators into a whole-part DIGIT STRING. Takes and returns a string so an
 * arbitrarily long integer part (an 18-decimal ETH value) survives without a `Number` in sight.
 */
export function groupDigits(digits: string): string {
  const {primary, secondary, minDigits} = active.grouping;
  if (digits.length <= primary || digits.length < primary + minDigits) return digits;
  const head = digits.slice(0, digits.length - primary);
  const out: string[] = [digits.slice(digits.length - primary)];
  let i = head.length;
  while (i > secondary) {
    out.unshift(head.slice(i - secondary, i));
    i -= secondary;
  }
  out.unshift(head.slice(0, i));
  return out.join(active.group);
}

/**
 * Join a currency symbol to an already-formatted amount on the side this locale uses. en-US puts
 * `$` in front with no gap; fr-FR and de-DE put it after with a no-break space.
 */
export function placeCurrency(symbol: string, amount: string): string {
  const {prefix, sep} = active.placement;
  return prefix ? `${symbol}${sep}${amount}` : `${amount}${sep}${symbol}`;
}

/** Wall-clock time — 12h with a marker, or 24h, whichever this locale reads. */
export function formatClock(d: Date): string {
  return active.clock.format(d);
}

/** A day inside the current year, in this locale's order. */
export function formatMonthDay(d: Date): string {
  return active.monthDay.format(d);
}

/** A day in an earlier year, in this locale's order. */
export function formatMonthDayYear(d: Date): string {
  return active.monthDayYear.format(d);
}
