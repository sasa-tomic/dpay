// keccak256 for the whole evm/ rail — ONE import point. The resolved @noble/hashes (1.4.0) exposes
// original-Keccak under the subpath `sha3` with the SNAKE_CASE name `keccak_256` (older noble
// versions named the same export `keccak256`); aliasing here means a noble upgrade touches exactly
// this file, not every hashing call site.
//
// This is ORIGINAL Keccak (0x01 domain padding), NOT NIST SHA-3 (0x06) — the hash every Ethereum
// primitive is defined over. Verified against the published reference vectors:
//   keccak256("")    = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
//   keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
// (the same constant also hand-rolled in lib/eip55.ts; the app carries both, each with its own
// pinned vectors — evm/ uses noble so the secp256k1 and keccak implementations share one library).
import {keccak_256} from '@noble/hashes/sha3';

export const keccak256 = keccak_256;
