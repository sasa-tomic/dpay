// react-native-qrcode-svg shim for web. The upstream package ships only `src/index.js` (JSX in a
// .js file) which the rolldown parser rejects without a JSX hint. Rather than fight the parser, we
// re-implement the SAME render path (QR matrix via the `qrcode` package → SVG `<Path>` via
// `react-native-svg`) in a `.tsx` file so JSX is enabled by extension. The visual output is the QR
// code the merchant / payer / deposit screens show; bytes-for-bytes the QR encodes the exact value
// the app passes (the real wire/request string), so a downstream scanner decodes it identically.
//
// Mirrors the upstream `genMatrix` + `transformMatrixIntoPath` (kept verbatim in spirit). The
// `qrcode` package is already in app/node_modules (a transitive dep of the original).
import React from 'react';
import QRCode from 'qrcode';
import { Path, Rect, Svg } from 'react-native-svg';

type QRCodeProps = {
  value: string;
  size?: number;
  ecl?: 'L' | 'M' | 'Q' | 'H';
  color?: string;
  backgroundColor?: string;
};

// Compute the QR matrix as a 2D boolean grid (same reduction as upstream genMatrix.js).
function genMatrix(value: string, ecl: 'L' | 'M' | 'Q' | 'H'): boolean[][] {
  const data = QRCode.create(value, { errorCorrectionLevel: ecl }).modules.data;
  const sqrt = Math.sqrt(data.length);
  const rows: boolean[][] = [];
  for (let i = 0; i < data.length; i++) {
    if (i % sqrt === 0) rows.push([!!data[i]]);
    else rows[rows.length - 1].push(!!data[i]);
  }
  return rows;
}

// Reduce the matrix to a single SVG path string (same algorithm as upstream transformMatrixIntoPath).
function matrixToPath(matrix: boolean[][], size: number): { cellSize: number; path: string } {
  const cellSize = size / matrix.length;
  let path = '';
  matrix.forEach((row, i) => {
    let needDraw = false;
    row.forEach((column, j) => {
      if (column) {
        if (!needDraw) {
          path += `M${cellSize * j} ${cellSize / 2 + cellSize * i} `;
          needDraw = true;
        }
        if (needDraw && j === matrix.length - 1) {
          path += `L${cellSize * (j + 1)} ${cellSize / 2 + cellSize * i} `;
        }
      } else if (needDraw) {
        path += `L${cellSize * j} ${cellSize / 2 + cellSize * i} `;
        needDraw = false;
      }
    });
  });
  return { cellSize, path };
}

// Default export: a `<QRCode>` React component matching the upstream surface (`value`, `size`,
// `ecl`, `color`, `backgroundColor`). The app uses `<QRCode value={...} size={220} ecl="L" />`.
export default function QRCodeSvg({ value, size = 100, ecl = 'M', color = 'black', backgroundColor = 'white' }: QRCodeProps) {
  const matrix = React.useMemo(() => genMatrix(value, ecl), [value, ecl]);
  const { cellSize, path } = React.useMemo(() => matrixToPath(matrix, size), [matrix, size]);
  const stroke = color;
  // A rounded cap joins adjacent cells into the QR's familiar solid blocks (matches upstream's
  // visual: cells render as a single connected path, not a dot grid).
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Rect x={0} y={0} width={size} height={size} fill={backgroundColor} />
      <Path d={path} stroke={stroke} strokeWidth={cellSize} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
