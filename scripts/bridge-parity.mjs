#!/usr/bin/env node
// Bridge-parity assertion (device-bridge plan Layer 2).
//
// The TS DpayCoreApi/DpayNfcApi interfaces and the Kotlin DpayCoreModule/DpayNfcModule @ReactMethod
// signatures are two hand-written surfaces over the same UniFFI IDL. This asserts they agree on
// METHOD NAME and JS ARITY (Kotlin params minus the trailing `promise: Promise`; TS required params).
// A wire/arity drift not mirrored on both sides fails the build here, sub-second, no device.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CORE_KT = `${ROOT}app/android/app/src/main/java/com/dpay/DpayCoreModule.kt`;
const NFC_KT = `${ROOT}app/android/app/src/main/java/com/dpay/DpayNfcModule.kt`;
const SOL_NFC_KT = `${ROOT}app/android/app/src/main/java/com/dpay/DpaySolNfcModule.kt`;
const TYPES_TS = `${ROOT}app/lib/types.ts`;

// RN emitter-lifecycle plumbing: present on both sides but not app API — never counted in parity.
const LIFECYCLE = new Set(['addListener', 'removeListeners']);

// Parse @ReactMethod fun name(...): JS-arity = params excluding `promise: Promise`. Handles
// multi-line signatures (params have no nested parens, so the non-greedy capture stops at the
// closing `)` of the parameter list).
function parseKotlin(src) {
  const out = {};
  for (const chunk of src.split('@ReactMethod').slice(1)) {
    const m = chunk.match(/fun\s+(\w+)\s*\(([\s\S]*?)\)/);
    if (!m) continue;
    const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
    out[m[1]] = params.filter(p => !/^promise\s*:\s*Promise\b/.test(p)).length;
  }
  return out;
}

// Parse a TS `export type NAME = { ... }` literal. Balanced-brace extraction tolerates return types
// like `Promise<{...}>`. Comments are stripped first so prose mentioning `wireLen()` can't bridge a
// match. Returns {methods: name->required-arity, optional: Set<name>}.
function parseTsInterface(src, typeName) {
  const head = src.match(new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{`));
  if (!head) throw new Error(`TS interface ${typeName} not found in ${TYPES_TS}`);
  const open = head.index + head[0].length - 1; // the `{`
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error(`unbalanced braces in ${typeName}`);
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const methods = {};
  const optional = new Set();
  // `name?( params ): ReturnType` — the trailing `:` (return annotation) excludes comment prose.
  const re = /(\w+)\s*(\?)?\s*\(([\s\S]*?)\)\s*:/g;
  let mm;
  while ((mm = re.exec(body)) !== null) {
    const params = mm[3].split(',').map(p => p.trim()).filter(Boolean);
    methods[mm[1]] = params.filter(p => !/^\w+\s*\?\s*:/.test(p)).length;
    if (mm[2] === '?') optional.add(mm[1]);
  }
  return {methods, optional};
}

// Two-way compare: every non-lifecycle TS method needs a matching-arity Kotlin @ReactMethod, and
// vice-versa. Optional TS methods (nfcStatus?) may be absent in Kotlin; if present, arity must match.
function compare(label, ts, kt) {
  const diffs = [];
  for (const [name, arity] of Object.entries(ts.methods)) {
    if (LIFECYCLE.has(name)) continue;
    if (!(name in kt)) {
      if (!ts.optional.has(name)) diffs.push(`- ${label}.${name}: TS arity ${arity}, MISSING in Kotlin @ReactMethod`);
    } else if (kt[name] !== arity) {
      diffs.push(`~ ${label}.${name}: TS arity ${arity} != Kotlin arity ${kt[name]}`);
    }
  }
  for (const [name, arity] of Object.entries(kt)) {
    if (LIFECYCLE.has(name)) continue;
    if (!(name in ts.methods)) diffs.push(`+ ${label}.${name}: Kotlin @ReactMethod arity ${arity}, MISSING in TS interface`);
  }
  return diffs;
}

const types = readFileSync(TYPES_TS, 'utf8');
const coreTs = parseTsInterface(types, 'DpayCoreApi');
const nfcTs = parseTsInterface(types, 'DpayNfcApi');
const solNfcTs = parseTsInterface(types, 'DpaySolNfcApi');
const coreKt = parseKotlin(readFileSync(CORE_KT, 'utf8'));
const nfcKt = parseKotlin(readFileSync(NFC_KT, 'utf8'));
const solNfcKt = parseKotlin(readFileSync(SOL_NFC_KT, 'utf8'));

const diffs = [
  ...compare('DpayCoreApi', coreTs, coreKt),
  ...compare('DpayNfcApi', nfcTs, nfcKt),
  ...compare('DpaySolNfcApi', solNfcTs, solNfcKt),
];
if (diffs.length > 0) {
  console.error('bridge-parity FAIL — TS interface and Kotlin @ReactMethod disagree:\n' + diffs.join('\n'));
  process.exit(1);
}

const count = (obj) => Object.keys(obj).filter(n => !LIFECYCLE.has(n)).length;
console.log(`bridge-parity OK (${count(coreTs.methods) + count(nfcTs.methods) + count(solNfcTs.methods)} methods)`);
