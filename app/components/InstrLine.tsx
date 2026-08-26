import {Text} from 'react-native';
import {S} from '../styles';
import type {InstrRun} from '../i18n/domains/deposit';

/**
 * One deposit-instruction sentence built from catalog RUNS (M.deposit.*.sendToAddress / sendOnly).
 * Plain runs inherit the line style; `em` runs — the asset or network NAME the sentence is about —
 * get the emphasis style. The sentence and the run order come from the catalog so each locale
 * controls word order; only the emphasis mapping lives here, in one place for all three sheets.
 */
export function InstrLine({runs}: {runs: InstrRun[]}) {
  return (
    <Text style={S.instrLine}>
      {runs.map((r, i) => (r.em ? <Text key={i} style={S.instrAsset}>{r.t}</Text> : r.t))}
    </Text>
  );
}
