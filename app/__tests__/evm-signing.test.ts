// SMOKE — the EIP-191 personal_sign golden vectors (the `evm-*.test.ts` convention). Mt Pelerin's
// address validation is a MONEY gate: their widget credits fiat buys to `addr` because `hash`
// proves the device key owns it, so a digest or serialization bug sends the user's money to an
// address their signature does not cover. The vectors below are Mt Pelerin's PUBLISHED test
// fixtures (developers.mtpelerin.com, integration-guides → automating-the-end-user-address-
// validation → how-to-test, retrieved 2026-10-12), generated with ethers.js — byte-identical to
// our noble signer because both are RFC 6979 deterministic with low-s normalisation. Pure node,
// zero network, deterministic.

import {describe, expect, test} from '@jest/globals';
import {personalSignDigest, signPersonal, signPersonalBase64} from '../evm/personalSign';
import {evmKeypairFromPrivate} from '../evm/identity';
import {hexToBytes} from '../lib/format';

const hex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

// Vector 1 — Mt Pelerin's test seed (bamboo feed assist glove soda merry medal vanish almost
// solid bean loop) at the Ethereum path m/44'/60'/0'/0/0 — the SAME path as the dpay EVM rail.
const KEY1 = '78ba65f1cc9427fab632340ae4d705b1485fba9f73ab5a24816907d36d5729e9';
const ADDR1 = '0xEa22e16EA50A43092853329F3cEEa0825Cb9B03e';
// Vector 2 — a standalone private key with no seed phrase.
const KEY2 = '4142e80a872531fd1055f52ccab713d4c7f1eee28c33415558e74faeb516de2b';
const ADDR2 = '0x270402aeB8f4dAc8203915fC26F0768feA61b532';
const CODE = 1234; // their fixture code; the message is always `MtPelerin-{code}`
const MESSAGE = `MtPelerin-${CODE}`;

describe('evm/personalSign — EIP-191 digest (published vector anchors)', () => {
  test('digest = keccak256(0x19 ‖ "Ethereum Signed Message:\\n14" ‖ message)', () => {
    // The independent preimage pin: 14 is the message's BYTE length in ASCII decimal.
    expect(hex(personalSignDigest(MESSAGE))).toBe(
      '47014395ffe034a9421445fd78ea13624588787bd615ebc13b058ad4980e9f60',
    );
  });

  test('the length line counts UTF-8 BYTES, not characters', () => {
    // "Mé": 2 characters, 3 bytes — a char-count digest would be keccak over a different preimage.
    expect(hex(personalSignDigest('Mé'))).toBe(
      '729ce8731ca8ac111dd81ad5f105dc897a4f073b025d43ecece4d7f652d3cfac',
    );
  });

  test('string and pre-encoded bytes digests agree', () => {
    const bytes = new TextEncoder().encode(MESSAGE);
    expect(hex(personalSignDigest(bytes))).toBe(hex(personalSignDigest(MESSAGE)));
  });
});

describe('evm/personalSign — Mt Pelerin published signature vectors', () => {
  test('vector 1 (seed m/44′/60′/0′/0/0): signature bytes + base64 match byte for byte', () => {
    const sig = signPersonal(hexToBytes(KEY1), MESSAGE);
    expect(sig.v === 27 || sig.v === 28).toBe(true);
    expect(hex(sig.serialized)).toBe(
      'cab5cd25298c738c2f572284ccde1c1262d3bc46ab89d8ea4d42d901f33060030ce4f801cf87c2a0858d2ebe4dc0a87139888fa48daf84c94a0a285669d530e71b',
    );
    // The exact string their widget `hash` parameter takes for EVM.
    expect(signPersonalBase64(hexToBytes(KEY1), MESSAGE)).toBe(
      'yrXNJSmMc4wvVyKEzN4cEmLTvEaridjqTULZAfMwYAMM5PgBz4fCoIWNLr5NwKhxOYiPpI2vhMlKCihWadUw5xs=',
    );
  });

  test('vector 1 key derives exactly their published address', () => {
    expect(evmKeypairFromPrivate(hexToBytes(KEY1)).address.toLowerCase()).toBe(ADDR1.toLowerCase());
  });

  test('vector 2 (standalone key): base64 matches byte for byte', () => {
    expect(evmKeypairFromPrivate(hexToBytes(KEY2)).address.toLowerCase()).toBe(ADDR2.toLowerCase());
    expect(signPersonalBase64(hexToBytes(KEY2), MESSAGE)).toBe(
      '/37KcpG6mEp+1oAan8/HLEvcfZFXUi6kTOxTHNjD3ZloxS8DL70v7lCmXiEyDOATm4hvewMzBO2d1n25QdJ8WBw=',
    );
  });

  test('deterministic: signing twice yields identical bytes', () => {
    expect(signPersonalBase64(hexToBytes(KEY1), MESSAGE)).toBe(
      signPersonalBase64(hexToBytes(KEY1), MESSAGE),
    );
  });
});
