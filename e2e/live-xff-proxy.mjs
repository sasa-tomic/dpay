#!/usr/bin/env node
// e2e/live-xff-proxy.mjs — loopback reverse proxy that fronts the LOCAL mainnet relay so the
// app's CeFi fetches carry a measured PUBLIC end-user IP to SideShift.
//
// WHY: browser fetch cannot set X-Forwarded-For, and crates/dpay-relay/src/sideshift.rs only
// honors the LEFTMOST PUBLIC XFF entry when its TCP peer is loopback/private (a public peer's
// XFF is ignored as spoofable — correct for prod, fatal for a local run: the peer IS loopback,
// so without this proxy the venue sees a loopback/`x-user-ip` and refuses every partner
// request). The app dials THIS proxy; the proxy forwards to the real relay adding
// `X-Forwarded-For: <measured public IP>`.
//
// Usage: node e2e/live-xff-proxy.mjs [listenPort] [upstream]   (defaults 8898 → http://127.0.0.1:8899)
// The public IP is measured at startup (api.ipify.org, then ifconfig.me) — never hardcoded.

const LISTEN = Number(process.argv[2] ?? 8898);
const UPSTREAM = process.argv[3] ?? 'http://127.0.0.1:8899';

async function measureIp() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(10_000)});
      const t = (await r.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t;
    } catch { /* next */ }
  }
  throw new Error('could not measure the public IP — refusing to guess (the venue refuses private x-user-ip)');
}

const PUB = await measureIp();
console.log(`[xff-proxy] public IP measured: ${PUB}`);
console.log(`[xff-proxy] listening http://127.0.0.1:${LISTEN} -> ${UPSTREAM}`);

import {createServer, request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';

createServer((req, res) => {
  const u = new URL(req.url, UPSTREAM);
  const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = {...req.headers};
  delete headers.host;
  // Leftmost-public: this proxy is the ONLY writer — no chaining ambiguity.
  headers['x-forwarded-for'] = PUB;
  const up = mod({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
    method: req.method,
    headers,
  }, (ur) => {
    console.log(`[xff-proxy] ${req.method} ${u.pathname} -> ${ur.statusCode}`);
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    console.error(`[xff-proxy] upstream error ${req.method} ${req.url}: ${e.message}`);
    try { res.writeHead(502, {'content-type': 'application/json'}); } catch { /* sent */ }
    res.end(JSON.stringify({error: {message: `xff-proxy upstream: ${e.message}`}}));
  });
  req.pipe(up);
}).listen(LISTEN, '127.0.0.1', () => { /* listening */ });
