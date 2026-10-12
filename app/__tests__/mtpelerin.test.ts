// DOMAIN — app/ramp/mtpelerin.ts + app/ramp/codeSalts.ts: the Mt Pelerin widget link builder,
// the per-address validation-code derivation, and the AsyncStorage collision-salt store.
//
// External pins (developers.mtpelerin.com, 2026-10-12): parameter spelling/casing per their
// general/on-ramp/address-validation parameter docs; the base64 `hash` URL-encoding rule (+ / →
// %2B %2F, = → %3D) per their parameters warning; network names mainnet / arbitrum_mainnet;
// ZCHF listed on Ethereum only, USDC on Ethereum + Arbitrum (their supported-chains page).
// Fixture addresses: the two EVM addresses from their how-to-test vectors, plus the Circle USDC
// deployments in canonical EIP-55 form (Ethereum 0xA0b8…eB48, Arbitrum One 0xaf88…5831) — public,
// permanent, checksummed, and independent of dpay's own keys.

import {describe, expect, it, beforeEach} from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  MTP_ASSET_DELIVERY,
  MTP_WIDGET_BASE,
  buildMtpWidgetLink,
  deriveValidationCode,
  mtpDeliveryChains,
  validationMessage,
} from '../ramp/mtpelerin';
import {loadValidationSalt, saveValidationSalt, validationSaltKey} from '../ramp/codeSalts';
import {signPersonalBase64} from '../evm/personalSign';
import {hexToBytes} from '../lib/format';

// Mt Pelerin how-to-test vector 1 (seed m/44'/60'/0'/0/0) — see evm-signing.test.ts for the full
// signature pins; here it is the addr/code/hash triple that links are built from.
const ADDR1 = '0xEa22e16EA50A43092853329F3cEEa0825Cb9B03e';
const ADDR2 = '0x270402aeB8f4dAc8203915fC26F0768feA61b532';
const HASH1 =
  'yrXNJSmMc4wvVyKEzN4cEmLTvEaridjqTULZAfMwYAMM5PgBz4fCoIWNLr5NwKhxOYiPpI2vhMlKCihWadUw5xs=';
const HASH2 =
  '/37KcpG6mEp+1oAan8/HLEvcfZFXUi6kTOxTHNjD3ZloxS8DL70v7lCmXiEyDOATm4hvewMzBO2d1n25QdJ8WBw=';
// Circle's canonical USDC deployments, EIP-55 checksummed (the commonly circulated spelling of
// the Ethereum contract starts lowercase `0xa0b8…` — the checksummed form uppercases that nibble).
const USDC_ETHEREUM = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ARBITRUM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

describe('ramp/mtpelerin — validation-code derivation (pinned)', () => {
  it.each([
    [ADDR1, 8202],
    [ADDR2, 2531],
    [USDC_ETHEREUM, 4489],
    [USDC_ARBITRUM, 4718],
    ['0xB58E61C3098d85632Df34EecfB899A1Ed80921cB', 2367], // ZCHF on Ethereum
  ])('derives code %i for %s', (address, code) => {
    expect(deriveValidationCode(address)).toBe(code);
  });

  it('is case- and prefix-insensitive (checksummed = lowercase = no 0x)', () => {
    const body = 'ea22e16ea50a43092853329f3ceea0825cb9b03e';
    expect(deriveValidationCode(ADDR1)).toBe(deriveValidationCode(body));
    expect(deriveValidationCode(ADDR1)).toBe(deriveValidationCode(ADDR1.toLowerCase()));
  });

  it('always lands in their 1000-9999 window (a 64-address sweep)', () => {
    for (let i = 0; i < 64; i++) {
      const a = '0x' + Array.from({length: 20}, (_, j) => ((i * 31 + j * 7) % 256).toString(16).padStart(2, '0')).join('');
      const c = deriveValidationCode(a);
      expect(c).toBeGreaterThanOrEqual(1000);
      expect(c).toBeLessThanOrEqual(9999);
    }
  });

  it('rejects a non-20-byte address (fail-closed, never a silent code)', () => {
    expect(() => deriveValidationCode('0x1234')).toThrow(/not a 20-byte EVM address/);
  });

  it('a salt re-derives deterministically; an empty salt equals no salt', () => {
    expect(deriveValidationCode(ADDR1, '9')).toBe(deriveValidationCode(ADDR1, '9'));
    expect(deriveValidationCode(ADDR1, '9')).not.toBe(8202);
    expect(deriveValidationCode(ADDR1, '')).toBe(8202);
  });
});

