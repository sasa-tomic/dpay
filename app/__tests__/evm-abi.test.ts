import {describe, expect, test} from '@jest/globals';
import {
  decodeTransferLog,
  decodeUint256,
  encodeAllowance,
  encodeBalanceOf,
  encodePermit,
  encodeTransfer,
  encodeTransferFrom,
  functionSelector,
  TRANSFER_EVENT_TOPIC,
} from '../evm/abi';

// The canonical selectors are PUBLISHED constants (every ABI reference lists them; the task pins
// four). The module computes them from keccak256 of the canonical signature strings, so equality
// here proves the keccak wiring AND the signature spelling in one shot.
describe('evm/abi — selectors = first 4 bytes of keccak256(canonical signature)', () => {
  const hex4 = (b: Uint8Array): string =>
    Array.from(b)
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');

  test('transfer(address,uint256) = a9059cbb', () => {
    expect(hex4(functionSelector('transfer(address,uint256)'))).toBe('a9059cbb');
  });

  test('balanceOf(address) = 70a08231', () => {
    expect(hex4(functionSelector('balanceOf(address)'))).toBe('70a08231');
  });

  test('transferFrom(address,address,uint256) = 23b872dd', () => {
    expect(hex4(functionSelector('transferFrom(address,address,uint256)'))).toBe('23b872dd');
  });

  test('allowance(address,address) = dd62ed3e', () => {
    expect(hex4(functionSelector('allowance(address,address)'))).toBe('dd62ed3e');
  });

  test('permit(address,address,uint256,uint256,uint8,bytes32,bytes32) = d505accf', () => {
    expect(hex4(functionSelector('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)'))).toBe(
      'd505accf',
    );
  });
});

const TOKEN = '0xD4dD9e2F021BB459D5A5f6c24C12fE09c5D45553'; // ZCHF on Arbitrum One
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x000000000000000000000000000000000000dEaD';

describe('evm/abi — calldata encoders', () => {
  test('encodeTransfer: selector + address word + uint256 word', () => {
    // Hand-assembled expectation: a9059cbb || pad(BOB) || pad(1000).
    const expected =
      'a9059cbb'
      + '000000000000000000000000000000000000000000000000000000000000dead'
      + '00000000000000000000000000000000000000000000000000000000000003e8';
    expect(Buffer.from(encodeTransfer(BOB, 1000n)).toString('hex')).toBe(expected);
  });

  test('encodeTransfer: a uint256-overflowing amount must refuse, not wrap', () => {
    expect(() => encodeTransfer(BOB, 1n << 256n)).toThrow(/out of uint256 range/);
  });

  test('encodeBalanceOf', () => {
    const expected =
      '70a08231'
      + '000000000000000000000000d4dd9e2f021bb459d5a5f6c24c12fe09c5d45553';
    expect(Buffer.from(encodeBalanceOf(TOKEN)).toString('hex')).toBe(expected);
  });

  test('encodeTransferFrom: three words in (from, to, amount) order', () => {
    const expected =
      '23b872dd'
      + '0000000000000000000000001111111111111111111111111111111111111111'
      + '000000000000000000000000000000000000000000000000000000000000dead'
      + '0000000000000000000000000000000000000000000000000000000000000001';
    expect(Buffer.from(encodeTransferFrom(ALICE, BOB, 1n)).toString('hex')).toBe(expected);
  });

  test('encodeAllowance', () => {
    const expected =
      'dd62ed3e'
      + '0000000000000000000000001111111111111111111111111111111111111111'
      + '000000000000000000000000d4dd9e2f021bb459d5a5f6c24c12fe09c5d45553';
    expect(Buffer.from(encodeAllowance(ALICE, TOKEN)).toString('hex')).toBe(expected);
  });

  test('encodePermit: FUNCTION argument order (deadline before v; the EIP-712 struct inside permit.ts differs)', () => {
    const r = new Uint8Array(32).fill(0xab);
    const s = new Uint8Array(32).fill(0xcd);
    const calldata = encodePermit(ALICE, BOB, 5n, 1893456000n, 27, r, s);
    const out = Buffer.from(calldata).toString('hex');
    expect(out.slice(0, 8)).toBe('d505accf');
    // owner, spender, value, deadline, v, r, s — seven 32-byte words.
    expect(out.slice(8)).toBe(
      '0000000000000000000000001111111111111111111111111111111111111111'
      + '000000000000000000000000000000000000000000000000000000000000dead'
      + '0000000000000000000000000000000000000000000000000000000000000005'
      + '0000000000000000000000000000000000000000000000000000000070dbd880'
      + '000000000000000000000000000000000000000000000000000000000000001b'
      + 'ab'.repeat(32)
      + 'cd'.repeat(32),
    );
  });
});

describe('evm/abi — decoders', () => {
  test('decodeUint256 reads a balanceOf return (full and zero-trimmed words)', () => {
    expect(decodeUint256('0x0000000000000000000000000000000000000000000000000000000000000005')).toBe(5n);
    expect(decodeUint256('0000000000000000000000000000000000000000000000000de0b6b3a7640000')).toBe(
      1_000_000_000_000_000_000n,
    );
    expect(decodeUint256('0x1')).toBe(1n); // some RPCs trim leading zeros
  });

  test('decodeUint256 rejects junk', () => {
    expect(() => decodeUint256('0x')).toThrow();
    expect(() => decodeUint256('zz')).toThrow();
    expect(() => decodeUint256('0x' + '0'.repeat(66))).toThrow();
  });

  test('TRANSFER_EVENT_TOPIC is the canonical keccak256("Transfer(address,address,uint256)")', () => {
    expect(TRANSFER_EVENT_TOPIC).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    );
  });

  test('decodeTransferLog parses a standard ERC-20 Transfer log', () => {
    const log = decodeTransferLog(
      '0x0000000000000000000000000000000000000000000000000de0b6b3a7640000',
      [
        TRANSFER_EVENT_TOPIC,
        '0x0000000000000000000000001111111111111111111111111111111111111111',
        '0x000000000000000000000000000000000000000000000000000000000000dead',
      ],
    );
    expect(log).toEqual({
      from: '0x1111111111111111111111111111111111111111',
      to: '0x000000000000000000000000000000000000dead',
      amount: 1_000_000_000_000_000_000n,
    });
  });

  test('decodeTransferLog returns null for anything that is not a plain ERC-20 Transfer', () => {
    const topics = (t0: string, extra = 0): string[] => [
      t0,
      '0x0000000000000000000000001111111111111111111111111111111111111111',
      '0x000000000000000000000000000000000000000000000000000000000000dead',
      ...Array.from({length: extra}, () => '0x' + '0'.repeat(64)),
    ];
    // An ERC-721 Transfer carries tokenId in topics[3] (4 topics) — NOT this decoder's shape.
    expect(decodeTransferLog('0x' + '0'.repeat(64), topics(TRANSFER_EVENT_TOPIC, 1))).toBeNull();
    // Other events (e.g. Approval) share the 3-topic shape but not the topic0.
    expect(decodeTransferLog('0x' + '0'.repeat(64), topics('0x' + '8'.repeat(64)))).toBeNull();
    // Truncated payload words are refused, not partially parsed.
    expect(decodeTransferLog('0x1234', topics(TRANSFER_EVENT_TOPIC))).toBeNull();
  });
});
