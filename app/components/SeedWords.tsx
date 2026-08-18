import {View, Text} from 'react-native';
import {S} from '../styles';

/**
 * Two-column BIP-39 word grid — shared by the Onboarding backup gate and the Settings Backup
 * reveal (the two surfaces that show the same 24 words). COLUMN-MAJOR: words 1-12 read down the
 * LEFT column, 13-24 down the RIGHT — the layout people use writing the phrase on paper, so
 * transcribing is a straight read-down per column instead of a wrap-order zigzag. Each row is a
 * fixed (i, i+12) pair of equal-width chips (flex:1 on the chip keeps the columns aligned
 * regardless of word length). The chip View carries the `mnemonic-word-N` testID and e2e reads
 * its textContent with the leading index stripped — the index Text must stay FIRST inside the
 * chip (see S.seedChip* in styles.ts).
 */
export function SeedWords({words, testID}: {words: string[]; testID?: string}) {
  const half = Math.ceil(words.length / 2);
  return (
    <View testID={testID} style={S.seedGrid}>
      {words.slice(0, half).map((left, i) => {
        const right = words[i + half];
        return (
          <View key={i} style={S.seedGridRow}>
            <View testID={`mnemonic-word-${i}`} style={S.seedChip}>
              <Text style={S.seedChipIdx}>{i + 1}</Text>
              <Text style={S.seedChipWord}>{left}</Text>
            </View>
            {right != null ? (
              <View testID={`mnemonic-word-${i + half}`} style={S.seedChip}>
                <Text style={S.seedChipIdx}>{i + half + 1}</Text>
                <Text style={S.seedChipWord}>{right}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
