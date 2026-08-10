/**
 * cketh — the ckETH-minter ckERC-20 onramp calldata builder, as PURE functions.
 *
 * Dependency-free (no react-native, no fetch, no keccak lib) so it runs under jest on the fast
 * inner loop. This is the C-MOCK linchpin for the ckUSDC direct onramp: every byte produced here is
 * pinned byte-exact against the REAL Ethereum helper contract, so a unit test proves the onramp
 * "external interface" is represented accurately with zero network.
 *
 * WHAT IT BUILDS (the ckERC-20 onramp = two Ethereum transactions the USER signs from their own
 * wallet; dpay never sees the key — non-custodial):
 *
 *   1. approve(helper, amount) on the USDC ERC-20     — lets the helper pull the deposit.
 *   2. depositErc20(erc20, amount, principal, subacct) on the helper — helper pulls USDC and emits
 *      ReceivedEthOrErc20(...); the ckETH minter scrapes that log on a heartbeat and mints ckUSDC
 *      to Account{owner=principal, subaccount} on the ckUSDC ledger (~20 min).
 *
 * AUTHORITATIVE SOURCES (the values are CONSTANTS because the contract ABI is fixed at deploy):
 *   - helper contract: live `CkDeposit` = `DepositHelperWithSubaccount.sol`
 *     (DFINITY `ic` repo, rs/ethereum/cketh/minter/). Its mainnet address is fetched at RUNTIME from
 *     `get_minter_info().deposit_with_subaccount_helper_contract_address` on the ckETH minter
 *     `sv3dd-oaaaa-aaaar-qacoa-cai` — NEVER bundled here (it can change on minter upgrade).
 *   - principal→bytes32: verbatim `templates/principal_to_bytes.js` + `tests/principal_to_bytes_test.js`.
 *   - selectors verified via keccak256 against the known `approve(address,uint256)`=`0x095ea7b3`.
 *
 * The two function selectors and the ABI encoding are CONSTANTS; only the helper/min amounts move
 * to runtime config. See plan §9 (2026-07-30-ckusdc-onramp-offramp.md) for the pinned goldens.
 */

// --- byte helpers -----------------------------------------------------------------------------

/** Encode bytes as lowercase hex WITHOUT a 0x prefix. */
function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// --- IC principal → bytes32 -------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC-4648 base32 decode (no padding); IC principal text is lowercase base32 of crc32++principal. */
function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/-/g, '').toUpperCase();
  const bits: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const v = B32_ALPHABET.indexOf(clean[i]);
    if (v < 0) continue; // skip stray padding/whitespace
    for (let j = 4; j >= 0; j--) bits.push((v >> j) & 1);
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    out.push(byte);
  }
  return new Uint8Array(out);
}

/**
 * Encode an IC principal text (e.g. "k2t6j-...-6ae") as the 32-byte value the helper contract's
 * `depositErc20` expects for its `principal` argument. Returns 64 lowercase hex chars (no 0x).
 *
 * Algorithm (verbatim DFINITY `principal_to_bytes.js`): base32-decode (includes a 4-byte CRC32
 * prefix) → strip the first 4 bytes (CRC) → length-prefix into 32 bytes as
 * `[1-byte N=len][N principal-bytes][31-N zero pad]`.
 */
export function principalToBytes32(principal: string): string {
  const raw = base32Decode(principal);
  const p = raw.subarray(4); // strip the 4-byte CRC32 prefix
  const out = new Uint8Array(32);
  out[0] = p.length;
  out.set(p, 1);
  // remaining bytes are already zero (length-padded to 32)
  return bytesToHex(out);
}

// --- ABI encoding (constants; fixed at contract deploy) ---------------------------------------

