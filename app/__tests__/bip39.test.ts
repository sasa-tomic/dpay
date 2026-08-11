import { describe, test, expect } from '@jest/globals';
import {
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
  generateMnemonic,
  wordsToHex,
  hexToWords,
  wordsToString,
  stringToWords,
} from '../lib/bip39';
import { ENGLISH_WORDLIST } from '../lib/bip39-wordlist';

function hexToBytesLocal(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Authoritative 256-bit BIP-39 test vectors. The first four are the canonical Trezor/python-mnemonic
// golden vectors (all-zeros, 0x7f×, 0x80×, all-ones); the fifth is an arbitrary 32-byte value cross-
// checked against the audited @scure/bip39 reference implementation. Each round-trips.
const VECTORS: Array<{ entropy: string; words: string[] }> = [
  {
    entropy: '00'.repeat(32),
    words: ('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
      'art').split(' '),
  },
  {
    entropy: '7f'.repeat(32),
    words: ('legal winner thank year wave sausage worth useful legal winner thank year wave sausage ' +
      'worth useful legal winner thank year wave sausage worth title').split(' '),
  },
  {
    entropy: '80'.repeat(32),
    words: ('letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount ' +
      'doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless').split(' '),
  },
  {
    entropy: 'ff'.repeat(32),
    words: ('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo ' +
      'zoo vote').split(' '),
  },
  {
    entropy: '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc',
    words: ('adapt explain ecology dinner glare old unfair empty expect road off suggest dash dolphin ' +
      'captain version oval census uncover inform arrest trash first nice').split(' '),
  },
];

describe('bip39 — official 256-bit test vectors', () => {
  for (const v of VECTORS) {
    test(`entropy ${ventropyLabel(v.entropy)} → mnemonic`, () => {
      expect(entropyToMnemonic(hexToBytesLocal(v.entropy))).toEqual(v.words);
    });
    test(`mnemonic → entropy ${ventropyLabel(v.entropy)} (round-trip)`, () => {
      expect(toHex(mnemonicToEntropy(v.words))).toBe(v.entropy);
    });
    test(`validateMnemonic(mnemonic) === true for ${ventropyLabel(v.entropy)}`, () => {
      expect(validateMnemonic(v.words)).toBe(true);
    });
  }
});

describe('bip39 — round-trip on random inputs', () => {
  for (let seed = 1; seed <= 5; seed++) {
    test(`round-trip seed #${seed}`, () => {
      const entropy = new Uint8Array(32);
      // a deterministic-ish per-seed entropy (NOT for crypto use — just a varied round-trip input)
      for (let i = 0; i < 32; i++) entropy[i] = (seed * 37 + i * 13) & 0xff;
      const words = entropyToMnemonic(entropy);
      expect(words.length).toBe(24);
      expect(toHex(mnemonicToEntropy(words))).toBe(toHex(entropy));
    });
  }
  test('32 random bytes via crypto.getRandomValues round-trip', () => {
    const entropy = new Uint8Array(32);
    globalThis.crypto.getRandomValues(entropy);
    expect(toHex(mnemonicToEntropy(entropyToMnemonic(entropy)))).toBe(toHex(entropy));
  });
});

describe('bip39 — checksum / corruption detection', () => {
  const base = VECTORS[4].words.slice();

  test('flipping the last word (checksum-carrying) is caught', () => {
    const words = base.slice();
    // Replace the 24th word (which encodes part of the entropy AND the checksum bits) with a
    // different valid word — the recomputed checksum will not match.
    const replacement = words[23] === 'nice' ? 'art' : 'nice';
    words[23] = replacement;
    expect(validateMnemonic(words)).toBe(false);
    expect(() => mnemonicToEntropy(words)).toThrow(/checksum/);
  });

  test('flipping a middle word (pure entropy) is caught by the checksum', () => {
    const words = base.slice();
    const replacement = words[5] === 'sausage' ? 'abandon' : 'sausage';
    words[5] = replacement;
    expect(validateMnemonic(words)).toBe(false);
    expect(() => mnemonicToEntropy(words)).toThrow(/checksum/);
  });

  test('reordering two words is caught (checksum changes)', () => {
    const words = base.slice();
    [words[0], words[1]] = [words[1], words[0]];
    expect(validateMnemonic(words)).toBe(false);
  });

  test('a single-bit flip in entropy produces a different, still-valid mnemonic', () => {
    const entropy = hexToBytesLocal(VECTORS[0].entropy);
    entropy[0] ^= 0x01; // flip the lowest bit of the first byte
    const words = entropyToMnemonic(entropy);
    expect(validateMnemonic(words)).toBe(true);
    expect(words).not.toEqual(VECTORS[0].words);
  });
});

describe('bip39 — invalid input rejection', () => {
  test('wrong word count (23 words) throws', () => {
    const short = VECTORS[0].words.slice(0, 23);
    expect(() => mnemonicToEntropy(short)).toThrow(/24 words/);
    expect(validateMnemonic(short)).toBe(false);
  });

  test('wrong word count (25 words) throws', () => {
    const long = VECTORS[0].words.concat(['abandon']);
    expect(() => mnemonicToEntropy(long)).toThrow(/24 words/);
    expect(validateMnemonic(long)).toBe(false);
  });

  test('empty array throws', () => {
    expect(() => mnemonicToEntropy([])).toThrow(/24 words/);
    expect(validateMnemonic([])).toBe(false);
  });

  test('unknown word (not in wordlist) throws', () => {
    const words = VECTORS[0].words.slice();
    words[7] = 'notaword';
    expect(() => mnemonicToEntropy(words)).toThrow(/unknown BIP-39 word/);
    expect(validateMnemonic(words)).toBe(false);
  });

  test('case sensitivity: uppercase word is unknown', () => {
    const words = VECTORS[0].words.slice();
    words[0] = 'ABANDON';
    expect(() => mnemonicToEntropy(words)).toThrow(/unknown BIP-39 word/);
    expect(validateMnemonic(words)).toBe(false);
  });

  test('entropyToMnemonic throws RangeError on non-32-byte input', () => {
    expect(() => entropyToMnemonic(new Uint8Array(16))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(20))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(31))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(33))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(64))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(0))).toThrow(RangeError);
  });
});