describe('ramp/mtpelerin — the validation message', () => {
  it('is always MtPelerin-{code} (their message-to-sign doc)', () => {
    expect(validationMessage(1234)).toBe('MtPelerin-1234');
    expect(validationMessage(8202)).toBe('MtPelerin-8202');
  });
});

describe('ramp/mtpelerin — asset/delivery table', () => {
  it('ZCHF delivers on Ethereum only (their service has no Arbitrum ZCHF)', () => {
    expect(MTP_ASSET_DELIVERY.ZCHF).toEqual([1]);
    expect(mtpDeliveryChains('ZCHF')).toEqual([1]);
  });

  it('USDC delivers on Arbitrum One and Ethereum', () => {
    expect(MTP_ASSET_DELIVERY.USDC).toEqual([42161, 1]);
    expect(mtpDeliveryChains('USDC')).toEqual([42161, 1]);
  });
});

describe('ramp/mtpelerin — golden widget links', () => {
  it('ZCHF → Ethereum: full prefill, byte-pinned', () => {
    expect(
      buildMtpWidgetLink({
        asset: 'ZCHF',
        deliveryChain: 1,
        address: ADDR1,
        code: 1234,
        hash: HASH1,
        sourceAmount: '100',
      }),
    ).toBe(
      'https://widget.mtpelerin.com/?net=mainnet&dnet=mainnet&bsc=CHF&bdc=ZCHF&bsa=100' +
        `&addr=${ADDR1}&code=1234` +
        `&hash=${encodeURIComponent(HASH1)}`,
    );
  });

  it('USDC → Arbitrum One: net/dnet=arbitrum_mainnet, hash +/= URL-encoded', () => {
    const link = buildMtpWidgetLink({
      asset: 'USDC',
      deliveryChain: 42161,
      address: USDC_ARBITRUM,
      code: 4718,
      hash: HASH2,
      destAmount: '250.5',
    });
    expect(link).toBe(
      `${MTP_WIDGET_BASE}?net=arbitrum_mainnet&dnet=arbitrum_mainnet&bsc=CHF&bdc=USDC&bda=250.5` +
        `&addr=${USDC_ARBITRUM}&code=4718&hash=%2F37KcpG6mEp%2B1oAan8%2FHLEvcfZFXUi6kTOxTHNjD3ZloxS8DL70v7lCmXiEyDOATm4hvewMzBO2d1n25QdJ8WBw%3D`,
    );
  });

  it('USDC → Ethereum: net/dnet=mainnet, bdc=USDC', () => {
    expect(
      buildMtpWidgetLink({
        asset: 'USDC',
        deliveryChain: 1,
        address: USDC_ETHEREUM,
        code: 4489,
        hash: HASH1,
        sourceAmount: '50.00',
      }),
    ).toBe(
      `${MTP_WIDGET_BASE}?net=mainnet&dnet=mainnet&bsc=CHF&bdc=USDC&bsa=50.00` +
        `&addr=${USDC_ETHEREUM}&code=4489&hash=${encodeURIComponent(HASH1)}`,
    );
  });

  it('encodes the base64 hash exactly as their parameters doc demands (+ / = → %2B %2F %3D)', () => {
    const link = buildMtpWidgetLink({
      asset: 'ZCHF',
      deliveryChain: 1,
      address: ADDR1,
      code: 1234,
      hash: HASH2,
    });
    expect(link).toContain('hash=%2F37KcpG6mEp%2B1oAan8%2F');
    expect(link).toContain('WBw%3D');
  });

  it('appends _ctkn only when given (direct links are self-serve without it)', () => {
    const base = buildMtpWidgetLink({
      asset: 'ZCHF',
      deliveryChain: 1,
      address: ADDR1,
      code: 1234,
      hash: HASH1,
    });
    expect(base).not.toContain('_ctkn');
    expect(
      buildMtpWidgetLink({asset: 'ZCHF', deliveryChain: 1, address: ADDR1, code: 1234, hash: HASH1, ctkn: 'k-1'}),
    ).toContain('_ctkn=k-1');
  });

  it('refuses a delivery chain the asset is not listed on (ZCHF → Arbitrum)', () => {
    expect(() =>
      buildMtpWidgetLink({asset: 'ZCHF', deliveryChain: 42161, address: ADDR1, code: 1234, hash: HASH1}),
    ).toThrow(/not delivered on chain/);
  });

  it('refuses malformed inputs (code out of window, bad address, bad amount, bad fiat)', () => {
    const good = {asset: 'ZCHF' as const, deliveryChain: 1 as const, address: ADDR1, hash: HASH1};
    expect(() => buildMtpWidgetLink({...good, code: 999, hash: HASH1})).toThrow(/1000-9999/);
    expect(() => buildMtpWidgetLink({...good, code: 10000, hash: HASH1})).toThrow(/1000-9999/);
    expect(() => buildMtpWidgetLink({...good, code: 1234, address: '0x1234'})).toThrow(/not an EVM address/);
    expect(() => buildMtpWidgetLink({...good, code: 1234, sourceAmount: '1,000'})).toThrow(/plain decimal/);
    expect(() => buildMtpWidgetLink({...good, code: 1234, sourceAmount: '100 CHF'})).toThrow(/plain decimal/);
    expect(() => buildMtpWidgetLink({...good, code: 1234, fiat: 'fr'})).toThrow(/3-letter code/);
    expect(() => buildMtpWidgetLink({...good, code: 1234, hash: ''})).toThrow(/hash/);
  });
});

