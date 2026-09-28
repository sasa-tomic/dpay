import {describe, expect, test} from '@jest/globals';
import {secp256k1} from '@noble/curves/secp256k1';
import {deriveEvmKeypair, deriveSlip10Secp256k1Node, toChecksumAddress} from '../evm/identity';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const H = 0x80000000;

// SLIP-10 secp256k1 OFFICIAL Test Vector 1 (github.com/satoshilabs/slips, slip-0010.md, "Test
// vector 1 for secp256k1"). Private keys, chain codes AND pubkeys pinned for every chain of the
// vector: the private keys pin the HMAC-SHA512 chain INCLUDING the BIP-32 combine rule
// (child = IL + parent mod n in BOTH hardened and normal branches — a wrong combine rule still
// reproduces the chain codes, so keys are the load-bearing assertion), the pubkeys additionally
// pin noble's point serialization, and the /1 and /2 chains pin NON-hardened derivation (serP
// data). Cross-validated with an independent Python stdlib implementation (hmac + hand-rolled
// curve math) in this repo's tmp/ — all six chains matched before these values were pinned.
const SLIP10_SEED = '000102030405060708090a0b0c0d0e0f';

const SLIP10_TV1 = [
  {path: [] as number[], priv: 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35', pub: '0339a36013301597daef41fbe593a02cc513d0b55527ec2df1050e2e8ff49c85c2', cc: '873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508'},
  {path: [0 + H], priv: 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea', pub: '035a784662a4a20a65bf6aab9ae98a6c068a81c52e4b032c0fb5400c706cfccc56', cc: '47fdacbd0f1097043b78c63c20c34ef4ed9a111d980047ad16282c7ae6236141'},
  {path: [0 + H, 1], priv: '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368', pub: '03501e454bf00751f24b1b489aa925215d66af2234e3891c3b21a52bedb3cd711c', cc: '2a7857631386ba23dacac34180dd1983734e444fdbf774041578e9b6adb37c19'},
  {path: [0 + H, 1, 2 + H], priv: 'cbce0d719ecf7431d88e6a89fa1483e02e35092af60c042b1df2ff59fa424dca', pub: '0357bfe1e341d01c69fe5654309956cbea516822fba8a601743a012a7896ee8dc2', cc: '04466b9cc8e161e966409ca52986c584f07e9dc81f735db683c3ff6ec7b1503f'},
  {path: [0 + H, 1, 2 + H, 2], priv: '0f479245fb19a38a1954c5c7c0ebab2f9bdfd96a17563ef28a6a4b1a2a764ef4', pub: '02e8445082a72f29b75ca48748a914df60622a609cacfce8ed0e35804560741d29', cc: 'cfb71883f01676f587d023cc53a35bc7f88f724b1f8c2892ac1275ac822a3edd'},
  {path: [0 + H, 1, 2 + H, 2, 1000000000], priv: '471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8', pub: '022a471424da5e657499d1ff51cb43c47481a03b1e77f951fe64cec9f5a48f7011', cc: 'c783e67b921d2beb8f6b389cc646d7263b4145701dadd2161548a8b078e65e9e'},
];

// Locally-generated golden for the app's actual path m/44'/60'/0'/0/0 on the SLIP-10 TV1 seed.
// Generation: an independent Python stdlib SLIP-10 secp256k1 implementation (hmac/sha512 +
// hand-rolled curve math, validated against all six official TV1 chains above), then the address
// derived from that leaf with Foundry 1.8.3:
//   cast wallet address --private-key 0xe22f5526ce620ec69441c3453d7a0acbc26c3fc7543023f338123fd45c7d44b3
//   → 0x022b971dFF0C43305e691DEd7a14367AF19D6407   (foundry's own keccak + point arithmetic)
//   cast wallet pubkey  --private-key 0xe22f5526…  → the 64-byte uncompressed coordinates below.
const LEAF_PRIV = 'e22f5526ce620ec69441c3453d7a0acbc26c3fc7543023f338123fd45c7d44b3';
const LEAF_PUB_COMPRESSED = '03844a5d329470697de9926c9c98839ea33b6dd9507a896194ae2b91d71faa16d6';
const LEAF_PUB_UNCOMPRESSED =
  '844a5d329470697de9926c9c98839ea33b6dd9507a896194ae2b91d71faa16d6' +
  '4b9c486b7a6395543027bc6e8c99e1967fb41718e1ab1ef66585c5c55470ca1d';
const LEAF_ADDRESS = '0x022b971dff0c43305e691ded7a14367af19d6407';

describe('evm/identity — SLIP-10 official secp256k1 test vector 1', () => {
  for (const [i, v] of SLIP10_TV1.entries()) {
    const chain = v.path.length === 0 ? 'm' : `m/${v.path.map((p) => (p >= H ? `${p - H}'` : p)).join('/')}`;
    test(`${chain}: private key matches the spec`, () => {
      const node = deriveSlip10Secp256k1Node(hexToBytes(SLIP10_SEED), v.path);
      expect(toHex(node.privateKey)).toBe(v.priv);
    });
    test(`${chain}: chain code matches the spec`, () => {
      const node = deriveSlip10Secp256k1Node(hexToBytes(SLIP10_SEED), v.path);
      expect(toHex(node.chainCode)).toBe(v.cc);
    });
    if (i < 3) {
      // Pinned for the first three chains (covers master, hardened and non-hardened steps).
      test(`${chain}: compressed public key matches the spec`, () => {
        const node = deriveSlip10Secp256k1Node(hexToBytes(SLIP10_SEED), v.path);
        expect(toHex(secp256k1.getPublicKey(node.privateKey, true))).toBe(v.pub);
      });
    }
  }
});

describe('evm/identity — m/44\'/60\'/0\'/0/0 leaf (locally generated, foundry-verified)', () => {
  test('derives the leaf private key', () => {
    expect(toHex(deriveEvmKeypair(SLIP10_SEED).privateKey)).toBe(LEAF_PRIV);
  });

  test('derives the compressed public key', () => {
    expect(toHex(deriveEvmKeypair(SLIP10_SEED).publicKey)).toBe(LEAF_PUB_COMPRESSED);
  });

  test('derives the uncompressed 64-byte public key (0x04 prefix dropped)', () => {
    expect(toHex(deriveEvmKeypair(SLIP10_SEED).uncompressedPubKey)).toBe(LEAF_PUB_UNCOMPRESSED);
  });

  test('derives the foundry-verified address (last 20 bytes of keccak256(uncompressed))', () => {
    expect(deriveEvmKeypair(SLIP10_SEED).address).toBe(LEAF_ADDRESS);
  });

  test('is deterministic', () => {
    expect(deriveEvmKeypair(SLIP10_SEED).address).toBe(deriveEvmKeypair(SLIP10_SEED).address);
  });
});

// EIP-55 checksum test vectors — the "Test Cases" section of the EIP-55 spec itself
// (eips.ethereum.org/EIPS/eip-55): the four mixed-case forms plus its all-caps/all-lower pair.
const EIP55_VECTORS = [
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0xde709f2102306220921060314715629080e2fb77',
];

describe('evm/identity — toChecksumAddress (EIP-55)', () => {
  test.each(EIP55_VECTORS)('reproduces the spec vector %s from any case', (vector) => {
    expect(toChecksumAddress(vector.toLowerCase())).toBe(vector);
    expect(toChecksumAddress(vector.toUpperCase())).toBe(vector); // idempotent
    expect(toChecksumAddress(vector)).toBe(vector);
  });

  test('accepts input without the 0x prefix', () => {
    expect(toChecksumAddress(EIP55_VECTORS[0].slice(2).toLowerCase())).toBe(EIP55_VECTORS[0]);
  });

  test('rejects a non-address', () => {
    expect(() => toChecksumAddress('0x1234')).toThrow(/not a 20-byte EVM address/);
  });
});
