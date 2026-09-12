// Pay-link URL reader for e2e — `app/lib/deepLink.ts` (encodePayLink) is the grammar's source of
// truth; this mirrors just enough for a flow to assert what the payer's camera would open.
// Founder decision 2026-09-12: the request QR IS this link on every rail, so flows that used to
// decode the QR as a machine code now parse it here.
//
//   https://<origin>/wallet/pay/<recipient>?asset=…&network=…&amount=…[&label=&memo=&ref=]
//
// On web the app bakes its own page origin into the link (the e2e web server's origin), so the
// base below only matters for origin-relative strings; flows assert pathname + params, and the
// recipient is the wallet's principal (IC) or base58 address (SOL).
export function parsePayLink(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let u;
  try {
    u = new URL(url, 'https://dpay.invalid');
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/wallet\/pay\/([^/?#]+)$/);
  if (!m) return null;
  return {
    href: u.href,
    recipient: decodeURIComponent(m[1]),
    asset: u.searchParams.get('asset') ?? '',
    network: u.searchParams.get('network') ?? '',
    amount: u.searchParams.get('amount') ?? '',
    label: u.searchParams.get('label') ?? '',
    memo: u.searchParams.get('memo') ?? '',
    ref: u.searchParams.get('ref'), // null when absent — the SOL rail attaches no reconciliation memo
  };
}
