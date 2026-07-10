import { View } from 'react-native';
import { C } from './theme.js';

// Deterministic QR-looking placeholder: a fixed checkerboard derived from a seed
// string. No real QR encoding (the harness only needs stable, recognizable pixels).
function seededGrid(seed, n) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const cells = [];
  for (let i = 0; i < n * n; i++) {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17; h >>>= 0;
    h ^= h << 5; h >>>= 0;
    cells.push((h & 1) === 1);
  }
  // Force the three finder-pattern corners on so it always reads as a QR.
  const on = (r, c) => { cells[r * n + c] = true; };
  for (const [br, bc] of [[0, 0], [0, n - 3], [n - 3, 0]]) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      on(br + r, bc + c);
    }
  }
  return cells;
}

export default function QrBox({ seed = 'dpay', testID, size = 176 }) {
  const n = 15;
  const cell = Math.floor(size / n);
  const cells = seededGrid(seed, n);
  return (
    <View
      testID={testID}
      style={{
        width: n * cell + 24,
        height: n * cell + 24,
        padding: 12,
        backgroundColor: C.qrCell,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: C.line,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          width: n * cell,
          height: n * cell,
        }}
      >
        {cells.map((filled, i) => (
          <View
            key={i}
            style={{
              width: cell,
              height: cell,
              backgroundColor: filled ? C.qrBox : C.qrCell,
            }}
          />
        ))}
      </View>
    </View>
  );
}
