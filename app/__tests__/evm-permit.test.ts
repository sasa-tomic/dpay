import {describe, expect, test} from '@jest/globals';
import {secp256k1} from '@noble/curves/secp256k1';
import {
  buildDomainSeparator,
  MINIMAL_DOMAIN_TYPEHASH,
  PERMIT_TYPEHASH,
  permitDigest,
  permitStructHash,
  signPermit,
  type PermitDomain,
} from '../evm/permit';
import {keccak256} from '../evm/keccak';
import {utf8ToBytes} from '../lib/base64url';
import {hexToBytes} from '../lib/format';

const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

// The domain and message of the locally-generated golden (see below): the REAL ZCHF deployment
// on Arbitrum One, the payer is anvil's well-known account #0, the spender account #1.
const DOMAIN: PermitDomain = {
  kind: 'full',
  name: 'ZCHF',
  version: '1',
  chainId: 42161,
  verifyingContract: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553',
};
const MESSAGE = {
  owner: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  spender: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  value: 1_000_000_000_000_000_000_000n,
  nonce: 0n,
  deadline: 1_893_456_000n,
};
const PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('evm/permit — published typehash constants', () => {
  test('PERMIT_TYPEHASH = keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")', () => {
    // The published Uniswap V2 PERMIT_TYPEHASH — shared by every canonical EIP-2612 deployment.
    expect(hex(PERMIT_TYPEHASH)).toBe('6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9');
  });

  test('domain typehash input matches the EIP-712 spec string', () => {
    // buildDomainSeparator is pinned via the foundry-generated separator below; this test keeps
    // the type-structure string itself from drifting (it is an EIP-712 published surface).
    const encoded = utf8ToBytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    );
    expect(hex(keccak256(encoded))).toBe(
      '8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f',
    );
  });
});

describe('evm/permit — locally-generated golden (Foundry 1.8.3)', () => {
  // Vector generation (the EIP-2612 spec itself pins no numeric example; the two typehashes above
  // are the published anchors, this full digest is generated and cross-checked with Foundry).
  // Each ABI word below is the 64-hex-char left-padded form (chainId 42161 → …1051; addresses
  // keep their 40 hex chars left-padded to 64):
  //
  //   DOMAIN_TH=$(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  //   PERMIT_TH=$(cast keccak "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
  //   DOMSEP=$(cast keccak 0x${DOMAIN_TH#0x}<keccak("ZCHF")><keccak("1")><pad(42161)><pad(0xD4dD…53)>)
  //   STRUCT=$(cast keccak 0x${PERMIT_TH#0x}<pad(owner)><pad(spender)><pad(value)><pad(nonce)><pad(deadline)>)
  //   DIGEST=$(cast keccak 0x1901${DOMSEP#0x}${STRUCT#0x})
  //   cast wallet sign --data --from-file permit-typed.json \
  //     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  //
  // where permit-typed.json is the EIP-712 JSON of exactly DOMAIN/MESSAGE above. The signature
  // must be byte-identical to noble's (both sign deterministically), which pins the digest AND
  // the signing path in one assertion.

  test('domain separator matches the cast-keccak pipeline', () => {
    expect(hex(buildDomainSeparator(DOMAIN))).toBe(
      'cc1ab84f128006175ca10d72101b2dc70964460d710f724b3beb182dafb6f2d1',
    );
  });

  test('struct hash matches the cast-keccak pipeline', () => {
    expect(hex(permitStructHash(MESSAGE))).toBe(
      'd0c6dd141b69b16db9b5617f1d8fa13883ff1641a1851e8dcc4d7b612f2b8e18',
    );
  });

  test('digest = keccak256(0x1901 || domainSeparator || structHash)', () => {
    expect(hex(permitDigest(DOMAIN, MESSAGE))).toBe(
      '6982a5484bf895e57b1dc9627433b930478d56abec41b8baf0d0bc9dad36770e',
    );
  });

  test('signature is byte-identical to foundry sign-typed-data', () => {
    const sig = signPermit(hexToBytes(PRIVATE_KEY), DOMAIN, MESSAGE);
    expect(sig.v).toBe(27);
    expect(hex(sig.r)).toBe('f66af679f640d7c959db4c21651704ea7764a61317e0af643b59ddad8d2cc27f');
    expect(hex(sig.s)).toBe('722b849f490e020d4a0e1a6ff1a51d25ae235f497bcce08de813099659798800');
    expect(sig.serialized).toHaveLength(65);
    expect(hex(sig.serialized)).toBe(
      'f66af679f640d7c959db4c21651704ea7764a61317e0af643b59ddad8d2cc27f'
        + '722b849f490e020d4a0e1a6ff1a51d25ae235f497bcce08de8130996597988001b',
    );
  });

  test('the signature recovers to the owner over the digest (self-consistent)', () => {
    const digest = permitDigest(DOMAIN, MESSAGE);
    const priv = hexToBytes(PRIVATE_KEY);
    const sigObj = secp256k1.sign(digest, priv); // has {r, s, recovery, recoverPublicKey}
    const pub = new Uint8Array(sigObj.recoverPublicKey(digest).toRawBytes(false)); // 0x04 || X || Y
    // address = last 20 bytes of keccak256(uncompressed pubkey)
    expect(hex(new Uint8Array(keccak256(pub.subarray(1))).subarray(12))).toBe(
      MESSAGE.owner.toLowerCase().replace(/^0x/, ''),
    );
    // and the exported (r, s) verifies against the recovered owner key
    expect(secp256k1.verify(sigObj.toCompactRawBytes(), digest, pub)).toBe(true);
  });

  test('is deterministic', () => {
    const a = signPermit(hexToBytes(PRIVATE_KEY), DOMAIN, MESSAGE);
    const b = signPermit(hexToBytes(PRIVATE_KEY), DOMAIN, MESSAGE);
    expect(hex(a.serialized)).toBe(hex(b.serialized));
  });
});

