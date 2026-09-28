// Flow 218 — the device-derived EVM address (D28 / D14), through the REAL app: the same
// Identity.secretHex that derives the Solana key derives the EVM key at m/44'/60'/0'/0/0, and
// the wallet renders that EIP-55-checksummed address everywhere (Balances row + Receive ▸ My
// address, bare-address QR, copy, NO explorer link on Anvil).
//
// LIVE:
//   1. the SLIP-10 secp256k1 implementation against the OFFICIAL test vectors (TV1+TV2: chain
//      codes, child keys, pubkeys, hardened AND normal chains);
//   2. deriveEvmKeypair determinism + EIP-55 self-consistency;
//   3. the ONBOARD IDENTITY's secretHex (read from the app's own storage) derives exactly the
//      address the UI renders — Balances row and Receive ▸ My address agree, the QR payload is
//      the bare checksummed address, copy exists, and Anvil (explorer: null) renders NO
//      explorer link. The address surface renders with the connectivity oracle pinned OFFLINE —
//      it is pure derivation and needs no RPC (D14's zero-RPC-at-render discipline).
//   4. staging integration: the funded address is funded THROUGH the harness relay's evm pipe,
//      and the balance poll (the app's own) shows the credited amount on the row.
import {
  deriveSlip10Secp256k1Node, deriveEvmKeypair, eip55, evmAddressOf,
} from '../harness/evm/evm-core.mjs';
import {stagePipe, devSeed} from '../harness/evm/pipe.mjs';
import {ANVIL_ACCOUNT_0_PRIV, DEV_DEFAULT_ZCHF_RAW, fundEth, transferToken} from '../harness/evm/anvil.mjs';
import {secp256k1} from '@noble/curves/secp256k1';
import {setup, onboardWallet, waitForWallet, accountOf, selectEvmAsset} from '../harness/lib.mjs';

