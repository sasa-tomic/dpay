/**
 * classifyScan — what a scanned string is once the active rail's OWN payment codec has refused it.
 *
 * The camera used to have exactly one answer for every refusal ("This isn't a dpay payment code"),
 * which made two perfectly good codes dead ends: a printed payment LINK (the format `deepLink.ts`
 * exists to make shareable) and a plain wallet ADDRESS (what every wallet's receive QR contains,
 * dpay's own included). This module is the second opinion.
 *
 * The ordering is the contract, so it is what these tests pin.
 */
import {describe, test, expect} from '@jest/globals';
import {classifyScan} from '../lib/scan';

const IC_PRINCIPAL = 'k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae';
const ICP_ACCOUNT_ID = 'a'.repeat(64);
const EVM = '0x2D39863d5A1E1B1e8b7b0b8c7c9d0e1f2a3b4c5d';
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// The OpenCryptoPay till code (see opencryptopay.test.ts — it decodes to the DFX api URL). Kept
// uppercase, as a QR encodes it, which is exactly the case that overlaps the base58 alphabet.
const LNURL = 'LNURL1DP68GURN8GHJ7CTSDYHXGENC9EEHW6TNWVHHVVF0D3H82UNVWQHHQMZLVFJK2ERYVG6RZCMYX33RVEPEV5YEJ9WT';
const TILL_QR = `https://app.dfx.swiss/pl/?lightning=${LNURL}`;
const OCP_API_URL = 'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e';
const PAY_LINK = 'https://dpay.kalaj.org/wallet/pay/k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae?asset=VCHF&network=internet-computer&amount=1.5';

describe('classifyScan — payment links', () => {
  test('a full payment-link URL is a link', () => {
    expect(classifyScan(PAY_LINK)).toEqual({kind: 'link'});
  });

  test('a MALFORMED payment link is still a link — the link pipeline names the damaged part', () => {
    // Missing `network`: parsePayLink returns ok:false, which is a *link* verdict, not a refusal.
    // Routing it to the link handler is what produces "this link is missing its network" instead of
    // the camera's generic shrug.
    expect(classifyScan('https://dpay.kalaj.org/wallet/pay/abc?asset=VCHF')).toEqual({kind: 'link'});
  });

  test('a dpay:pay receipt hand-back is a link — it belongs on the Receive screen, not the scanner', () => {
    expect(classifyScan('dpay:pay/eyJsZWRnZXIiOiJhYmMifQ')).toEqual({kind: 'link'});
  });

  test('an unrelated https URL is NOT a link', () => {
    expect(classifyScan('https://dpay.kalaj.org/wallet')).toEqual({kind: 'unknown'});
  });
});

describe('classifyScan — OpenCryptoPay till codes', () => {
  test("a till's QR (the LNURL in a `lightning` parameter) resolves to the provider API URL + host", () => {
    expect(classifyScan(TILL_QR)).toEqual({
      kind: 'opencryptopay',
      ocp: {ok: true, apiUrl: OCP_API_URL, host: 'api.dfx.swiss'},
    });
  });

  test('a bare LNURL string is the same verdict — the QR wrapper is optional', () => {
    expect(classifyScan(LNURL)).toEqual({
      kind: 'opencryptopay',
      ocp: {ok: true, apiUrl: OCP_API_URL, host: 'api.dfx.swiss'},
    });
  });

  test('an UPPERCASE LNURL is NOT read as a Solana address — the OCP test runs first', () => {
    // The bech32 uppercase alphabet overlaps base58, so ordering is what keeps a merchant's till
    // code out of the send-to-address form.
    const verdict = classifyScan(LNURL);
    expect(verdict.kind).toBe('opencryptopay');
  });

  test('a DAMAGED till code is still an OCP verdict, carrying the checksum refusal', () => {
    // One scuffed character on a printed sticker. "Your code is damaged" is actionable; the
    // camera's generic "not a payment code" is not.
    expect(classifyScan(`${LNURL.slice(0, -1)}Q`)).toEqual({
      kind: 'opencryptopay',
      ocp: {ok: false, reason: 'bad-checksum'},
    });
  });

  test('a `lightning` parameter that holds no LNURL at all is not claimed', () => {
    expect(classifyScan('https://app.dfx.swiss/pl/?lightning=notanlnurl')).toEqual({kind: 'unknown'});
  });
});

describe('classifyScan — foreign coin payment requests', () => {
  test('a BIP-21 bitcoin: URI with parameters is refused as a bitcoin request', () => {
    expect(classifyScan(`bitcoin:${BTC}?amount=0.001&label=Coffee`)).toEqual({kind: 'coin-request', scheme: 'bitcoin'});
  });

  test('an UPPERCASE BITCOIN: URI is the same verdict — QR encoders uppercase', () => {
    expect(classifyScan(`BITCOIN:${BTC}`)).toEqual({kind: 'coin-request', scheme: 'bitcoin'});
  });

  test('an ethereum: URI (EIP-831 shape) is refused as an ethereum request', () => {
    expect(classifyScan(`ethereum:${EVM}?value=1e17`)).toEqual({kind: 'coin-request', scheme: 'ethereum'});
  });

  test('the match needs the colon — bitcoincash: is a different scheme and stays unknown', () => {
    expect(classifyScan('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')).toEqual({kind: 'unknown'});
  });

  test('a bare BTC address is still an ADDRESS — the scheme test never sees it', () => {
    expect(classifyScan(BTC)).toEqual({kind: 'address', shape: 'btc'});
  });
});

describe('classifyScan — addresses', () => {
  test.each([
    ['ic-account', IC_PRINCIPAL],
    ['icp-account-id', ICP_ACCOUNT_ID],
    ['evm', EVM],
    ['btc', BTC],
    ['base58', SOLANA],
  ])('a %s address is reported with its shape', (shape, text) => {
    expect(classifyScan(text)).toEqual({kind: 'address', shape});
  });

  test('surrounding whitespace does not change the verdict', () => {
    expect(classifyScan(`  ${IC_PRINCIPAL}\n`)).toEqual({kind: 'address', shape: 'ic-account'});
  });
});

describe('classifyScan — nothing recognised it', () => {
  test.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['prose', 'this is definitely not a valid request QR!!!'],
    // The wire request's own base64url — the codec already accepted or refused it before this
    // module is consulted, and neither the link nor any address namespace may claim it.
    ['a 176-char base64url blob', 'A1b2_C3d4-'.repeat(17) + 'A1b2_C'],
  ])('%s is unknown', (_label, text) => {
    expect(classifyScan(text)).toEqual({kind: 'unknown'});
  });
});
