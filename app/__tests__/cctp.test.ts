// cctp.test.ts — golden pins for the pure CCTP V2 calldata builder (app/cctp.ts), the
// cketh.ts discipline: every byte the cross-rail burn leg hands to the user's wallet is
// pinned here, zero network. The live-verification trail (2026-09-15, publicnode mainnet
// eth_call staging) is documented in the module header; these tests pin the ENCODER so it
// cannot drift from the bytes that were verified live.
import {
  TOKEN_MESSENGER_V2_ADDRESS,
  USDC_ERC20_ADDRESS,
  CCTP_DOMAIN_SOLANA,
  CCTP_FINALITY_FAST,
  SELECTOR_DEPOSIT_FOR_BURN_WITH_HOOK,
  buildForwardHookData,
  encodeDepositForBurnWithHook,
  cctpMaxFee,
  cctpMintFloor,
  parseCctpBurnFees,
  parseCctpMessageStatus,
  type CctpBurnFee,
} from '../cctp';
import {encodeApprove, SELECTOR_APPROVE} from '../cketh';

describe('cctp constants', () => {
  test('the contract addresses are the Circle-documented mainnet deployments', () => {
    expect(TOKEN_MESSENGER_V2_ADDRESS).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(USDC_ERC20_ADDRESS).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(TOKEN_MESSENGER_V2_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(USDC_ERC20_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
  test('the selectors are the keccak-verified, live-verified values', () => {
    // keccak256("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)")
    // verified against mainnet TokenMessengerV2 by staged eth_call reverts (module header).
    expect(SELECTOR_DEPOSIT_FOR_BURN_WITH_HOOK).toBe('779b432d');
    expect(SELECTOR_APPROVE).toBe('095ea7b3');
    expect(CCTP_DOMAIN_SOLANA).toBe(5);
    expect(CCTP_FINALITY_FAST).toBe(1000);
  });
});

describe('buildForwardHookData', () => {
  test('the extended 65-byte cctp-forward hook: magic + version + len + flag + owner', () => {
    const owner = '3d7a7c5e91e8b1d1e86a4f0b6e7a2d9c8f3b1a4e5d6c7b8a9f0e1d2c3b4a5968';
    const hook = buildForwardHookData(owner);
    // 24B magic (ASCII "cctp-forward" + zero pad) + u32 0 + u32 33 + u8 1 + 32B owner.
    expect(hook).toHaveLength(130);
    expect(hook.slice(0, 48)).toBe('636374702d666f7277617264000000000000000000000000');
    expect(hook.slice(48, 56)).toBe('00000000'); // version 0
    expect(hook.slice(56, 64)).toBe('00000021'); // len 33
    expect(hook.slice(64, 66)).toBe('01'); // flag: create the recipient ATA if missing
    expect(hook.slice(66)).toBe(owner);
  });
  test('a malformed owner word is refused, never padded into a wrong recipient', () => {
    expect(() => buildForwardHookData('0x1234')).toThrow();
    expect(() => buildForwardHookData('zz'.repeat(32))).toThrow();
  });
});

describe('encodeDepositForBurnWithHook', () => {
  const owner = '3d7a7c5e91e8b1d1e86a4f0b6e7a2d9c8f3b1a4e5d6c7b8a9f0e1d2c3b4a5968';
  const hookData = buildForwardHookData(owner);
  // A deterministic vector: 12.5 USDC burn, Solana domain, 0.6 USDC max fee, fast finality.
  const calldata = encodeDepositForBurnWithHook({
    amount: 12_500_000n,
    destinationDomain: CCTP_DOMAIN_SOLANA,
    mintRecipientHex64: '9'.repeat(64),
    burnToken: USDC_ERC20_ADDRESS,
    maxFee: 600_000n,
    minFinalityThreshold: CCTP_FINALITY_FAST,
    hookDataHex: hookData,
  });
  test('layout: selector + 8 head words (7 args + offset) + len word + padded tail', () => {
    // 4 selector + 8×32 head + 32 len + 96 (65 B padded to 3 words) = 388 bytes.
    expect(calldata).toMatch(/^0x[0-9a-f]+$/);
    expect((calldata.length - 2) / 2).toBe(4 + 8 * 32 + 32 + 96);
    const body = calldata.slice(2);
    expect(body.slice(0, 8)).toBe(SELECTOR_DEPOSIT_FOR_BURN_WITH_HOOK);
    const words: string[] = [];
    for (let i = 0; i < 8; i += 1) words.push(body.slice(8 + i * 64, 8 + (i + 1) * 64));
    expect(words[0]).toBe((12_500_000n).toString(16).padStart(64, '0')); // amount
    expect(words[1]).toBe((5).toString(16).padStart(64, '0')); // destinationDomain = Solana
    expect(words[2]).toBe('9'.repeat(64)); // mintRecipient (the ATA bytes)
    expect(words[3]).toBe(USDC_ERC20_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0')); // burnToken
    expect(words[4]).toBe('0'.repeat(64)); // destinationCaller = bytes32(0)
    expect(words[5]).toBe((600_000n).toString(16).padStart(64, '0')); // maxFee
    expect(words[6]).toBe((1000).toString(16).padStart(64, '0')); // minFinalityThreshold
    expect(words[7]).toBe((224).toString(16).padStart(64, '0')); // bytes offset = 7×32
    const tail = body.slice(8 + 8 * 64);
    expect(tail.slice(0, 64)).toBe((65).toString(16).padStart(64, '0')); // len = 65
    expect(tail.slice(64, 64 + 130)).toBe(hookData); // the hook bytes verbatim
    expect(tail.slice(64 + 130)).toBe('0'.repeat(192 - 130)); // zero pad to the word boundary
  });
  test('golden: the full calldata for the deterministic vector, byte-frozen', () => {
    expect(calldata).toBe(
      '0x779b432d'
      + '0000000000000000000000000000000000000000000000000000000000bebc20'
      + '0000000000000000000000000000000000000000000000000000000000000005'
      + '9999999999999999999999999999999999999999999999999999999999999999'
      + '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      + '0000000000000000000000000000000000000000000000000000000000000000'
      + '00000000000000000000000000000000000000000000000000000000000927c0'
      + '00000000000000000000000000000000000000000000000000000000000003e8'
      + '00000000000000000000000000000000000000000000000000000000000000e0'
      + '0000000000000000000000000000000000000000000000000000000000000041'
      + '636374702d666f7277617264000000000000000000000000' // magic (24 B)
      + '00000000' // version u32 = 0 (packed 4 bytes, NOT a word)
      + '00000021' // len u32 = 33 (packed 4 bytes)
      + '01' // flag: create the recipient ATA if missing
      + owner
      + '0'.repeat(192 - 130), // pad the 65 B hook to the 3-word boundary
    );
  });
  test('the approve leg reuses the cketh builder byte-for-byte (one proven encoder)', () => {
    const approve = encodeApprove(TOKEN_MESSENGER_V2_ADDRESS, 12_500_000n);
    expect(approve).toBe(
      '0x095ea7b3'
      + TOKEN_MESSENGER_V2_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0')
      + (12_500_000n).toString(16).padStart(64, '0'),
    );
    expect(approve).toHaveLength(2 + 8 + 128);
  });
  test('an odd-length or empty hookData is refused', () => {
    expect(() => encodeDepositForBurnWithHook({
      amount: 1n, destinationDomain: 5, mintRecipientHex64: '9'.repeat(64),
      burnToken: USDC_ERC20_ADDRESS, maxFee: 1n, minFinalityThreshold: 1000, hookDataHex: 'abc',
    })).toThrow();
    expect(() => encodeDepositForBurnWithHook({
      amount: 1n, destinationDomain: 5, mintRecipientHex64: '9'.repeat(64),
      burnToken: USDC_ERC20_ADDRESS, maxFee: 1n, minFinalityThreshold: 1000, hookDataHex: '',
    })).toThrow();
  });
});

describe('cctp fee math', () => {
  const liveFee: CctpBurnFee = {finalityThreshold: 1000, minimumFeeBps: 1n, forwardFeeSubunits: 282_032n};
  test('maxFee = protocol bps + forward fee + 20% buffer (live 2026-09-15 numbers)', () => {
    // 12.5 USDC: protocol 1bp = 1250; forward med 282032; total 283282; +20% = 339938 (floor).
    expect(cctpMaxFee(12_500_000n, liveFee)).toBe(339_938n);
  });
  test('a burn the fee would swallow is refused before anything is signed', () => {
    expect(() => cctpMaxFee(300_000n, liveFee)).toThrow();
  });
  test('the mint floor is the burn amount minus the fee ceiling', () => {
    expect(cctpMintFloor(12_500_000n, 339_938n)).toBe(12_160_062n);
    expect(cctpMintFloor(100n, 200n)).toBe(0n);
  });
});

describe('parseCctpBurnFees (live-captured body)', () => {
  const liveBody = [
    {finalityThreshold: 1000, minimumFee: 1, forwardFee: {low: 269688, med: 282032, high: 305756}},
    {finalityThreshold: 2000, minimumFee: 0, forwardFee: {low: 269688, med: 282032, high: 305756}},
  ];
  test('the fast row parses with its med forwarding fee', () => {
    expect(parseCctpBurnFees(liveBody, 1000)).toEqual({
      finalityThreshold: 1000, minimumFeeBps: 1n, forwardFeeSubunits: 282032n,
    });
  });
  test('the standard row carries its own (zero) protocol fee', () => {
    expect(parseCctpBurnFees(liveBody, 2000)?.minimumFeeBps).toBe(0n);
  });
  test('a body without the requested threshold fails closed to null', () => {
    expect(parseCctpBurnFees(liveBody, 1500)).toBeNull();
    expect(parseCctpBurnFees({}, 1000)).toBeNull();
    expect(parseCctpBurnFees([{finalityThreshold: 1000, minimumFee: 1}], 1000)).toBeNull(); // no forwardFee
  });
});

describe('parseCctpMessageStatus (live-captured shapes)', () => {
  test('a body with a forwardTxHash is complete — the destination mint executed', () => {
    const sig = '5Kb8vLpPfVJYmNRkqLwXhZDgTcNsBfMrUuEjQyAoWxHUi6RtCzGdMvNfPqLbXkYh2ErSjTgUmVbNaCwXzDfGqHu3k';
    expect(parseCctpMessageStatus({
      messages: [{eventNonce: 1, status: 'complete', forwardState: 'COMPLETE', forwardTxHash: sig}],
      sourceTxHash: '0xabc',
    })).toEqual({state: 'complete', forwardTxHash: sig});
  });
  test('a message with no forward tx yet is attested — still watching, never a failure', () => {
    expect(parseCctpMessageStatus({
      messages: [{eventNonce: 1, status: 'complete', forwardState: 'PENDING'}],
    })).toEqual({state: 'attested'});
  });
  test('no messages array reads as pending (the API 404s until an attestation exists)', () => {
    expect(parseCctpMessageStatus({error: 'Message not found for provided parameters'})).toEqual({state: 'pending'});
    expect(parseCctpMessageStatus({messages: []})).toEqual({state: 'pending'});
    expect(parseCctpMessageStatus(null)).toEqual({state: 'pending'});
  });
});