// The REAL ZCHF domains — both deployments use ERC20PermitLight's MINIMAL EIP-712 domain (no
// name, no version): DOMAIN_SEPARATOR() = keccak256(abi.encode(MINIMAL_DOMAIN_TYPEHASH, chainId,
// address)). Golden separators below verified against live DOMAIN_SEPARATOR() via eth_call,
// 2026-09-26 (publicnode RPCs; identical to the spec addendum-1 receipts).
const ZCHF_ETH: PermitDomain = {
  kind: 'minimal',
  chainId: 1,
  verifyingContract: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
};
const ZCHF_ARB: PermitDomain = {
  kind: 'minimal',
  chainId: 42161,
  verifyingContract: '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553',
};

describe('evm/permit — minimal domain (ERC20PermitLight, the kind real ZCHF uses)', () => {
  test('the minimal typehash constant is the ERC20PermitLight one', () => {
    expect(hex(MINIMAL_DOMAIN_TYPEHASH)).toBe(
      '47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218',
    );
  });

  test('Ethereum ZCHF separator matches the on-chain DOMAIN_SEPARATOR() (eth_call, 2026-09-26)', () => {
    expect(hex(buildDomainSeparator(ZCHF_ETH))).toBe(
      '0030eba518c077921487bde9523478fa8ba39b881d0372fd1cb104a3080bfcb0',
    );
  });

  test('Arbitrum One ZCHF separator matches the on-chain DOMAIN_SEPARATOR() (eth_call, 2026-09-26)', () => {
    expect(hex(buildDomainSeparator(ZCHF_ARB))).toBe(
      '617234e4a9e50a533c5d115e211786310f382c0b63c6140c6ee12bf3b8c1cff9',
    );
  });

  test('signing with the WRONG kind for ZCHF yields a different digest (silent-regression guard)', () => {
    const wrongKind: PermitDomain = {...DOMAIN}; // full-domain ZCHF on Arbitrum, same token/chain
    expect(hex(permitDigest(wrongKind, MESSAGE))).not.toBe(hex(permitDigest(ZCHF_ARB, MESSAGE)));
    // …and the regression would already show at the separator, the root of the digest:
    expect(hex(buildDomainSeparator(wrongKind))).not.toBe(hex(buildDomainSeparator(ZCHF_ARB)));
    expect(hex(permitDigest(wrongKind, MESSAGE))).not.toBe(hex(permitDigest(ZCHF_ETH, MESSAGE)));
  });
});
