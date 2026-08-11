#!/usr/bin/env node
// AID parity assertion (NFC OS-routing invariant).
//
// Each dpay NFC AID lives in TWO places with NO compile-time link:
//   • the OS-routing XML  <aid-filter android:name="F0…"/>  (Android matches the SELECT AID here)
//   • the in-protocol byte literal the card/reader compares against at runtime
// A mismatch is silent: the OS routes the SELECT to dpay's HCE service, but the service's own AID
// check rejects it (or vice-versa) → the tap dies with an opaque "not a dpay phone" / SW_NOT_READY
// that sails through every headless gate (the radio hop is a device-only path). This script is the
// static net: decode the XML hex and assert byte-equality against the literal, sub-second, no device.
//
// Sources (2 AIDs):
//   IC  AID: crates/dpay-core/src/nfc/mod.rs `pub const AID`          vs  res/xml/apduservice.xml
//   SOL AID: app/android/.../DpaySolNfc.kt   `private val SOL_AID`    vs  res/xml/solapduservice.xml
//
// Usage: node scripts/aid-parity.mjs   (exit 0 = parity, exit 1 = drift)
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NFC_RS = `${ROOT}crates/dpay-core/src/nfc/mod.rs`;
const SOL_NFC_KT = `${ROOT}app/android/app/src/main/java/com/dpay/DpaySolNfc.kt`;
const IC_XML = `${ROOT}app/android/app/src/main/res/xml/apduservice.xml`;
const SOL_XML = `${ROOT}app/android/app/src/main/res/xml/solapduservice.xml`;

// Parse a single byte-literal token: 0xF0, 0xF0.toByte(), or a bare decimal. Returns the unsigned
// byte value (0..255). Throws on anything else so a malformed literal fails loud rather than silently
// yielding NaN and then "matching" a garbage XML decode.
function parseByte(tok) {
  const t = tok.trim().replace(/\.toByte\(\)$/, '');
  const m = t.match(/^0x([0-9a-fA-F]+)$/);
  if (m) return parseInt(m[1], 16);
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n < 0 || n > 255) throw new Error(`decimal byte out of range: ${t}`);
    return n;
  }
  throw new Error(`unparseable byte literal: ${t}`);
}

// Pull the Rust IC AID: `pub const AID: [u8; N] = [0xF0, 0x64, ...];`
function icAidRust(src) {
  const m = src.match(/pub\s+const\s+AID\s*:\s*\[u8;\s*\d+\]\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error(`IC AID const not found in ${NFC_RS}`);
  return m[1].split(',').map(parseByte);
}

// Pull the Kotlin SOL AID: `private val SOL_AID = byteArrayOf(0xF0.toByte(), 0x64, ...)`. Greedy match
// to the LAST `)` on the line — the inner `.toByte()` calls nest a `)` of their own, so a non-greedy
// `[^)]+` would truncate at the first one.
function solAidKt(src) {
  const m = src.match(/SOL_AID\s*=\s*byteArrayOf\((.*)\)/);
  if (!m) throw new Error(`SOL_AID literal not found in ${SOL_NFC_KT}`);
  return m[1].split(',').map(parseByte);
}

// Pull the first <aid-filter android:name="HEX"/> from an XML service file.
function aidFilterXml(src, path) {
  const m = src.match(/<aid-filter\s+android:name\s*=\s*"([0-9A-Fa-f]+)"/);
  if (!m) throw new Error(`no <aid-filter> with android:name hex found in ${path}`);
  const hex = m[1];
  if (hex.length % 2 !== 0) throw new Error(`odd-length AID hex '${hex}' in ${path}`);
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const hex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');

const icLit = icAidRust(readFileSync(NFC_RS, 'utf8'));
const icXml = aidFilterXml(readFileSync(IC_XML, 'utf8'), IC_XML);
const solLit = solAidKt(readFileSync(SOL_NFC_KT, 'utf8'));
const solXml = aidFilterXml(readFileSync(SOL_XML, 'utf8'), SOL_XML);

const checks = [
  {label: 'IC  AID', lit: icLit, xml: icXml, litSrc: 'nfc/mod.rs:const AID', xmlSrc: 'apduservice.xml'},
  {label: 'SOL AID', lit: solLit, xml: solXml, litSrc: 'DpaySolNfc.kt:SOL_AID', xmlSrc: 'solapduservice.xml'},
];

const diffs = [];
for (const c of checks) {
  if (c.lit.length !== c.xml.length || c.lit.some((b, i) => b !== c.xml[i])) {
    diffs.push(`- ${c.label}: ${c.litSrc} [${hex(c.lit)}] != ${c.xmlSrc} [${hex(c.xml)}]`);
  }
}

if (diffs.length > 0) {
  console.error('aid-parity FAIL — NFC AID byte literal and XML <aid-filter> disagree:\n' + diffs.join('\n'));
  console.error('\nThe OS routes the tap by the XML AID; the card/reader compares against the literal.');
  console.error('A mismatch breaks routing silently (tap dies as "not a dpay phone" / SW_NOT_READY).');
  console.error('Align both, then re-run.');
  process.exit(1);
}

console.log(`aid-parity OK (${checks.length} AIDs: IC=${hex(icLit)}, SOL=${hex(solLit)})`);
