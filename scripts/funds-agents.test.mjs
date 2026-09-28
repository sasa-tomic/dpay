// The delta math behind the lease report — plain `node scripts/funds-agents.test.mjs`
// (node:test, zero deps, no jest — this must stay runnable on a busy shared box).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {deltaOf, formatSigned, sumDecimals, parseClaims, priceFor, humanAge, capExposure, resolveLabel} from './funds-agents.mjs';

test('deltaOf: claimed minus measured at the max scale of both', () => {
  assert.equal(deltaOf('0.34', '0.35'), '-0.01');
  assert.equal(deltaOf('0.35', '0.34'), '0.01');
  assert.equal(deltaOf('4', '4'), '0');
});

test('deltaOf: trailing zeros never fake a delta', () => {
  assert.equal(deltaOf('0.100', '0.1'), '0');
  assert.equal(deltaOf('0.1', '0.100000'), '0');
  assert.equal(deltaOf('0.128500', '0.1285'), '0');
});

test('deltaOf: never prints -0', () => {
  assert.equal(deltaOf('0.000', '0.0000'), '0');
  assert.equal(formatSigned(0n, 6), '0');
});

test('deltaOf: wei-scale precision survives (18 decimals, no float loss)', () => {
  assert.equal(deltaOf('0.000000000000000001', '0.000000000000000002'), '-0.000000000000000001');
  assert.equal(deltaOf('0.000027670253751', '0.000027670253751'), '0');
});

test('deltaOf: integer amounts', () => {
  assert.equal(deltaOf('3', '5'), '-2');
  assert.equal(deltaOf('4.0', '4'), '0');
});

test('formatSigned trims trailing zeros but keeps the sign', () => {
  assert.equal(formatSigned(-1500n, 2), '-15');
  assert.equal(formatSigned(1500n, 4), '0.15');
  assert.equal(formatSigned(-1n, 8), '-0.00000001');
});

test('sumDecimals: exact across mixed scales', () => {
  assert.equal(sumDecimals(['2', '0.5', '0.0000001']), '2.5000001');
  assert.equal(sumDecimals(['0.1', '0.2']), '0.3');
});

test('priceFor: pegged assets are fixed at 1, chain-qualified labels resolve by base', () => {
  assert.equal(priceFor('VCHF', {}), 1);
  assert.equal(priceFor('ZCHF·Eth', {}), 1);
  assert.equal(priceFor('ckBTC', {bitcoin: 95000}), 95000);
  assert.equal(priceFor('ETH·Arb', {ethereum: 3000}), 3000);
  assert.equal(priceFor('NOPE', {}), null);
});

test('parseClaims: WALLET/ASSET=AMOUNT, registry-checked', () => {
  const claims = parseClaims(['icp-float/ICP=0.01', 'evm-rail/ZCHF·Eth=0.4']);
  assert.deepEqual(claims, [
    {wallet: 'icp-float', asset: 'ICP', amount: '0.01'},
    {wallet: 'evm-rail', asset: 'ZCHF·Eth', amount: '0.4'},
  ]);
});

test('capExposure: sums open caps only, closed leases drop out', () => {
  const leases = [
    {cap_chf: '2', events: [{event: 'open'}]},
    {cap_chf: '0.5', events: [{event: 'open'}, {event: 'close'}]},
    {cap_chf: '0', events: [{event: 'open'}]},
  ];
  assert.equal(capExposure(leases), '2'); // the closed 0.5 lease drops out
  assert.equal(capExposure([leases[0], {cap_chf: '0.5', events: [{event: 'open'}]}]), '2.5'); // both open: exact mixed-scale sum
});

test('humanAge: readable, clamped to non-negative', () => {
  assert.equal(humanAge(0), '0s');
  assert.equal(humanAge(-5), '0s');
  assert.equal(humanAge(90_000), '1m');
  assert.equal(humanAge(3 * 3600_000 + 5 * 60_000), '3h5m');
  assert.equal(humanAge(50 * 3600_000), '2d2h');
});

test('resolveLabel: exact first, then unique base match, ambiguity and misses are null', () => {
  const rows = [{label: 'ETH'}, {label: 'ZCHF·Eth'}, {label: 'ICP'}];
  assert.equal(resolveLabel('ICP', rows), 'ICP');
  assert.equal(resolveLabel('ETH·Eth', rows), 'ETH'); // unique base match
  assert.equal(resolveLabel('ZCHF', rows), 'ZCHF·Eth');
  assert.equal(resolveLabel('BTC', rows), null);
  assert.equal(resolveLabel('ZCHF', [{label: 'ZCHF·Eth'}, {label: 'ZCHF·Arb'}]), null); // ambiguous
});

// die() exits the process, so refusal paths run through the CLI in a child. Bad claims die
// BEFORE anything is written, so these never touch the lease store.
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'funds-agents.mjs');
function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {encoding: 'utf8', timeout: 60_000, cwd: dirname(SCRIPT)});
}
test('CLI refuses bad usage with exit 1 and a die() message', () => {
  for (const args of [
    ['bogus-cmd'],
    ['open'],
    ['open', '--agent', 'x', '--mandate', 'm', '--cap-chf', 'abc'],
    ['open', '--agent', 'x', '--mandate', 'm', '--cap-chf', '1', '--claim', 'nope'],
    ['open', '--agent', 'x', '--mandate', 'm', '--cap-chf', '1', '--claim', 'ghost/ICP=0.01'],
    ['open', '--agent', 'x', '--mandate', 'm', '--cap-chf', '1', '--claim', 'icp-float/ICP=0'],
    ['close', 'no-such-lease-id'],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 1, `expected exit 1 for: funds-agents ${args.join(' ')}`);
    assert.match((r.stderr ?? '') + (r.stdout ?? ''), /funds-agents: /, `expected a die() message for: ${args.join(' ')}`);
  }
});
