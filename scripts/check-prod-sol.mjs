#!/usr/bin/env node
// check-prod-sol — release gate for the Solana RPC path every shipped build talks to (R2, spec
// 2026-09-09-relay-ha-and-solana-proxy §"Direction 1 — the proxy").
//
// Until R2 this gate read the provider URL + API key baked into app/config/constants.ts and
// refused to ship a public/non-mainnet host or a dead endpoint. R2 removed that literal — the
// client's DEFAULT endpoint is now the RELAY's proxy route (`${relayBase}/api/v1/solana/rpc`)
// and the provider key lives in relay configuration, never in the bundle. So the gate's two
// halves became:
//
//   STATIC   the R2 invariant itself: app/config/constants.ts must carry the proxy path and must
//            NOT carry a provider URL/key literal (a re-baked key is exactly the regression this
//            cutover exists to make impossible).
//   LIVE     the relay that will serve the rail must answer: GET /api/v1/version (names the
//            build — and proves reachability before we blame the route), then POST
//            /api/v1/solana/rpc {jsonrpc:'2.0',id:1,method:'getHealth'} must return 2xx with a
//            healthy JSON-RPC result. 404 on the route = the relay is NOT deployed with the R2
//            proxy; any other non-2xx, an unreachable relay, or an RPC-level error is the same
//            refusal: this build would ship a wallet whose default Solana path is dark.
//
//            Since 2026-09-10 the shipping callers (scripts/build-apk.sh, deploy/build.sh) run
//            this against a relay STAGED FROM THE TREE (scripts/stage-relay-probe.sh) via
//            DPAY_RELAY_BASE — the verdict is about the build being shipped (its relay code +
//            the deploy env's provider endpoint + the upstream), never about deploy state.
//            Probing production instead coupled every build to whatever was last deployed and
//            deadlocked the first R2 ship.
//
// TWO MODES (contract unchanged):
//
//   node scripts/check-prod-sol.mjs              STRICT (default) — static + live. Used by every
//                                                path that ships a bundle: scripts/build-apk.sh
//                                                (the APK) and deploy/build.sh (the relay image,
//                                                i.e. the WEB bundle served at /wallet).
//   node scripts/check-prod-sol.mjs --no-probe   STATIC ONLY, no network. Exactly one caller: the
//                                                `web` recipe in justfile. That recipe is on the
//                                                fully-offline inner loop, where a network call
//                                                would break the offline non-negotiable.
//
// The relay base comes from DPAY_RELAY_BASE (default https://dpay.kalaj.org — the same origin
// the shipped relay list defaults to). Every live request carries a hard timeout: a build box
// that cannot reach the relay fails LOUDLY with the reason, never hangs.
//
// There is no env-var skip, no "probe failed, continue anyway", no fallback endpoint. A probe
// that cannot run is a failed build.
//
// Exit 0 = safe to ship. Exit 1 = every reason, listed.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const PROBE_TIMEOUT_MS = 10_000;
const RELAY_BASE = (process.env.DPAY_RELAY_BASE ?? 'https://dpay.kalaj.org').replace(/\/+$/, '');

const probeEnabled = !process.argv.includes('--no-probe');
const unknown = process.argv.slice(2).filter((a) => a !== '--no-probe');
if (unknown.length) {
  console.error(`check-prod-sol: unknown argument(s): ${unknown.join(' ')} (only --no-probe is accepted)`);
  process.exit(1);
}

// Collect every reason before exiting (same idiom as scripts/check-web-prod-seams.mjs): an operator
// deserves the whole verdict in one run, not one failure per build. `notes` carries the halves that
// PASSED, so a failing run still says which half was fine.
const findings = [];
const notes = [];

// ── STATIC: the R2 invariant ─────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const constantsPath = join(here, '..', 'app', 'config', 'constants.ts');
const src = readFileSync(constantsPath, 'utf8');

if (/helius|api-key=/i.test(src)) {
  findings.push([
    'app/config/constants.ts carries a provider URL/API-key literal again',
    '    R2 moved the provider key to relay configuration; it must never ship in a client bundle.',
    '    The default derives from the relay base (setRelayBaseForSolana / SOLANA_RPC_PROXY_PATH).',
  ]);
}
if (!src.includes("export const SOLANA_RPC_PROXY_PATH = '/api/v1/solana/rpc'")) {
  findings.push([
    'the derived Solana proxy path is missing or changed in app/config/constants.ts',
    "    Expected `export const SOLANA_RPC_PROXY_PATH = '/api/v1/solana/rpc'` — the fixed route the",
    '    relay\u2019s R2 proxy serves. If the route moved, update this gate AND the relay together.',
  ]);
} else if (!/helius|api-key=/i.test(src)) {
  notes.push('static: constants.ts derives the endpoint from the relay base — no provider key in the client');
}

// ── LIVE: the relay that serves the rail ─────────────────────────────────────────────────────
/** One fetch under a hard deadline — the offline-safe contract: an unreachable or hung relay
 *  fails LOUDLY with the reason, never stalls the build. */
