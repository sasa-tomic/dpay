// Build a `getTransaction` json-detail fixture from a CAPTURED real signed solpay:v2 URI.
//
// The settle gate (broadcastSolPayment, OPEN_ISSUES 6(b)) re-reads the confirmed transaction and
// requires its recompiled legacy message to be byte-equal to the canonical message the merchant
// verified. The happy fixtures for the e2e SOL broadcast flows (51/74) must therefore derive FROM
// the real canonical bytes the payer signed — that is exactly what makes them matching. This
// helper decodes the solpay payload (compact-u16 sigCount || sig(64) || legacy message) and
// re-serializes the message into the json shape `SolanaTransactionDetail` describes (base58
// accountKeys + blockhash, base64 instruction data, legacy version).
//
// `over.message` / `over.meta` / `over.metaNull` splice deliberate defects for the mismatch and
// onchain-error flows (138): a wrong-amount body, a v0/ALT claim, meta.err — the fixture stays
// structurally real so only the spliced field differs.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58_ALPHABET[Number(n % 58n)] + s;
    n = n / 58n;
  }
  // Leading zero bytes → leading '1's.
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

function readCompactU16(bytes, off) {
  let value = 0;
  let shift = 0;
  let i = off;
  for (;;) {
    const b = bytes[i];
    i++;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return {value, next: i};
    shift += 7;
  }
}

function bytesToBase64B(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * @param {string} solpayUri — a captured `solpay:v2?…` URI (the payer's signed handoff).
 * @param {{slot?: number, err?: unknown, metaNull?: boolean, message?: Record<string, unknown>}} [over]
 * @returns the json detail a real getTransaction would return for this tx (or a spliced variant).
 */
export function solTxDetailFromSolpay(solpayUri, over = {}) {
  const payload = solpayUri.split('solpay:v2?')[1];
  if (!payload) throw new Error('solTxDetailFromSolpay: not a solpay:v2 URI');
  const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const tx = Buffer.from(obj.tx, 'base64url');
  // Skip compact-u16 sigCount + sigCount×64 signature bytes; the legacy message follows.
  const sigs = readCompactU16(tx, 0);
  const msg = tx.subarray(sigs.next + sigs.value * 64);

  let off = 0;
  const header = {
    numRequiredSignatures: msg[off++],
    numReadonlySignedAccounts: msg[off++],
    numReadonlyUnsignedAccounts: msg[off++],
  };
  const nk = readCompactU16(msg, off);
  off = nk.next;
  const accountKeys = [];
  for (let i = 0; i < nk.value; i++) {
    accountKeys.push(bs58Encode(msg.subarray(off, off + 32)));
    off += 32;
  }
  const recentBlockhash = bs58Encode(msg.subarray(off, off + 32));
  off += 32;
  const ni = readCompactU16(msg, off);
  off = ni.next;
  const instructions = [];
  for (let i = 0; i < ni.value; i++) {
    const programIdIndex = msg[off++];
    const na = readCompactU16(msg, off);
    off = na.next;
    const accounts = [];
    for (let j = 0; j < na.value; j++) accounts.push(msg[off++]);
    const nd = readCompactU16(msg, off);
    off = nd.next;
    instructions.push({programIdIndex, accounts, data: bytesToBase64B(msg.subarray(off, off + nd.value))});
    off += nd.value;
  }
  return {
    slot: over.slot ?? 250_000_003,
    blockTime: Math.floor(Date.now() / 1000),
    meta: over.metaNull ? null : {err: over.err ?? null, fee: 5000, preBalances: [], postBalances: [], ...over.meta},
    transaction: {message: {accountKeys, recentBlockhash, header, instructions, version: 'legacy', ...over.message}},
  };
}