describe('ramp/mtpelerin — end-to-end: derive → sign → link', () => {
  // The whole chain in one pin: the derived code feeds the message, the device key signs it, and
  // the base64 signature is the link's hash — reproducing Mt Pelerin's own published vector 1.
  it('reproduces their published vector as a complete widget link', () => {
    const key = hexToBytes('78ba65f1cc9427fab632340ae4d705b1485fba9f73ab5a24816907d36d5729e9');
    const code = deriveValidationCode(ADDR1);
    expect(code).toBe(8202);
    const hash = signPersonalBase64(key, validationMessage(1234)); // their fixture code
    expect(hash).toBe(HASH1);
    expect(
      buildMtpWidgetLink({asset: 'ZCHF', deliveryChain: 1, address: ADDR1, code: 1234, hash}),
    ).toBe(
      `${MTP_WIDGET_BASE}?net=mainnet&dnet=mainnet&bsc=CHF&bdc=ZCHF&addr=${ADDR1}&code=1234&hash=${encodeURIComponent(HASH1)}`,
    );
  });
});

describe('ramp/codeSalts — the collision-salt store', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('keys are namespaced per address, lowercase, 0x-stripped', () => {
    expect(validationSaltKey(ADDR1)).toBe('dpay.ramp.mtpValidationSalt.ea22e16ea50a43092853329f3ceea0825cb9b03e');
    expect(validationSaltKey(ADDR1.toLowerCase())).toBe(validationSaltKey(ADDR1));
    expect(() => validationSaltKey('0x1234')).toThrow(/not a 20-byte EVM address/);
  });

  it('save → load round-trips; load is null before any write', async () => {
    expect(await loadValidationSalt(ADDR1)).toBeNull();
    await saveValidationSalt(ADDR1, '9217');
    expect(await loadValidationSalt(ADDR1)).toBe('9217');
  });

  it('the collision fallback end-to-end: a salted re-derivation resolves a collision', async () => {
    // Deterministic collision fixture: under salt '9217' BOTH addresses derive 2430 (the state a
    // genuine no-salt collision leaves the caller in). The caller persists a fresh salt for ONE
    // of them; validation binds (addr, code, hash), so each address still validates with its own
    // code afterwards.
    expect(deriveValidationCode(ADDR1, '9217')).toBe(2430);
    expect(deriveValidationCode(ADDR2, '9217')).toBe(2430);
    expect(await loadValidationSalt(ADDR2)).toBeNull(); // nothing persisted yet
    await saveValidationSalt(ADDR2, '9');
    const salt = await loadValidationSalt(ADDR2);
    expect(salt).toBe('9');
    expect(deriveValidationCode(ADDR2, salt ?? '')).toBe(5558);
    expect(deriveValidationCode(ADDR1, '9217')).toBe(2430); // the other address is untouched
  });
});