/** keccak256("approve(address,uint256)") — verified against the canonical ERC-20 selector. */
export const SELECTOR_APPROVE = '095ea7b3';
/** keccak256("depositErc20(address,uint256,bytes32,bytes32)") — the live CkDeposit helper. */
export const SELECTOR_DEPOSIT_ERC20 = 'db9751af';
/**
 * keccak256("depositEth(bytes32,bytes32)") — the live CkDeposit helper's payable native-ETH deposit.
 * Verified 2026-08-06: the function signature is taken verbatim from DFINITY's
 * `rs/ethereum/cketh/minter/DepositHelperWithSubaccount.sol` (`CkDeposit.depositEth(bytes32 principal,
 * bytes32 subaccount) public payable`), and the keccak256 was computed with `js-sha3` cross-checked
 * against the two known selectors above (`approve`=095ea7b3, `depositErc20`=db9751af) so the hash
 * impl is proven correct → the resulting selector 17c819c4 is authoritative. The ETH `value` (Wei) is
 * sent as the tx's `value` field, NOT in the calldata (depositEth is payable).
 */
export const SELECTOR_DEPOSIT_ETH = '17c819c4';

/** Left-pad a 20-byte Ethereum address to a 32-byte word (64 lowercase hex chars, no 0x). */
function addressToWord(addr: string): string {
  return addr.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function normalizeSubaccount(input?: Uint8Array | string): Uint8Array {
  const out = new Uint8Array(32);
  if (input instanceof Uint8Array) {
    out.set(input.subarray(0, 32));
  } else if (typeof input === 'string') {
    const h = input.replace(/^0x/, '').toLowerCase();
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
    out.set(bytes.subarray(0, 32));
  }
  return out;
}

/** Encode a uint256 as a 32-byte big-endian word (64 lowercase hex chars, no 0x). */
function uint256ToWord(n: bigint): string {
  if (n < 0n) throw new Error('uint256 cannot be negative');
  return n.toString(16).padStart(64, '0');
}

/**
 * Build the calldata for the ERC-20 `approve(spender, amount)` call the user signs on the USDC
 * contract before depositing. Returns a 0x-prefixed hex string (selector + two 32-byte words).
 */
export function encodeApprove(spender: string, amount: bigint): string {
  return '0x' + SELECTOR_APPROVE + addressToWord(spender) + uint256ToWord(amount);
}

/**
 * Build the calldata for the helper contract's `depositErc20(erc20Address, amount, principal,
 * subaccount)` call. `principalWord` is the 64-hex output of `principalToBytes32`. `subaccount` is
 * an optional 32-byte value (default all-zeros = the default subaccount). Returns 0x-prefixed hex.
 */
export function encodeDepositErc20(
  erc20Address: string,
  amount: bigint,
  principalWord: string,
  subaccount?: Uint8Array | string,
): string {
  const sub = normalizeSubaccount(subaccount);
  return (
    '0x' +
    SELECTOR_DEPOSIT_ERC20 +
    addressToWord(erc20Address) +
    uint256ToWord(amount) +
    principalWord.replace(/^0x/, '').toLowerCase().padEnd(64, '0').slice(0, 64) +
    bytesToHex(sub)
  );
}

/**
 * Build the calldata for the helper contract's payable `depositEth(principal, subaccount)` call. This
 * is the NATIVE-ETH deposit (one tx, not two): the user sends ETH `value` (Wei) to the helper along
 * with this calldata; the helper emits `ReceivedEthOrErc20(ZERO_ADDRESS, msg.sender, msg.value, …)`
 * and the ckETH minter scrapes that log on a heartbeat and mints ckETH (~20 min). `principalWord` is
 * the 64-hex output of `principalToBytes32`; `subaccount` is an optional 32-byte value (default
 * all-zeros). Returns 0x-prefixed hex (selector + two 32-byte words = 68 bytes). The ETH amount is NOT
 * in the calldata — it travels as the transaction's `value` field (the caller sets it on sendTransaction).
 */
export function encodeDepositEth(
  principalWord: string,
  subaccount?: Uint8Array | string,
): string {
  const sub = normalizeSubaccount(subaccount);
  return (
    '0x' +
    SELECTOR_DEPOSIT_ETH +
    principalWord.replace(/^0x/, '').toLowerCase().padEnd(64, '0').slice(0, 64) +
    bytesToHex(sub)
  );
}
