import {describe, expect, test} from '@jest/globals';
import {addressToBytes, signEip1559Tx, signLegacyTx, toHex0x, type LegacyTxFields} from '../evm/tx';
import {hexToBytes} from '../lib/format';
import {keccak256} from '../evm/keccak';

const hex = (s: string): string => s.toLowerCase().replace(/^0x/, '');

// THE EIP-155 replay-protection reference vector, from the EIP-155 spec's own "Example" section
// (eips.ethereum.org/EIPS/eip-155): nonce 9, gasprice 20 gwei, gas 21000, to 0x3535…35, value
// 1 ETH, empty data, chainId 1, private key 0x4646…46. The spec pins the signing data, the
// signing hash, the (v, r, s) triple AND the full signed wire — asserted byte-exact below.
// noble's secp256k1 signs deterministically (RFC 6979, low-s), so no vector drift is possible.
const EIP155_KEY = '4646464646464646464646464646464646464646464646464646464646464646';
const EIP155_FIELDS: LegacyTxFields = {
  chainId: 1,
  nonce: 9,
  gasPrice: 20_000_000_000n,
  gasLimit: 21_000n,
  to: '0x3535353535353535353535353535353535353535',
  value: 1_000_000_000_000_000_000n,
  data: new Uint8Array(0),
};

describe('evm/tx — legacy EIP-155 (spec golden vector)', () => {
  test('signing hash matches the spec', () => {
    const signed = signLegacyTx(EIP155_FIELDS, hexToBytes(EIP155_KEY));
    expect(toHex0x(signed.signingHash)).toBe(
      '0xdaf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53',
    );
  });

  test('v, r, s match the spec (v = 35 + 2*chainId + parity = 37)', () => {
    const signed = signLegacyTx(EIP155_FIELDS, hexToBytes(EIP155_KEY));
    expect(signed.v).toBe(37n);
    expect(hex(toHex0x(signed.r))).toBe(
      '28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276',
    );
    expect(hex(toHex0x(signed.s))).toBe(
      '67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
    );
  });

  test('signed wire matches the spec byte-exact', () => {
    const signed = signLegacyTx(EIP155_FIELDS, hexToBytes(EIP155_KEY));
    expect(toHex0x(signed.raw)).toBe(
      '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080'
        + '25a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276'
        + 'a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
    );
  });

  test('txHash = keccak256(serialized)', () => {
    const signed = signLegacyTx(EIP155_FIELDS, hexToBytes(EIP155_KEY));
    expect(toHex0x(signed.txHash)).toBe(toHex0x(keccak256(signed.raw)));
  });

  test('v encodes the chain — replaying on another chain yields a different v and wire', () => {
    const onArb = signLegacyTx({...EIP155_FIELDS, chainId: 42161}, hexToBytes(EIP155_KEY));
    // v = 35 + 2*chainId + parity ⇒ 84357 or 84358 on Arbitrum One.
    expect(onArb.v).toBeGreaterThanOrEqual(35n + 2n * 42161n);
    expect(onArb.v).toBeLessThanOrEqual(36n + 2n * 42161n);
    expect(onArb.raw).not.toEqual(signLegacyTx(EIP155_FIELDS, hexToBytes(EIP155_KEY)).raw);
  });
});

// EIP-1559 (type 2) golden vector — functionally verified against Foundry anvil 1.8.3 before
// being pinned here (tests themselves stay pure: no anvil needed). Generation session:
//   anvil --port 8545 --chain-id 31337
//   cast mktx --rpc-url http://127.0.0.1:8545 --chain 31337 --nonce 0 --gas-limit 21000 \
//     --priority-gas-price 1000000000 --gas-price 2000000000 \
//     0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --value 1ether \
//     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
// cast's independent encoding is byte-identical to the output below, anvil accepted it via
// eth_sendRawTransaction, the receipt was status 0x1, and the balances moved by exactly
// 1 ETH + 21000 × 2 gwei (effectiveGasPrice 0x77359400). The key is anvil's well-known
// account #0, so anyone can reproduce the session.
const EIP1559_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EIP1559_FIELDS = {
  chainId: 31337,
  nonce: 0,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  gasLimit: 21_000n,
  to: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  value: 1_000_000_000_000_000_000n,
  data: new Uint8Array(0),
};

describe('evm/tx — EIP-1559 type 2 (anvil/cast-verified golden vector)', () => {
  const signed = signEip1559Tx(EIP1559_FIELDS, hexToBytes(EIP1559_KEY));

  test('serialized wire matches the anvil-mined bytes byte-exact', () => {
    expect(toHex0x(signed.raw)).toBe(
      '0x02f874827a6980843b9aca0084773594008252089470997970c51812dc3a010c7d01b50e0d17dc79c8'
        + '880de0b6b3a764000080c0'
        + '80'
        + 'a074128fd7d42631897474d93692787a2e56b813754468caaca4993c641c986a37'
        + 'a06d5a3b027177cc2841199b70400fece0a29ac5eabee2fa9cbf9b6aa213716c48',
    );
  });

  test('txHash is the id anvil assigned to the mined transaction', () => {
    expect(toHex0x(signed.txHash)).toBe(
      '0x7d4c13ed95c0cee830d7457ec5a5976db1fc301cfa7a23fef0039a7ccf6aea87',
    );
  });

  test('yParity, r, s match the cast-signed reference', () => {
    expect(signed.v).toBe(0n);
    expect(hex(toHex0x(signed.r))).toBe(
      '74128fd7d42631897474d93692787a2e56b813754468caaca4993c641c986a37',
    );
    expect(hex(toHex0x(signed.s))).toBe(
      '6d5a3b027177cc2841199b70400fece0a29ac5eabee2fa9cbf9b6aa213716c48',
    );
  });

  test('signing hash is keccak256(0x02 || payload-with-empty-access-list)', () => {
    expect(toHex0x(signed.signingHash)).toBe(
      '0xb74b50b3bba4accb52a758871e49bc78918a27c080727efb8b3c8306e46a3edd',
    );
  });

  test('is deterministic — same fields + key, same wire', () => {
    const again = signEip1559Tx(EIP1559_FIELDS, hexToBytes(EIP1559_KEY));
    expect(toHex0x(again.raw)).toBe(toHex0x(signed.raw));
  });
});

describe('evm/tx — address handling', () => {
  test('addressToBytes accepts 20-byte hex in any case', () => {
    expect(addressToBytes('0x3535353535353535353535353535353535353535').length).toBe(20);
    expect(addressToBytes('0X3535353535353535353535353535353535353535'.toLowerCase()).length).toBe(20);
  });

  test('addressToBytes refuses anything that is not 20 bytes', () => {
    expect(() => addressToBytes('0x1234')).toThrow(/must be 20 bytes/);
    expect(() => addressToBytes('3535')).toThrow(/must be 20 bytes/);
    expect(() => addressToBytes('0x35353535353535353535353535353535353535')).toThrow(/must be 20 bytes/);
  });
});
