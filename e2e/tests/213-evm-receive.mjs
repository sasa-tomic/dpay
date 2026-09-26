// Flow 213 — the device-derived EVM address (D28 / D14): the same Identity.secretHex that
// derives the Solana key derives the EVM key at m/44'/60'/0'/0/0, and the wallet renders that
// EIP-55-checksummed address everywhere (Balances + Receive ▸ My address, bare-address QR,
// no explorer link on Anvil).
//
// LIVE (this skeleton): the full derivation+staging contract, UI-independent —
//   1. the SLIP-10 secp256k1 implementation against the OFFICIAL test vectors (TV1+TV2: chain
//      codes, child keys, pubkeys, hardened AND normal chains);
//   2. deriveEvmKeypair determinism + EIP-55 self-consistency;
//   3. staging integration: a chain funded through the device-seed ladder lands on EXACTLY the
//      derived address (the same address `just evm-anvil` funds — anvil.mjs and this flow share
//      evm-core.mjs, the vector-proven implementation).
// TODO(app-ui) — the legs that need the app surface + the app/evm seam (owned by other streams):
//   - onboard seeded, read `dpay.identity.v1`.secretHex, expect deriveEvmAddress(secretHex);
//   - open Receive ▸ My address: rendered 0x == expected (EIP-55 spelled), QR payload == the bare
//     checksummed address, copy works, NO explorer link on Anvil (explorer: null);
//   - zero RPC at render (the seam pinned to '' during the phase — the flow-46 offline discipline).
import {
  deriveSlip10Secp256k1Node, deriveEvmKeypair, eip55, evmAddressOf, rpc, ethCall,
  encodeErc20BalanceOf, decodeUint256,
} from '../harness/evm/evm-core.mjs';
import {stageAnvil, DEV_DEFAULT_ZCHF_RAW} from '../harness/evm/anvil.mjs';
import {devSeed} from '../harness/evm/pipe.mjs';
import {secp256k1} from '@noble/curves/secp256k1';
import {sha256} from '@noble/hashes/sha2';

export const meta = {
  id: '213',
  name: 'evm-receive',
  journey: 'deposit',
  covers: ['evm-identity', 'slip10-secp256k1', 'eip55', 'evm-device-address'],
  verifies: 'EVM receive address: the SLIP-10 secp256k1 derivation is pinned to the official test vectors and the device EVM address (m/44\'/60\'/0\'/0/0 over Identity.secretHex) is EIP-55-checksummed, deterministic, and exactly what the harness stages funds to; the app renders it (Balances + Receive ▸ My address QR, no explorer on Anvil) — those UI legs are stubbed in this skeleton.',
  timeoutMs: 90_000,
  optional: true, // excluded from the default suite until the UI legs land (needs the app/evm seam)
};

const assert = (ok, msg) => { if (!ok) throw new Error(`[213] ${msg}`); };
const H = (i) => i + 0x80000000;

export async function run() {
  const start = Date.now();
  console.log('[213-evm-receive] SLIP-10 official vectors (secp256k1 TV1 + TV2)…');
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
  console.log('[213-evm-receive]  ✓ 12 chains across TV1+TV2 (chain codes + child keys + pubkey form)');

  console.log('[213-evm-receive] deriveEvmKeypair determinism + EIP-55 self-consistency…');
  const deviceSeed = devSeed('213-device');
  const a = deriveEvmKeypair(deviceSeed);
  const b = deriveEvmKeypair(Buffer.from(deviceSeed, 'hex'));
  assert(a.address === b.address && a.privateKeyHex === b.privateKeyHex, 'derivation must be deterministic over hex string AND raw bytes');
  assert(a.address === eip55(a.address.toLowerCase()), `derived address ${a.address} must be EIP-55-checksummed`);
  assert(a.address === eip55(evmAddressOf(a.privateKeyHex)), 'address must round-trip through the private key');
  const other = deriveEvmKeypair(devSeed('213-other'));
  assert(other.address !== a.address, 'different seeds must give different addresses');
  console.log(`[213-evm-receive]  ✓ deterministic EIP-55 address ${a.address}`);

  console.log('[213-evm-receive] staging integration: fund the derived device address on a scratch anvil…');
  const staged = await stageAnvil({recipients: [{seed: deviceSeed, zchfRaw: DEV_DEFAULT_ZCHF_RAW, ethWei: 10_000_000_000_000n}]});
  try {
    const device = staged.accounts[0];
    assert(device.address === a.address, `staged device ${device.address} != derived ${a.address} — the harness ladder and the rail derivation disagree`);
    const onChain = decodeUint256(await rpc(staged.rpcUrl, 'eth_call', [{to: staged.tokenAddress, data: encodeErc20BalanceOf(a.address)}, 'latest'], {timeoutMs: 5_000}));
    assert(onChain === DEV_DEFAULT_ZCHF_RAW, `on-chain device balance ${onChain} != staged ${DEV_DEFAULT_ZCHF_RAW}`);
    console.log(`[213-evm-receive]  ✓ staged + funded: ${a.address} holds ${onChain} raw ZCHF on chain ${staged.chainId}`);

    // TODO(app-ui): onboard seeded (dpay.identity.v1 = {secretHex: <deviceSeed>}), open
    // Receive ▸ My address, and assert the rendered address == a.address (EIP-55 spelled),
    // the QR payload == the bare checksummed address, copy works, and NO explorer link renders
    // on Anvil (EVM_CHAINS[31337].explorer === null). Pin zero RPC at render with the seam ''.
    console.log('[213-evm-receive]  · TODO(app-ui): rendered-address / QR / copy / no-explorer legs are stubbed');
  } finally {
    await staged.stop();
  }
  console.log(`[213-evm-receive] PASS (${Date.now() - start}ms)`);
}
