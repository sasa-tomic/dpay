import {View, Text} from 'react-native';
import {S} from '../styles';

/**
 * Three-column BIP-39 word grid — shared by the Onboarding backup gate and the Settings Backup
 * reveal (the two surfaces that show the same 24 words). ROW-MAJOR: numbers read 1-2-3 across,
 * 4-5-6 across, … — the scan direction people default to IS the transcription order, and a rule
 * under the 4th row chunks the page into the classic 1-12 / 13-24 blocks. (Was column-major
 * (i, i+12) pairs — write-down ergonomics — but at phone width the fold cut the grid mid-block
 * so words 9-12 looked MISSING from the seed; row-major + 3 columns keeps all 24 words and the
 * confirm CTA above the fold on 390×844, which is the safer property to optimize. UX hardening
 * 2026-08-23, round-2 audit.) Each row is a fixed triple of equal-width chips (flex:1 keeps the
 * columns aligned regardless of word length). The chip View carries the `mnemonic-word-N`
 * testID and e2e reads its textContent with the leading index stripped — the index Text must
 * stay FIRST inside the chip (see S.seedChip* in styles.ts).
 */
const COLS = 3;

export function SeedWords({words, testID}: {words: string[]; testID?: string}) {
  const rows: (string[] | null)[] = [];
  for (let i = 0; i < words.length; i += COLS) rows.push(words.slice(i, i + COLS));
  // A null row renders the 12-word boundary rule (after the 4th row of a 24-word grid).
  if (words.length === 24) rows.splice(4, 0, null);
  return (
    <View testID={testID} style={S.seedGrid}>
      {rows.map((row, r) =>
        row === null ? (
          <View key={`rule-${r}`} style={S.seedGridRule} />
        ) : (
          <View key={r} style={S.seedGridRow}>
            {row.map((word, c) => {
              const i = r * COLS + c - (words.length === 24 && r > 4 ? COLS : 0);
              return (
                <View key={c} testID={`mnemonic-word-${i}`} style={S.seedChip}>
                  <Text style={S.seedChipIdx}>{i + 1}</Text>
                  <Text style={S.seedChipWord}>{word}</Text>
                </View>
              );
            })}
          </View>
        ),
      )}
    </View>
  );
}