describe('bip39 — generateMnemonic', () => {
  test('returns 24 valid words', () => {
    const words = generateMnemonic();
    expect(words.length).toBe(24);
    expect(validateMnemonic(words)).toBe(true);
    // every word is in the official list
    for (const w of words) expect(ENGLISH_WORDLIST).toContain(w);
  });

  test('two calls produce different mnemonics (RNG is live)', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    expect(a).not.toEqual(b);
  });

  test('generated mnemonic round-trips to 32 bytes', () => {
    const words = generateMnemonic();
    const entropy = mnemonicToEntropy(words);
    expect(entropy.length).toBe(32);
    expect(entropyToMnemonic(entropy)).toEqual(words);
  });
});

describe('bip39 — hex/words convenience helpers', () => {
  test('wordsToHex / hexToWords are inverses', () => {
    const words = VECTORS[1].words;
    const hex = wordsToHex(words);
    expect(hex).toBe(VECTORS[1].entropy);
    expect(hexToWords(hex)).toEqual(words);
  });

  test('wordsToHex rejects an invalid mnemonic (delegates to mnemonicToEntropy)', () => {
    expect(() => wordsToHex(VECTORS[0].words.slice(0, 23))).toThrow(/24 words/);
  });

  test('hexToWords rejects non-32-byte hex (delegates to hexToBytes + entropyToMnemonic)', () => {
    // 16-byte hex: hexToBytes succeeds (32 chars), then entropyToMnemonic throws RangeError
    expect(() => hexToWords('00'.repeat(16))).toThrow(RangeError);
  });

  test('wordsToString / stringToWords are inverses', () => {
    const s = wordsToString(VECTORS[2].words);
    expect(s.split(' ').length).toBe(24);
    expect(stringToWords(s)).toEqual(VECTORS[2].words);
  });

  test('stringToWords tolerates extra whitespace + newlines (pasted backup)', () => {
    const pasted = VECTORS[3].words.join('\n');
    expect(stringToWords(pasted)).toEqual(VECTORS[3].words);
    expect(stringToWords('  ' + VECTORS[3].words.join('  ') + '  ')).toEqual(VECTORS[3].words);
  });
});

describe('bip39 — wordlist integrity', () => {
  test('exactly 2048 words', () => {
    expect(ENGLISH_WORDLIST.length).toBe(2048);
  });

  test('all words are unique', () => {
    expect(new Set(ENGLISH_WORDLIST).size).toBe(2048);
  });

  test('canonical first/last words', () => {
    expect(ENGLISH_WORDLIST[0]).toBe('abandon');
    expect(ENGLISH_WORDLIST[2047]).toBe('zoo');
  });
});

function ventropyLabel(hex: string): string {
  if (hex === '00'.repeat(32)) return '00×32';
  if (hex === 'ff'.repeat(32)) return 'ff×32';
  if (hex === '7f'.repeat(32)) return '7f×32';
  if (hex === '80'.repeat(32)) return '80×32';
  return hex.slice(0, 8) + '…';
}
