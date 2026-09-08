#!/usr/bin/env node
// check-prod-sol — release gate for the Solana RPC endpoint that every shipped bundle bakes in.
//
// `SOLANA_RPC_BAKED` in app/config/constants.ts is the endpoint a FRESH INSTALL talks to. An
// operator can point their own device elsewhere at runtime (`setSolanaRpcUrl`, persisted under
// `SOLANA_RPC_STORAGE_KEY`), but nobody else's device is configured, so the baked value is what a
// user's phone — and every browser session at /wallet — will use. This gate reads that literal and
// refuses to ship two failure modes:
//
//   STATIC    the endpoint's HOST is one no release may point at (public Solana cluster endpoints,
//             or any non-mainnet cluster). Matched on the PARSED HOST against the rule set below,
//             never as a substring of the whole URL: the URL carries an API key, and a key is not
//             allowed to decide (or dodge) a build.
//   LIVENESS  the endpoint is not answering RIGHT NOW. A string check is blind to an exhausted key:
//             the 2026-09-08 outage ran for hours with this gate green while the endpoint returned
//             HTTP 429. One `getHealth` POST closes that.
//
// TWO MODES. The default is the strict one, so a ship path that forgets a flag fails loudly rather
// than skipping the check in silence:
//
//   node scripts/check-prod-sol.mjs              STRICT (default) — static + liveness. Used by every
//                                                path that ships a bundle: scripts/build-apk.sh (the
//                                                APK) and deploy/build.sh (the relay image, i.e. the
//                                                WEB bundle served at /wallet).
//   node scripts/check-prod-sol.mjs --no-probe   STATIC ONLY, no network. Exactly one caller: the
//                                                `web` recipe in justfile. That recipe is on the
//                                                fully-offline inner loop (test-relay, test-live,
//                                                web-smoke, web-scan → verify), where a network call
//                                                would break the offline non-negotiable.
//
// There is no env-var skip, no "probe failed, continue anyway", no fallback endpoint. A probe that
// cannot run is a failed build.
//
// DPAY_SOL_RPC is an ASSERTION, not an injection. Setting it does NOT change the endpoint the build
// bakes in and does NOT excuse a host the rule set refuses; it only requires the literal in
// app/config/constants.ts to equal it exactly, so an operator who flipped the constant elsewhere
// finds out here. The baked constant stays the single source of the default.
//
// Exit 0 = safe to ship. Exit 1 = every reason, listed.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const PROBE_TIMEOUT_MS = 10_000;

const probeEnabled = !process.argv.includes('--no-probe');
const unknown = process.argv.slice(2).filter((a) => a !== '--no-probe');
if (unknown.length) {
  console.error(`check-prod-sol: unknown argument(s): ${unknown.join(' ')} (only --no-probe is accepted)`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const constantsPath = join(here, '..', 'app', 'config', 'constants.ts');
const src = readFileSync(constantsPath, 'utf8');

// Extract the baked default from: export const SOLANA_RPC_BAKED = ((...).__DPAY_TEST_SOLANA_RPC_URL ?? '<url>');
const m = src.match(/export const SOLANA_RPC_BAKED\s*=[\s\S]*?\?\?\s*'([^']+)'/);
if (!m) {
  console.error('check-prod-sol: FAIL — could not find the SOLANA_RPC_BAKED default in app/config/constants.ts');
  process.exit(1);
}
const baked = m[1];

// The rule set. One list, one predicate shape, evaluated against the parsed HOST — so the devnet
// refusal and the public-endpoint refusal are the same kind of statement about the same thing.
const HOST_RULES = [
  {
    // Every public cluster endpoint Solana operates lives under solana.com — api.mainnet-beta,
    // api.mainnet (the spelling their docs now use), api.devnet, api.testnet, and whatever they
    // name the next one. They are rate-limited by design, below what this app's polling asks for
    // (measured: docs/specs/2026-09-08-solana-rpc-plan.md). A paid provider is never on solana.com,
    // so the whole domain is the honest expression of "this is the public endpoint" — and it is why
    // this matches on the parsed host, not on one spelling of one name.
    reason: 'a public Solana-operated cluster endpoint (anything under solana.com)',
    hit: (host) => host === 'solana.com' || host.endsWith('.solana.com'),
    fix: 'Point SOLANA_RPC_BAKED at a private mainnet provider (Helius / QuickNode / Triton).',
  },
  {
    // Any provider's devnet or testnet host, not just Solana's own: mainnet SOL sent to a key the
    // app is reading on devnet is invisible, and that is a fund-loss trap in a release build.
    reason: 'a non-mainnet cluster (the host names devnet/testnet)',
    hit: (host) => host.includes('devnet') || host.includes('testnet'),
    fix: 'Point SOLANA_RPC_BAKED at the provider\'s MAINNET host before building a release.',
  },
];

/** The endpoint's HOST, never its URL: the shipped RPC URL carries an API key, and a build log is
 *  exactly where a key must not appear. Same rule as `hostOf` in app/solana/rpc.ts. */
const hostOf = (url) => new URL(url).host;

/** An endpoint's own words with the URL's secrets taken out: the key rides in the query string
 *  (Helius) or a path segment (QuickNode), and a provider echoing the request must not put it in a
 *  build log. Collapsed to one short line — this is a diagnosis, not a body dump. */
function scrub(text, url) {
  const u = new URL(url);
  let out = text;
  for (const v of u.searchParams.values()) if (v) out = out.split(v).join('<redacted>');
  for (const seg of u.pathname.split('/')) if (seg.length >= 8) out = out.split(seg).join('<redacted>');
  return out.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** POST getHealth once — no retry loop: this is a build gate, and a provider that needs a second
 *  ask is already a provider this build should not ship. Returns null when healthy, else the
 *  reason, host-named. */
async function probe(url) {
  const host = hostOf(url);
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getHealth'}),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `did not answer within ${PROBE_TIMEOUT_MS} ms` : `is unreachable: ${e?.message ?? e}`;
    return `${host} ${why}`;
  }
  const body = scrub(await r.text().catch((e) => `<body unreadable: ${e?.message ?? e}>`), url);
  if (r.status === 429) return `${host} answered HTTP 429 — the key is rate-limited or out of quota: ${body}`;
  if (!r.ok) return `${host} answered HTTP ${r.status}: ${body}`;
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    return `${host} answered HTTP ${r.status} with a non-JSON body: ${body}`;
  }
  if (j.error) return `${host} returned an RPC error: ${j.error.message ?? JSON.stringify(j.error)}`;
  if (j.result !== 'ok') return `${host} getHealth returned ${JSON.stringify(j.result)}, not "ok" — the node is not healthy`;
  return null;
}