async function timedFetch(url, init) {
  return fetch(url, {...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)});
}

/** The failure wording for a fetch that threw, timeout named as a timeout. */
const why = (e) => (e?.name === 'TimeoutError'
  ? `did not answer within ${PROBE_TIMEOUT_MS} ms`
  : `is unreachable: ${e?.message ?? e}`);

/** Collapse a body to one short diagnosis line — this is a verdict, not a body dump. */
const oneline = (text) => text.replace(/\s+/g, ' ').trim().slice(0, 200);

if (probeEnabled) {
  // 1. Version — proves the relay is reachable at all and names the build that would serve the rail.
  let relayAnswered = false;
  try {
    const r = await timedFetch(`${RELAY_BASE}/api/v1/version`);
    const body = oneline(await r.text().catch((e) => `<body unreadable: ${e?.message ?? e}>`));
    if (!r.ok) {
      findings.push([`the relay at ${RELAY_BASE} answered HTTP ${r.status} on /api/v1/version: ${body}`]);
    } else {
      relayAnswered = true;
      let v = null;
      try { v = JSON.parse(body); } catch { /* non-JSON version body — noted without its fields */ }
      notes.push(v?.commit
        ? `relay: ${RELAY_BASE} (commit ${v.commit}${v.commit_date ? `, ${v.commit_date}` : ''})`
        : `relay: ${RELAY_BASE} answered /api/v1/version (non-JSON body)`);
    }
  } catch (e) {
    findings.push([
      `the relay at ${RELAY_BASE} ${why(e)} — the Solana proxy cannot be probed`,
      '    A build box that cannot reach the relay cannot ship the rail it serves. Fix connectivity',
      '    or point DPAY_RELAY_BASE at the relay this build will talk to, then re-run.',
    ]);
  }

  // 2. The proxy route itself. Only probed once the relay ANSWERED something — a dead relay would
  //    404 everywhere, and one loud connectivity reason is enough.
  if (relayAnswered) {
    try {
      const r = await timedFetch(`${RELAY_BASE}/api/v1/solana/rpc`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getHealth'}),
      });
      const body = oneline(await r.text().catch((e) => `<body unreadable: ${e?.message ?? e}>`));
      if (r.status === 404) {
        findings.push([
          `${RELAY_BASE} answered HTTP 404 on /api/v1/solana/rpc — this relay does not serve the R2 proxy route`,
          '    Against a STAGED relay (the shipping builds) that is a regression in this tree: the relay',
          '    source lost /api/v1/solana/rpc (spec 2026-09-09 §"Direction 1"). Against a relay you named',
          '    via DPAY_RELAY_BASE, that relay predates R2. A wallet pointing at a relay without the',
          '    route ships a dark Solana rail.',
        ]);
      } else if (r.status === 503 && /solana-unconfigured/.test(body)) {
        findings.push([
          `the Solana proxy at ${RELAY_BASE} answered 503 solana-unconfigured`,
          '    The relay has no DPAY_SOLANA_RPC_URL — its Solana rail is dark by configuration.',
          '    stage-relay-probe.sh reads it from deploy/.env; add the FULL provider endpoint',
          '    (incl. api key — deploy/.env.example) there and re-run.',
        ]);
      } else if (!r.ok) {
        findings.push([`the Solana proxy at ${RELAY_BASE} answered HTTP ${r.status}: ${body}`]);
      } else {
        let j = null;
        try { j = JSON.parse(body); } catch {
          findings.push([`the Solana proxy at ${RELAY_BASE} answered HTTP ${r.status} with a non-JSON body: ${body}`]);
        }
        if (j !== null) {
          if (j.error) {
            findings.push([`the Solana proxy at ${RELAY_BASE} returned an RPC error: ${j.error.message ?? JSON.stringify(j.error)}`]);
          } else if (j.result !== 'ok') {
            findings.push([`the Solana proxy at ${RELAY_BASE}: getHealth returned ${JSON.stringify(j.result)}, not "ok" — the upstream node is not healthy`]);
          } else {
            notes.push('liveness: POST /api/v1/solana/rpc getHealth \u2192 "ok"');
          }
        }
      }
    } catch (e) {
      findings.push([`the Solana proxy at ${RELAY_BASE} ${why(e)}`]);
    }
  }
}

if (findings.length) {
  console.error('check-prod-sol: FAIL — this Solana path must not ship:');
  for (const [head, ...rest] of findings) {
    console.error(`  \u2717 ${head}`);
    for (const line of rest) console.error(line);
  }
  for (const n of notes) console.error(`  \u00b7 ${n}`);
  process.exit(1);
}

console.log(
  probeEnabled
    ? `check-prod-sol: PASS — ${RELAY_BASE} serves /api/v1/solana/rpc (getHealth "ok") and constants.ts carries no provider key`
    : `check-prod-sol: PASS (static only, --no-probe) — constants.ts derives the relay proxy path and carries no provider key; the live route was NOT checked`,
);
