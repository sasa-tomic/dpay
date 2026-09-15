// The SideShift offline stand-in (flow 187, 2026-09-15) — the PAGE half only.
//
// Split of the venue's surface in the e2e world (mirrors the real credential split the
// relay encodes): QUOTES and fixed-ORDER creation go through the REAL app → REAL relay
// route (POST /api/v1/sideshift/*), where the relay's own test-helpers stub
// (/api/v1/test/sideshift-upstream, src/app.rs) stands in for sideshift.ai — that path
// exercises the partner-key attach server-side and its counters prove the credential
// rode the relay, not the device. What lives HERE is the OTHER half: shift STATUS reads,
// which in production are SideShift's own KEYLESS device-direct GET
// (https://sideshift.ai/api/v2/shifts/{id} — verified keyless live 2026-09-15). This
// stub intercepts exactly that origin+path in the page and serves a scripted lifecycle
// the flow advances between waiting → multiple → settled (+ expired/refunded variants).
//
// Fail-closed like every harness fetch stub: passOrigins (relay/web origins) go through
// to the real fetch, non-http(s) schemes pass, the sideshift origin is matched ONLY on
// the shifts path, and ANY other origin is recorded and thrown — an unexpected origin is
// a bug in the app's network surface, not something to paper over. As in jupiter.mjs,
// passOrigins must NOT list the stub's own origin: the stub checks passOrigins BEFORE
// its own match, so self-passing would hand the status read to the real internet.
//
// The bodies speak SideShift's own wire vocabulary (their shift examples): top-level
// `status` word ("waiting"/"multiple"/"settled"/"refunded"/"expired"), camelCase
// `settleAmount` (decimal string, venue units) and `settleHash` — the words and fields
// app/convertResume.ts's PROVIDER_STATUS_MAP was extended to serve.

/** Install the window.fetch replacement. `cfg`: {passOrigins: string[], initialStatus?}. */
export async function installSideShiftStub(driver, cfg) {
  await driver.eval((c) => {
    const st = {
      status: c.initialStatus ?? 'waiting',
      extra: {},
      statusCalls: [], // every status GET, in order — the flow audits the keying
      unexpected: [],
    };
    globalThis.__E2E_SIDESHIFT = st;
    const pass = (c.passOrigins ?? []).map((o) => new URL(o).origin);
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) ?? String(input);
      let u;
      try { u = new URL(url); } catch { return realFetch(input, init); }
      if (!u.protocol.startsWith('http')) return realFetch(input, init);
      const origin = u.origin;
      if (pass.includes(origin)) return realFetch(input, init);
      if (origin === 'https://sideshift.ai' && u.pathname.startsWith('/api/v2/shifts/')) {
        const id = u.pathname.split('/').filter(Boolean).pop();
        st.statusCalls.push({id});
        return new Response(JSON.stringify({id, status: st.status, ...st.extra}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        });
      }
      st.unexpected.push(url);
      throw new TypeError(`sideshift stub: unexpected origin ${origin}`);
    };
  }, {passOrigins: cfg.passOrigins, initialStatus: cfg.initialStatus});
}

/** Advance the scripted lifecycle: the next status GET answers `status` merged with `extra`
 *  (e.g. {settleAmount: '0.0495', settleHash: '…'} for the settled terminal). */
export async function setSideShiftStatus(driver, status, extra = {}) {
  await driver.eval((s, x) => {
    const st = globalThis.__E2E_SIDESHIFT;
    if (st == null) throw new Error('sideshift stub not installed');
    st.status = s;
    st.extra = x;
  }, status, extra);
}

/** Read the stub's audit state: {status: <current word>, statusCalls, unexpected}. */
export async function sideShiftStubState(driver) {
  return driver.eval(() => {
    const st = globalThis.__E2E_SIDESHIFT;
    if (st == null) return null;
    return {status: st.status, statusCalls: st.statusCalls.slice(), unexpected: st.unexpected.slice()};
  });
}
