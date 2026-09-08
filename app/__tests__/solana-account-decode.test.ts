/**
 * The SPL account decoders (`solana/spl.ts`), pinned against REAL MAINNET BYTES.
 *
 * WHY THIS FILE EXISTS. The balance poll reads accounts in one `getMultipleAccounts` call instead
 * of five per-rail calls, which means the wallet now decodes the SPL token-account and mint-account
 * layouts ITSELF rather than letting `getTokenAccountBalance` parse them. A layout believed from
 * memory would be a wrong balance on a screen, so nothing here is believed: every offset is
 * checked against what the NODE said about the SAME account at the SAME time.
 *
 * PROVENANCE. `fixtures/solana/mainnet-accounts.json` is one `getMultipleAccounts` response, one
 * `getTokenAccountBalance` response and two `getBalance` responses from
 * `https://api.mainnet-beta.solana.com` on 2026-09-08 (public endpoint, read-only, no key, nothing
 * spent — the shipped Helius key is out of quota and was deliberately not used), stored verbatim.
 * The accounts are a real wallet, its real USDC token account, the USDC and EURC mints, and a
 * pubkey that has no account.
 *
 * WHAT THAT PINS, and it is the whole point:
 *   • the token account's `amount` decoded at offset 64 EQUALS the `amount` the node's own parser
 *     returned for that account — two independent readings of the same bytes;
 *   • the mint's `decimals` decoded at offset 44 EQUALS the `decimals` the node returned;
 *   • the wallet account's `lamports` EQUAL what `getBalance` answered, so replacing the separate
 *     balance call loses nothing;
 *   • an account that does not exist is `null`, not an empty account — the distinction the ATA
 *     sign gates refuse on.
 */
import {describe, test, expect} from '@jest/globals';
import {base64ToBytes} from '../lib/base64';
import {decodeSplTokenAmount, decodeSplMintDecimals, SPL_TOKEN_ACCOUNT_LEN, SPL_MINT_ACCOUNT_LEN, TOKEN_PROGRAM_ADDRESS} from '../solana/spl';
import accounts from './fixtures/solana/mainnet-accounts.json';

type Capture = {
  _provenance: {endpoint: string; captured_utc: string; addresses: Record<string, string>};
  getMultipleAccounts: {value: ({lamports: number; owner: string; data: [string, string]} | null)[]};
  getTokenAccountBalance: Record<string, {value: {amount: string; decimals: number}}>;
  getBalance: Record<string, {value: number}>;
};
const capture = accounts as unknown as Capture;
const [WALLET, USDC_ATA, USDC_MINT, EURC_MINT, ABSENT] = capture.getMultipleAccounts.value.map((_, i) =>
  [capture._provenance.addresses.wallet, capture._provenance.addresses.usdcAta,
    capture._provenance.addresses.usdcMint, capture._provenance.addresses.eurcMint,
    capture._provenance.addresses.absent][i]);
const [walletAcct, ataAcct, usdcMintAcct, eurcMintAcct, absentAcct] = capture.getMultipleAccounts.value;

describe('SPL account decoding against real mainnet bytes', () => {
  test('the fixture is what a mainnet node answered, not something this repo wrote', () => {
    expect(capture._provenance.endpoint).toBe('https://api.mainnet-beta.solana.com');
    expect(capture._provenance.captured_utc).toMatch(/^2026-09-08T/);
    expect(capture.getMultipleAccounts.value).toHaveLength(5);
  });

  test('a token account decodes to the SAME amount the node’s own parser reported', () => {
    expect(ataAcct).not.toBeNull();
    const bytes = base64ToBytes(ataAcct!.data[0]);
    expect(bytes).toHaveLength(SPL_TOKEN_ACCOUNT_LEN);
    expect(ataAcct!.owner).toBe(TOKEN_PROGRAM_ADDRESS);
    // The independent reading: ours, against the node's `getTokenAccountBalance` for this account.
    const nodeAnswer = capture.getTokenAccountBalance[USDC_ATA].value;
    expect(decodeSplTokenAmount(bytes, USDC_MINT).toString()).toBe(nodeAnswer.amount);
    expect(nodeAnswer.amount).toBe('1942268974221'); // restated so a re-capture cannot drift silently
  });

  test('a mint account decodes to the SAME decimals the node reported — for both shipped mints', () => {
    for (const acct of [usdcMintAcct, eurcMintAcct]) {
      expect(acct).not.toBeNull();
      const bytes = base64ToBytes(acct!.data[0]);
      expect(bytes).toHaveLength(SPL_MINT_ACCOUNT_LEN);
      expect(decodeSplMintDecimals(bytes)).toBe(6);
    }
    expect(capture.getTokenAccountBalance[USDC_ATA].value.decimals).toBe(6);
  });

  test('the wallet account carries exactly the lamports getBalance answers — so one call replaces both', () => {
    expect(walletAcct).not.toBeNull();
    expect(String(walletAcct!.lamports)).toBe(String(capture.getBalance[WALLET].value));
    // A plain wallet is owned by the System program and holds no data. It is not a token account,
    // and asking the token decoder for it must FAIL rather than return a number.
    expect(walletAcct!.owner).not.toBe(TOKEN_PROGRAM_ADDRESS);
    expect(() => decodeSplTokenAmount(base64ToBytes(walletAcct!.data[0]), USDC_MINT))
      .toThrow(/165 bytes|length/i);
  });

  test('an account that does not exist is null — and the node agrees its balance is zero', () => {
    expect(absentAcct).toBeNull();
    expect(capture.getBalance[ABSENT].value).toBe(0);
  });

  test('a token account holding a DIFFERENT mint is refused, not read as the expected one', () => {
    // The ATA address is derived from (wallet, mint); if the account at that address states another
    // mint, something is wrong in a way no balance should be shown for. Drive it with the real
    // bytes and the wrong expectation.
    expect(() => decodeSplTokenAmount(base64ToBytes(ataAcct!.data[0]), EURC_MINT))
      .toThrow(/mint/i);
  });

  test('a truncated token account is refused rather than decoded from whatever is there', () => {
    const short = base64ToBytes(ataAcct!.data[0]).slice(0, 64);
    expect(() => decodeSplTokenAmount(short, USDC_MINT)).toThrow(/165 bytes|length/i);
    expect(() => decodeSplMintDecimals(new Uint8Array(40))).toThrow(/82 bytes|length/i);
  });
});
