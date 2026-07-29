// Tiny shim for `text-encoding`. The `react-native-qrcode-svg` package's index does
//   global.TextEncoder = require('text-encoding').TextEncoder;
// at the top — a leftover from very old RN runtimes that lacked TextEncoder. Modern browsers ship a
// native TextEncoder; we re-export it so the require resolves without pulling the (sometimes absent
// in thin offline caches) `text-encoding` polyfill. Bytes are identical to the native implementation.
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
export default { TextEncoder, TextDecoder };
