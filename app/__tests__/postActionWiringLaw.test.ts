/**
 * The POST-ACTION wiring law (founder 2026-10-05: "Solana refresh => should be done also
 * periodically and/or for some time after making payments and after conversions").
 *
 * The window's mechanics are pinned behaviorally (postActionRepoll.test.ts for the pure law,
 * recheckAll.test.tsx for the hook); this pin holds the WIRING to exactly-one-way: Wallet arms
 * the bounded Solana re-poll at exactly the two action families that can land money on Solana —
 * a payment sent on the SOL rail (both send spellings) and a conversion reaching a terminal step
 * (gated on the record's payout rail, `solana|unknown` runs) — through the ONE shared recheck
 * primitive (`useRecheckAll`'s `armSolWindow`), and the engine hands the terminal RECORD to the
 * wallet (a bare callback could not answer "which rail paid out"). If a future surface arms the
 * window through some second path, or the engine stops carrying the record, this fails.
 */
import {describe, expect, test} from '@jest/globals';
import {readFileSync} from 'fs';
import {join} from 'path';

const walletSrc = readFileSync(join(__dirname, '..', 'components', 'Wallet.tsx'), 'utf8');
const engineSrc = readFileSync(join(__dirname, '..', 'hooks', 'useConvertResumeEngine.ts'), 'utf8');
const resumeSrc = readFileSync(join(__dirname, '..', 'convertResume.ts'), 'utf8');

describe('the post-action window is armed at exactly the two action families, through the one recheck primitive', () => {
  test('Wallet takes armSolWindow from useRecheckAll — the single shared recheck primitive', () => {
    expect(walletSrc).toMatch(/const\s*\{\s*recheckAll\s*,\s*recheckBusy\s*,\s*armSolWindow\s*\}\s*=\s*useRecheckAll\(/);
  });

  test('a SOL-rail payment sent arms it: both send spellings (native + token)', () => {
    const onSolSent = blockOf(walletSrc, 'const onSolSent = useCallback');
    const onSolTokenSent = blockOf(walletSrc, 'const onSolTokenSent = useCallback');
    expect(onSolSent).toContain('armSolWindow()');
    expect(onSolTokenSent).toContain('armSolWindow()');
  });

  test('a conversion terminal arms it ONLY for a Solana or unknown payout rail', () => {
    const onConvertTerminal = blockOf(walletSrc, 'const onConvertTerminal = useCallback');
    expect(onConvertTerminal).toContain('repollWantedForPayoutRail(convertRecordPayoutRail(rec))');
    expect(onConvertTerminal).toContain('refreshHistory()');
  });

  test('the engine is the ONLY conversion-terminal funnel and carries the record', () => {
    expect(walletSrc).toMatch(/useConvertResumeEngine\(\{identity,\s*relayUrl,\s*onTerminal:\s*onConvertTerminal\}\)/);
    // the hook's type passes the record through
    expect(engineSrc).toMatch(/onTerminal\?:\s*\(rec:\s*ConvertRecord\)\s*=>\s*void/);
    // the engine's ONE fire site passes the record
    expect(resumeSrc).toContain('state.ctx?.onTerminal?.(after)');
  });
});

/** The source block from a declaration line to its closing `);`-ish boundary — enough structure
 *  for the wiring assertions above without pretending to parse TypeScript. */
function blockOf(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  expect(at).toBeGreaterThanOrEqual(0);
  return src.slice(at, src.indexOf('}, [', at) + 4);
}