// Collect every reason before exiting (same idiom as scripts/check-web-prod-seams.mjs): an operator
// deserves the whole verdict in one run, not one failure per build. `notes` carries the halves that
// PASSED, so a failing run still says which half was fine — "wrong host, live endpoint" and "wrong
// host, dead endpoint" are different problems and the operator should not have to guess which.
const findings = [];
const notes = [];

const expected = process.env.DPAY_SOL_RPC;
if (expected !== undefined && baked !== expected) {
  // Neither value is printed: both carry an API key. The operator holds both already.
  findings.push([
    `the baked SOLANA_RPC_BAKED default (host ${URL.canParse(baked) ? hostOf(baked) : '<unparseable>'}) is not the value DPAY_SOL_RPC asserts`,
    '    Edit app/config/constants.ts so the `??` default matches DPAY_SOL_RPC exactly, then re-run.',
  ]);
}

if (!URL.canParse(baked)) {
  findings.push([
    'the baked SOLANA_RPC_BAKED default is not a parseable URL, so no host can be checked and no endpoint can be probed',
    '    Fix the `??` default in app/config/constants.ts.',
  ]);
} else {
  const host = hostOf(baked);
  for (const rule of HOST_RULES) {
    if (rule.hit(host)) findings.push([`the baked Solana RPC host is ${host} — ${rule.reason}`, `    ${rule.fix}`]);
  }
  // Probed even when a rule already refused the host: two independent facts, and the operator
  // should learn both in one run. Skipped only when there is no URL to probe (above).
  if (probeEnabled) {
    const dead = await probe(baked);
    if (!dead) {
      notes.push(`liveness: ${host} answered getHealth "ok"`);
    } else {
      findings.push([
        `the baked Solana RPC endpoint is not serving: ${dead}`,
        '    This build would ship a wallet that cannot read a Solana balance or send SOL/USDC.',
        '    Rotate or renew the provider key (or switch provider), put the new URL in the `??`',
        '    default of app/config/constants.ts, and re-run this build.',
        '    Do NOT reach for --no-probe: it exists for the offline inner loop (`just web`) only.',
      ]);
    }
  }
}

if (findings.length) {
  console.error('check-prod-sol: FAIL — this endpoint must not ship:');
  for (const [head, ...rest] of findings) {
    console.error(`  ✗ ${head}`);
    for (const line of rest) console.error(line);
  }
  for (const n of notes) console.error(`  · ${n}`);
  process.exit(1);
}

const host = hostOf(baked);
console.log(
  probeEnabled
    ? `check-prod-sol: PASS — ${host} is a private mainnet host and answered getHealth "ok"`
    : `check-prod-sol: PASS (static only, --no-probe) — ${host} is a private mainnet host; liveness NOT checked`,
);