export const meta = {
  id: '218',
  name: 'evm-receive',
  journey: 'deposit',
  covers: ['evm-identity', 'slip10-secp256k1', 'eip55', 'evm-device-address'],
  verifies: 'EVM receive address: the SLIP-10 secp256k1 derivation is pinned to the official test vectors, the onboard identity\'s own seed derives the EIP-55-checksummed EVM address the app renders (Balances row + Receive ▸ My address: bare-address QR, copy, no explorer on Anvil), and the address surface renders with connectivity pinned offline (pure derivation, zero RPC needed).',
  timeoutMs: 300_000, // pays a cold harness-relay build on a fresh worktree (warm: ~8s)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[218] ${msg}`); };
const H = (i) => i + 0x80000000;

export async function run() {
  const start = Date.now();
  console.log('[218-evm-receive] SLIP-10 official vectors (secp256k1 TV1 + TV2)…');
  const seed1 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  // (chain code, private key) pairs from slip-0010.md — chain codes pin the HMAC data shape
  // (37 bytes: 0x00||IL or serP(K) + index), privkeys pin the (IL + parent) mod n child rule.
  const tv1 = [
    [[], '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508', 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35'],
    [[H(0)], '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141', 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea'],
    [[H(0), 1], '2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19', '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368'],
    [[H(0), 1, H(2)], '04466b9cc8e161e966409ca52986c584f07e9dc81f735db683c3ff6ec7b1503f', 'cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca'],
    [[H(0), 1, H(2), 2], 'cfb71883f01676f587d023cc53a35bc7f88f724b1f8c2892ac1275ac822a3edd', '0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4'],
    [[H(0), 1, H(2), 2, 1000000000], 'c783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e', '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8'],
  ];
  const seed2 = Buffer.from('fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542', 'hex');
  const tv2 = [
    [[], '60499f801b896d83179a4374aeb7822aaeaceaa0db1f85ee3e904c4defbd9689', '4b03d6fc340455b363f51020ad3ecca4f0850280cf436c70c727923f6db46c3e'],
    [[0], 'f0909affaa7ee7abe5dd4e100598d4dc53cd709d5a5c2cac40e7412f232f7c9c', 'abe74a98f6c7eabee0428f53798f0ab8aa1bd37873999041703c742f15ac7e1e'],
    [[0, 2147483647 + H(0)], 'be17a268474a6bb9c61e1d720cf6215e2a88c5406c4aee7b38547f585c9a37d9', '877c779ad9687164e9c2f4f0f4ff0340814392330693ce95a58fe18fd52e6e93'],
    [[0, 2147483647 + H(0), 1], 'f366f48f1ea9f2d1d3fe958c95ca84ea18e4c4ddb9366c336c927eb246fb38cb', '704addf544a06e5ee4bea37098463c23613da32020d604506da8c0518e1da4b7'],
    [[0, 2147483647 + H(0), 1, 2147483646 + H(0)], '637807030d55d01f9a0cb3a7839515d796bd07706386a6eddf06cc29a65a0e29', 'f1c7c871a54a804afe328b4c83a1c33b8e5ff48f5087273f04efa83b247d6a2d'],
    [[0, 2147483647 + H(0), 1, 2147483646 + H(0), 2], '9452b549be8cea3ecb7a84bec10dcfd94afe4d129ebfd3b3cb58eedf394ed271', 'bb7d39bdb83ecf58f2fd82b6d918341cbef428661ef01ab97c28a4842125ac23'],
  ];
  for (const [seed, vectors, label] of [[seed1, tv1, 'TV1'], [seed2, tv2, 'TV2']]) {
    for (const [path, chainCode, privKey] of vectors) {
      const n = deriveSlip10Secp256k1Node(seed, path);
      assert(n.chainCode.toString('hex') === chainCode, `${label} chain code mismatch at m/${path.join('/')}`);
      assert(n.privateKey.toString('hex') === privKey, `${label} child key mismatch at m/${path.join('/')}`);
      assert(Buffer.from(secp256k1.getPublicKey(n.privateKey, true)).toString('hex').length === 66, `${label} pubkey form at m/${path.join('/')}`);
    }
  }
  console.log('[218-evm-receive]  ✓ 12 chains across TV1+TV2 (chain codes + child keys + pubkey form)');

  console.log('[218-evm-receive] deriveEvmKeypair determinism + EIP-55 self-consistency…');
  const deviceSeed = devSeed('218-device');
  const a = deriveEvmKeypair(deviceSeed);
  const b = deriveEvmKeypair(Buffer.from(deviceSeed, 'hex'));
  assert(a.address === b.address && a.privateKeyHex === b.privateKeyHex, 'derivation must be deterministic over hex string AND raw bytes');
  assert(a.address === eip55(a.address.toLowerCase()), `derived address ${a.address} must be EIP-55-checksummed`);
  assert(a.address === eip55(evmAddressOf(a.privateKeyHex)), 'address must round-trip through the private key');
  const other = deriveEvmKeypair(devSeed('218-other'));
  assert(other.address !== a.address, 'different seeds must give different addresses');
  console.log(`[218-evm-receive]  ✓ deterministic EIP-55 address ${a.address}`);

  // ── The app legs: stage the pipe, boot the app on it, drive the REAL surfaces ────────────────
  console.log('[218-evm-receive] staging the relay pipe + anvil, booting the app…');
  const env = await stagePipe({recipients: []});
  const app = await setup({relay: env.relay.baseURL, evmRpcUrl: 'derive'});
  const {driver} = app;
  try {
    await onboardWallet(driver, 'evm-218');
    const id = await accountOf(driver);
    assert(id && typeof id.secretHex === 'string' && id.secretHex.length === 64, 'the app identity must carry a 64-hex seed');
    const device = deriveEvmKeypair(id.secretHex);
    assert(device.address === eip55(device.address.toLowerCase()), 'the identity-derived address must be EIP-55-checksummed');
    console.log(`[218-evm-receive]  ✓ onboard identity derives ${device.address}`);

    // Fund the DERIVED address through anvil (the harness ladder), then watch the app's own
    // balance poll show it on the row.
    await fundEth(env.anvil.rpcUrl, device.address, 10_000_000_000_000n);
    await transferToken(env.anvil.rpcUrl, env.anvil.tokenAddress, ANVIL_ACCOUNT_0_PRIV, device.address, DEV_DEFAULT_ZCHF_RAW);

    await waitForWallet(driver);
    await selectEvmAsset(driver, 'evm-zchf-anvil');
    console.log('[218-evm-receive]  ✓ EVM asset selected (Balances row → Pay engine)');

    // Receive ▸ My address: the rendered address IS the derivation, EIP-55 spelled.
    await driver.click('tab-receive');
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    const addrNode = await driver.findByTestID('evm-recv-address', {timeoutMs: 5_000});
    const rendered = (await addrNode.evaluate((n) => (n.textContent ?? '').trim())).trim();
    assert(rendered === device.address, `rendered address ${rendered} != derived ${device.address}`);
    // The QR payload is the BARE checksummed address (D14 — no URI scheme, no EIP-681).
    const qrValue = await driver.eval(() => window.__DPAY_QR_LAST);
    assert(qrValue === device.address, `QR payload ${JSON.stringify(qrValue)} must be the bare checksummed address`);
    // Copy affordance exists; Anvil (explorer: null) renders NO explorer link.
    await driver.findByTestID('btn-evm-recv-copy', {timeoutMs: 3_000});
    assert(!(await driver.isPresent('evm-recv-explorer')), 'no explorer link may render on Anvil (explorer: null)');
    console.log('[218-evm-receive]  ✓ Receive ▸ My address: rendered == derived, bare-address QR, copy, no explorer');

    // Zero-RPC-at-render: pin the connectivity oracle OFFLINE, flip the sub-mode away and back —
    // the address surface re-renders identically (pure derivation; the balance rows degrade to
    // their last-known/'—' honestly instead of the address ever disappearing).
    await driver.eval(() => { globalThis.__DPAY_TEST_EVM_CONNECTIVITY = 'offline'; });
    await driver.click('btn-receive-request', {timeoutMs: 5_000});
    await driver.click('btn-receive-address', {timeoutMs: 5_000});
    const again = await driver.findByTestID('evm-recv-address', {timeoutMs: 5_000});
    assert((await again.evaluate((n) => (n.textContent ?? '').trim())) === device.address, 'the address must render with connectivity offline (no RPC in the render path)');
    await driver.eval(() => { delete globalThis.__DPAY_TEST_EVM_CONNECTIVITY; });
    console.log('[218-evm-receive]  ✓ address renders offline-pinned (zero RPC in the render path)');
  } finally {
    await app.stop();
    await env.stop();
  }
  console.log(`[218-evm-receive] PASS (${Date.now() - start}ms)`);
}
