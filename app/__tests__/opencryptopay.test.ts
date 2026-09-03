import {describe, it, expect} from '@jest/globals';
import {
  claimedMerchantNameOf,
  decodeLnurl,
  ocpPriceText,
  parseOcpScan,
  parseIcpUri,
  parseProviderInstant,
  parseSolanaUri,
  parsePaymentDetails,
  selectPayableOffers,
  type OcpDetails,
} from '../lib/opencryptopay';
import {PAY_LINK_TEXT_BYTES} from '../lib/deepLink';
import {parseDecimalToUnits} from '../lib/amount';
import {buildSelectableAssets, type SelectableAsset} from '../config/assets';
import {BUNDLED_NETWORKS, icpCatalogOf} from '../config/catalog';

// The pure OpenCryptoPay layer. Every value marked RECORDED below was measured against the live
// provider on 2026-09-01 (docs/specs/2026-09-01-opencryptopay-findings.md); everything else is
// marked as a fixture. Nothing here contacts the provider, and nothing here spends money.
//
// RECORDED: the LNURL decodes to `https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e` (hrp
// `lnurl`). The bech32 string itself was not written down, but the encoding of a given payload is
// canonical, so the code below IS that LNURL — and the first test proves the round trip.
const LNURL_EXAMPLE =
  'LNURL1DP68GURN8GHJ7CTSDYHXGENC9EEHW6TNWVHHVVF0D3H82UNVWQHHQMZLVFJK2ERYVG6RZCMYX33RVEPEV5YEJ9WT';
const API_URL = 'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e';
// RECORDED: the till's QR is the api URL's `app.` sibling with the LNURL in a `lightning` parameter.
const TILL_QR = `https://app.dfx.swiss/pl/?lightning=${LNURL_EXAMPLE}`;
// The same code with its final checksum character flipped (T → Q) — one scuff on a printed sticker.
const LNURL_CORRUPT = `${LNURL_EXAMPLE.slice(0, -1)}Q`;
// Fixture LNURLs, encoded the same way, carrying payloads the wallet must refuse:
// `http://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e` and the plain text `this is not a url`.
const LNURL_HTTP =
  'LNURL1DP68GUP69UHKZURF9EJXV7PWWDMKJUMN9AMRZTMVDE6HYMRS9ACXCHMZV4JKGERZXSCKXEP5VGMXGWT9N646KW';
const LNURL_NOT_A_URL = 'LNURL1W35XJUEQD9EJQMN0WSSXZGR4WFKQPD282P';
// A valid bech32 string with a different hrp (BIP-173 test vector) — a code, just not ours.
const BECH32_OTHER_HRP = 'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w';

// RECORDED: the live IC destination URI, trailing bare decimal point and all. `ly36x-…` is the VCHF
// ledger (identical to `vchf_ledger` in dfx/catalog_truth.json).
const ICP_URI =
  'icp:ly36x-wiaaa-aaaai-aqj7q-cai/transfer?to=ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae&amount=1.';
const VCHF_LEDGER = 'ly36x-wiaaa-aaaai-aqj7q-cai';
const ICP_URI_TO = 'ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae';
// RECORDED: `solana:2eQ2Somiat…?amount=1.246922`. The findings doc elides the address, so the tail
// here is a real Solana address standing in for it: what this pins is the scheme, the recorded
// amount, and that the parser returns the destination untouched.
const SOL_ADDR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SOLANA_URI = `solana:${SOL_ADDR}?amount=1.246922`;

// The wallet's REAL shipped asset rows (the bundled catalog the app falls back to on a cold start),
// with Solana USDC explicitly present — that is what makes the USDC refusal a policy decision
// rather than an artefact of the row being missing.
const WALLET_ASSETS: SelectableAsset[] = buildSelectableAssets(icpCatalogOf(BUNDLED_NETWORKS), {
  showTestnet: false,
  solanaEnabled: true,
  solanaUsdc: true,
});

// A step-2 body. RECORDED: the payment id `pl_beeddb41cd4b6d9e`, the CHF-1 fixed-amount till, the
// methods `InternetComputer` / `Solana`, the assets each accepts, the per-method `available` flag,
// and the Solana USDC amount 1.246922 (from the recorded destination URI). FIXTURE: the merchant
// name (never captured), the expiration instant, and every other per-asset amount. A VERBATIM
// recorded body is parsed in `opencryptopayClient.test.ts`, which is what pins the key names.
const EXPIRATION = '2026-09-01T12:00:00.000Z';
const EXPIRES_AT_MS = 1788264000000;
const BEFORE_EXPIRY = EXPIRES_AT_MS - 60_000;

function detailsBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: 'Test Till',
    callback: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e',
    quote: {id: 'q-8f31c2', expiration: EXPIRATION},
    requestedAmount: {asset: 'CHF', amount: 1},
    transferAmounts: [
      {
        method: 'InternetComputer',
        available: true,
        assets: [
          {asset: 'ckBTC', amount: 0.000016},
          {asset: 'VCHF', amount: 1},
          {asset: 'ICP', amount: 0.19},
          {asset: 'VEUR', amount: 1.07},
        ],
      },
      {
        method: 'Solana',
        available: true,
        assets: [
          {asset: 'SOL', amount: 0.006},
          {asset: 'USDC', amount: 1.246922},
          {asset: 'USDT', amount: 1.246922},
        ],
      },
    ],
    ...overrides,
  };
}

/** Parse a fixture body through the REAL parser, so every `selectPayableOffers` case consumes
 *  details that were actually narrowed rather than hand-built. */
function detailsOf(overrides: Record<string, unknown> = {}): OcpDetails {
  const parsed = parsePaymentDetails(detailsBody(overrides));
  if (!parsed.ok) throw new Error(`fixture body must parse, got refusal ${parsed.reason}`);
  return parsed.details;
}

describe('decodeLnurl', () => {
  it('decodes the recorded example LNURL to the exact provider URL, in either case', () => {
    // A QR carries the uppercase form; a pasted one is usually lowercase. Both are the same code.
    expect(decodeLnurl(LNURL_EXAMPLE)).toEqual({ok: true, url: API_URL});
    expect(decodeLnurl(LNURL_EXAMPLE.toLowerCase())).toEqual({ok: true, url: API_URL});
    expect(decodeLnurl(`  ${LNURL_EXAMPLE}\n`)).toEqual({ok: true, url: API_URL});
    // 94 characters: past bech32's 90-char limit, which LUD-01 lifts. A decoder that kept the limit
    // would refuse the provider's real code.
    expect(LNURL_EXAMPLE.length).toBe(94);
  });

  it('refuses a single scuffed character instead of resolving to a different host', () => {
    // The whole reason the checksum is verified: without it, damage silently changes the URL the
    // wallet would then trust for the merchant name, the amount and the destination.
    expect(decodeLnurl(LNURL_CORRUPT)).toEqual({ok: false, reason: 'bad-checksum'});
    expect(decodeLnurl(LNURL_CORRUPT.toLowerCase())).toEqual({ok: false, reason: 'bad-checksum'});
  });

  it('refuses damage that never reaches the checksum, as a damaged code', () => {
    // `b` is not in the bech32 charset; a truncated tail has no checksum left; mixed case has no
    // defined checksum at all. All three are "this code is broken", not "this is not our code".
    expect(decodeLnurl('lnurl1b4n0q5v')).toEqual({ok: false, reason: 'malformed-lnurl'});
    expect(decodeLnurl('lnurl1dgmt')).toEqual({ok: false, reason: 'malformed-lnurl'});
    expect(decodeLnurl(`LNURL1${LNURL_EXAMPLE.slice(6).toLowerCase()}`)).toEqual({ok: false, reason: 'malformed-lnurl'});
  });

  it('reports a string that is not an LNURL as such, not as damage', () => {
    // The user's next action differs: scan a different code, versus rescan this one.
    for (const s of ['', '   ', 'hello world', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', BECH32_OTHER_HRP]) {
      expect(decodeLnurl(s)).toEqual({ok: false, reason: 'not-lnurl'});
    }
  });
});

describe('parseOcpScan', () => {
  it('accepts the till QR and the bare code, returning the provider URL verbatim plus its host', () => {
    // The host is what the review screen shows: an LNURL can name any server, so the payer must be
    // able to see whose quote they are about to pay.
    expect(parseOcpScan(TILL_QR)).toEqual({ok: true, apiUrl: API_URL, host: 'api.dfx.swiss'});
    expect(parseOcpScan(LNURL_EXAMPLE)).toEqual({ok: true, apiUrl: API_URL, host: 'api.dfx.swiss'});
  });

  it('refuses a code that decodes to a non-https URL', () => {
    expect(parseOcpScan(LNURL_HTTP)).toEqual({ok: false, reason: 'not-https'});
    expect(parseOcpScan(`https://app.dfx.swiss/pl/?lightning=${LNURL_HTTP}`)).toEqual({ok: false, reason: 'not-https'});
  });

  it('accepts the spellings a real till may print, not just the one we developed against', () => {
    // AUDITED 2026-09-02 against DFX's own frontend (`DFXswiss/services`: the sticker generator
    // prints `<host>/pl?lightning=<LNURL>`), so the wrapper URL is the shape a SPAR counter shows.
    // These are the OTHER spellings the wider LNURL world uses, each of which this parser refused
    // as "not a payment code" — a silent dead end at a checkout, with no way for the payer to tell
    // a damaged sticker from an unsupported one. Cheap to accept, and none of them is ambiguous.
    const expected = {ok: true, apiUrl: API_URL, host: 'api.dfx.swiss'};
    // 1. the `lightning:` URI scheme — the most common LNURL encoding outside this provider.
    expect(parseOcpScan(`lightning:${LNURL_EXAMPLE}`)).toEqual(expected);
    expect(parseOcpScan(`LIGHTNING:${LNURL_EXAMPLE}`)).toEqual(expected);
    expect(parseOcpScan(`lightning://${LNURL_EXAMPLE}`)).toEqual(expected);
    // 2. an all-uppercase wrapper URL — QR encoders choose alphanumeric mode for a denser code,
    //    which uppercases the whole string, parameter name included.
    expect(parseOcpScan(`https://app.dfx.swiss/pl/?LIGHTNING=${LNURL_EXAMPLE}`)).toEqual(expected);
    // 3. the provider's own endpoint printed directly, with no LNURL wrapper. `PaymentLinkDto`
    //    carries `url` beside `frontendUrl`, so a sticker made from the wrong field looks like this.
    expect(parseOcpScan(API_URL)).toEqual(expected);
  });

  it('does not mistake other https codes for a till just because they are URLs', () => {
    // The bare-URL branch above is admitted ONLY for an LNURL-pay endpoint path (`/lnurlp/`). dpay's
    // own payment link is also an https URL and must keep routing to the link parser, and a random
    // site must stay "not a payment code" rather than becoming a provider this wallet would call.
    expect(parseOcpScan('https://dpay.kalaj.org/wallet/pay/ygf2v-iniac-cojwe-damoz-s4act-k4xft-xgpjy-776wl-wr754-qxkgo-4ae?asset=ICP')).toEqual({ok: false, reason: 'not-lnurl'});
    expect(parseOcpScan('https://example.com/pay')).toEqual({ok: false, reason: 'not-lnurl'});
    // http on the provider endpoint is a downgrade, refused with its own reason (not "not-lnurl").
    expect(parseOcpScan('http://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e')).toEqual({ok: false, reason: 'not-https'});
  });

  it('refuses a code that decodes to something that is not a URL', () => {
    expect(parseOcpScan(LNURL_NOT_A_URL)).toEqual({ok: false, reason: 'not-a-url'});
  });

  it('is not-lnurl for a URL carrying no lightning parameter, or an empty parameter', () => {
    expect(parseOcpScan('https://app.dfx.swiss/pl/')).toEqual({ok: false, reason: 'not-lnurl'});
    expect(parseOcpScan('https://app.dfx.swiss/pl/?lightning=')).toEqual({ok: false, reason: 'not-lnurl'});
    expect(parseOcpScan('')).toEqual({ok: false, reason: 'not-lnurl'});
  });

  it('carries a damaged code’s reason out through the QR wrapper', () => {
    // The QR is the shape a user actually scans, so the checksum refusal has to survive the
    // parameter unwrapping — otherwise a scuffed sticker reads as "not an OpenCryptoPay code".
    expect(parseOcpScan(`https://app.dfx.swiss/pl/?lightning=${LNURL_CORRUPT}`)).toEqual({
      ok: false,
      reason: 'bad-checksum',
    });
  });
});

describe('parseIcpUri', () => {
  it('parses the recorded IC destination URI, trailing bare decimal point and all', () => {
    expect(parseIcpUri(ICP_URI)).toEqual({ok: true, ledger: VCHF_LEDGER, to: ICP_URI_TO, amount: '1.'});
  });

  it('hands the amount on in a spelling the project’s converter accepts', () => {
    // The grammar gate here and the exact converter in lib/amount.ts must agree, or a live URI
    // would be refused (or worse, carried forward) at the boundary between them. `1.` is exactly
    // the spelling naive parsers turn into 0 — the money bug this pins shut.
    const parsed = parseIcpUri(ICP_URI);
    if (!parsed.ok) throw new Error(`recorded URI must parse, got ${parsed.reason}`);
    expect(parseDecimalToUnits(parsed.amount, 8).ok).toBe(true);
  });

  it('refuses any shape that is not `<ledger>/transfer?…`', () => {
    // The URI names the ledger CALL the wallet would make; only a plain transfer is on the table.
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/approve?to=${ICP_URI_TO}&amount=1`)).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseIcpUri(`icp:${VCHF_LEDGER}?to=${ICP_URI_TO}&amount=1`)).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseIcpUri(`icp:/transfer?to=${ICP_URI_TO}&amount=1`)).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer`)).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?amount=1`)).toEqual({ok: false, reason: 'malformed-uri'});
  });

  it('refuses a parameter it does not understand rather than paying the part it does', () => {
    // THE money case: `subaccount` names an account this app's transfer does not address, so
    // ignoring it would pay the owner's DEFAULT account — a different account than the URI named,
    // with no way for the payer to see the difference. A dropped parameter is an instruction the
    // provider gave and nobody read.
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?to=${ICP_URI_TO}&subaccount=abcd&amount=1.`)).toEqual({
      ok: false,
      reason: 'unexpected-parameter',
    });
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?to=${ICP_URI_TO}&amount=1.&memo=42`)).toEqual({
      ok: false,
      reason: 'unexpected-parameter',
    });
    // …and the two it does understand still parse, in either order: this is a closed set, not a
    // rejection of anything unfamiliar-looking.
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?amount=1.&to=${ICP_URI_TO}`)).toEqual({
      ok: true,
      ledger: VCHF_LEDGER,
      to: ICP_URI_TO,
      amount: '1.',
    });
  });

  it('refuses a repeated parameter rather than picking one of the two amounts', () => {
    expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?to=${ICP_URI_TO}&amount=1&amount=999`)).toEqual({
      ok: false,
      reason: 'malformed-uri',
    });
  });

  it('refuses a missing or unreadable amount instead of reading it as zero', () => {
    for (const amount of ['', 'abc', '-1', '1.2.3', '1e8', '+1', ' ']) {
      expect(parseIcpUri(`icp:${VCHF_LEDGER}/transfer?to=${ICP_URI_TO}&amount=${amount}`)).toEqual({
        ok: false,
        reason: 'bad-amount',
      });
    }
  });

  it('refuses a URI belonging to another scheme', () => {
    expect(parseIcpUri(SOLANA_URI)).toEqual({ok: false, reason: 'wrong-scheme'});
    expect(parseIcpUri(API_URL)).toEqual({ok: false, reason: 'wrong-scheme'});
    expect(parseIcpUri('')).toEqual({ok: false, reason: 'wrong-scheme'});
  });
});

describe('parseSolanaUri', () => {
  it('parses the recorded Solana destination URI', () => {
    expect(parseSolanaUri(SOLANA_URI)).toEqual({ok: true, to: SOL_ADDR, amount: '1.246922'});
  });

  it('refuses a URI naming an SPL token rather than paying it as native SOL', () => {
    // The live provider omits `spl-token` even for USDC, so a URI that carries one contradicts the
    // asset the wallet selected. Ignoring the parameter would send SOL to a token account.
    expect(parseSolanaUri(`${SOLANA_URI}&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)).toEqual({
      ok: false,
      reason: 'spl-token-unsupported',
    });
  });

  it('refuses Solana Pay’s transaction-request form, which is not a transfer at all', () => {
    expect(parseSolanaUri('solana:https://example.test/pay?amount=1')).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseSolanaUri(`solana:${SOL_ADDR}`)).toEqual({ok: false, reason: 'malformed-uri'});
    expect(parseSolanaUri('solana:?amount=1')).toEqual({ok: false, reason: 'malformed-uri'});
  });

  it('refuses a missing or unreadable amount instead of reading it as zero', () => {
    for (const amount of ['', 'abc', '-0.5', '1,25']) {
      expect(parseSolanaUri(`solana:${SOL_ADDR}?amount=${amount}`)).toEqual({ok: false, reason: 'bad-amount'});
    }
  });

  it('refuses every OTHER Solana Pay parameter instead of silently dropping it', () => {
    // Solana Pay's grammar has five more fields and none of them may be ignored here: `reference`
    // is an account the transaction must CARRY for the payee to find the payment, `memo` demands an
    // instruction this rail does not build, and `label`/`message` are stranger-supplied text this
    // review never renders — accepting one means approving a URI that says something the payer was
    // not shown. The live provider sends none of them, so refusing costs a real payment nothing.
    for (const param of ['reference=8Fw45', 'memo=order-12', 'label=Till', 'message=Thanks', 'unknown=1']) {
      expect(parseSolanaUri(`solana:${SOL_ADDR}?amount=1.246922&${param}`)).toEqual({
        ok: false,
        reason: 'unexpected-parameter',
      });
    }
    // `spl-token` keeps its OWN louder reason — it contradicts the selected asset, which is a
    // different thing to tell the payer than "a field I don't know".
    expect(parseSolanaUri(`solana:${SOL_ADDR}?amount=1.246922&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&label=x`)).toEqual({
      ok: false,
      reason: 'spl-token-unsupported',
    });
  });

  it('refuses a URI belonging to another scheme', () => {
    expect(parseSolanaUri(ICP_URI)).toEqual({ok: false, reason: 'wrong-scheme'});
    expect(parseSolanaUri('')).toEqual({ok: false, reason: 'wrong-scheme'});
  });
});

describe('parseProviderInstant', () => {
  it('reads the RECORDED spelling exactly, milliseconds and all', () => {
    // The measured value shape (findings doc): an RFC 3339 UTC instant with milliseconds and a Z.
    expect(parseProviderInstant('2026-09-01T14:50:04.660Z')).toBe(Date.UTC(2026, 8, 1, 14, 50, 4, 660));
    expect(parseProviderInstant('2026-09-01T14:50:04Z')).toBe(Date.UTC(2026, 8, 1, 14, 50, 4, 0));
    // A 1–3 digit fraction is MILLISECONDS: ".6" is 600ms, padded, never read as 6.
    expect(parseProviderInstant('2026-09-01T14:50:04.6Z')).toBe(Date.UTC(2026, 8, 1, 14, 50, 4, 600));
  });

  it('refuses the local-time spelling that `Date.parse` would have believed', () => {
    // THE bug: `Date.parse("2026-09-01 14:50:04")` is engine-defined and V8 reads it as DEVICE-LOCAL
    // time. On a phone set to UTC+14 that is a quote which died fourteen hours ago being treated as
    // live — and this deadline is what decides whether the ONE-SHOT submission is spent at all.
    // The oracle is asserted, not assumed: `Date.parse` really does accept it.
    expect(Number.isFinite(Date.parse('2026-09-01 14:50:04'))).toBe(true);
    expect(parseProviderInstant('2026-09-01 14:50:04')).toBeNull();
    // Every other spelling `Date.parse` would take: no zone at all (also local), an explicit offset,
    // a bare date (midnight UTC), the legacy formats, and sub-millisecond precision this parser
    // will not round. None of them is what the provider sends, so each is an expiry dpay cannot
    // read — which the payer is told, rather than guessed at.
    for (const s of [
      '2026-09-01T14:50:04',
      '2026-09-01T14:50:04+02:00',
      '2026-09-01',
      'Tue, 01 Sep 2026 14:50:04 GMT',
      '2026-09-01T14:50:04.123456Z',
      '2026-09-01t14:50:04.660z',
      ' 2026-09-01T14:50:04.660Z',
    ]) {
      expect(parseProviderInstant(s)).toBeNull();
    }
  });

  it('refuses a date that does not exist instead of rolling it over into another day', () => {
    // `Date.UTC(2026, 1, 30)` is 2 March — a different deadline than the one sent. Round-tripped
    // through the UTC fields so the arithmetic cannot quietly repair a nonsense instant.
    for (const s of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-09-01T24:00:00Z', '2026-09-01T14:60:04Z']) {
      expect(parseProviderInstant(s)).toBeNull();
    }
  });

  it('refuses anything that is not a string, without throwing', () => {
    // A JSON number here would be an epoch in seconds or milliseconds — indistinguishable, and
    // guessing between them is the same class of coercion.
    for (const v of [undefined, null, 1788264000, 1788264000000, {}, ['2026-09-01T14:50:04.660Z']]) {
      expect(parseProviderInstant(v)).toBeNull();
    }
  });
});

describe('claimedMerchantNameOf', () => {
  it('renders a hostile name harmless instead of letting it own the screen', () => {
    // The scanned code names the host and the host writes this string, so it is hostile input by
    // construction. React Native `Text` renders newlines: unbounded, thirty of them push the
    // provider host, the countdown and the destination account off the visible screen — deleting
    // exactly the lines that make a sticker-over-the-till answerable. Neutralised, not dropped, so
    // the name still reads as its own words.
    expect(claimedMerchantNameOf({displayName: 'Kiosk\n\n\n\n\n\n\n\n\n\nam Bahnhof'})).toBe('Kiosk am Bahnhof');
    expect(claimedMerchantNameOf({displayName: 'Kiosk  \tam\r\nBahnhof'})).toBe('Kiosk am Bahnhof');
    // Bidi overrides can display a name (or a host beside it) reversed; zero-width padding hides
    // where a name really ends. Both are removed outright — they render as nothing anyway.
    expect(claimedMerchantNameOf({displayName: 'Kiosk\u202E\u200B\uFEFFam Bahnhof'})).toBe('Kioskam Bahnhof');
    expect(claimedMerchantNameOf({displayName: '\u0000\u202E   \u200B'})).toBeNull();
  });

  it('caps the name and MARKS it when the cap cut something', () => {
    // Same cap as a payment link's `label` (`lib/deepLink.ts`) — one payee-name rule wherever the
    // name came from. The ellipsis is the part that matters: an unmarked truncation would name a
    // DIFFERENT merchant than the string did, and the payer would have no way to tell.
    const long = 'Migros Supermarkt Bahnhofstrasse Zürich';
    const name = claimedMerchantNameOf({displayName: long});
    expect(name).toBe(`${long.slice(0, PAY_LINK_TEXT_BYTES)}…`);
    expect(name?.endsWith('…')).toBe(true);
    // A name that fits is returned whole, with nothing added: the marker means "cut", so it must
    // never appear on a name that was not.
    expect(claimedMerchantNameOf({displayName: '  Test Shop  '})).toBe('Test Shop');
    // Multi-byte names are capped in BYTES on a character boundary — never mid-character.
    expect(claimedMerchantNameOf({displayName: '☕'.repeat(20)})).toBe(`${'☕'.repeat(10)}…`);
  });
});

describe('parsePaymentDetails', () => {
  it('narrows the till’s answer and derives the submission URL from the callback', () => {
    const parsed = parsePaymentDetails(detailsBody());
    if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
    const d = parsed.details;
    // RECORDED: the provider accepts the callback's `/cb/` segment swapped for `/tx/`. Derived here,
    // at parse time, so a callback that cannot produce one refuses the payment BEFORE the payer
    // consents — the alternative is irreversible funds moving with no request ever issued.
    expect(d.submitUrl).toBe('https://api.dfx.swiss/v1/lnurlp/tx/pl_beeddb41cd4b6d9e');
    expect(d.quoteId).toBe('q-8f31c2');
    expect(d.quoteExpiresAt).toBe(EXPIRES_AT_MS);
    expect(d.callbackUrl).toBe('https://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e');
    expect(d.claimedMerchantName).toBe('Test Till');
    expect(d.requestedAmount).toEqual({asset: 'CHF', amount: '1'});
    expect(d.transferAmounts.map(t => t.method)).toEqual(['InternetComputer', 'Solana']);
    expect(d.transferAmounts[1].assets.map(a => a.asset)).toEqual(['SOL', 'USDC', 'USDT']);
  });

  it('turns JSON number amounts into exact decimal strings, including sub-microunit ones', () => {
    // `String(1.6e-7)` is "1.6e-7", which every decimal parser in this codebase rejects — so a
    // 16-satoshi price would be refused (or, with a sloppier parser, mis-scaled) unless the
    // exponent is expanded here.
    const parsed = parsePaymentDetails(
      detailsBody({
        transferAmounts: [
          {method: 'InternetComputer', available: true, assets: [{asset: 'ckBTC', amount: 1.6e-7}, {asset: 'VCHF', amount: 1e21}]},
        ],
      }),
    );
    if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
    expect(parsed.details.transferAmounts[0].assets).toEqual([
      {asset: 'ckBTC', amount: '0.00000016'},
      {asset: 'VCHF', amount: '1000000000000000000000'},
    ]);
    // The ordinary case keeps its plain spelling.
    expect(detailsOf().transferAmounts[0].assets[0]).toEqual({asset: 'ckBTC', amount: '0.000016'});
  });

  it('reports a missing merchant name as absent, never as an empty name', () => {
    // A name is display text: its absence must not block a payment, and the review screen falls back
    // to the provider host, which is verified information.
    expect(parsePaymentDetails(detailsBody({displayName: '   '}))).toEqual({
      ok: true,
      details: expect.objectContaining({claimedMerchantName: null}),
    });
    expect(parsePaymentDetails(detailsBody({displayName: 42}))).toEqual({
      ok: true,
      details: expect.objectContaining({claimedMerchantName: null}),
    });
  });

  it('keeps paying a till that advertises methods it cannot currently settle', () => {
    // MEASURED against the live provider on 2026-09-01: every response carries `TaprootAsset`,
    // `Spark` and `Arkade` as `{available: false, assets: []}`. Refusing the whole body over them —
    // which is what this parser did until this test was written — made EVERY real till unpayable
    // while the entire suite stayed green, because no fixture here or in `e2e/harness/ocp.mjs` ever
    // carried an empty list. The entry names nothing this wallet could select, so it is dropped and
    // the payable methods beside it survive.
    const withDeadMethods = parsePaymentDetails(detailsBody({
      transferAmounts: [
        {method: 'TaprootAsset', available: false, assets: []},
        ...(detailsBody().transferAmounts as unknown[]),
        {method: 'Spark', available: false, assets: []},
      ],
    }));
    expect(withDeadMethods.ok).toBe(true);
    if (!withDeadMethods.ok) return;
    expect(withDeadMethods.details.transferAmounts.map(t => t.method)).toEqual(['InternetComputer', 'Solana']);
  });

  it('refuses a body missing anything the payment depends on', () => {
    for (const body of [
      // `available: true` with nothing to settle is the CONTRADICTORY case, and stays malformed: a
      // method claiming to be settleable must name what it settles. The coherent case above is the
      // only widening — a method the provider itself marks unavailable.
      detailsBody({transferAmounts: [{method: 'Spark', available: false, assets: []}]}),
      detailsBody({callback: undefined}),
      detailsBody({quote: undefined}),
      detailsBody({quote: {id: '', expiration: EXPIRATION}}),
      detailsBody({quote: {id: 'q', expiration: 'not a date'}}),
      detailsBody({quote: {id: 'q', expiration: 1788264000}}),
      detailsBody({transferAmounts: []}),
      detailsBody({transferAmounts: [{method: '', available: true, assets: [{asset: 'ICP', amount: 1}]}]}),
      detailsBody({transferAmounts: [{method: 'InternetComputer', available: true, assets: []}]}),
      detailsBody({callback: 'https:///'}),
    ]) {
      expect(parsePaymentDetails(body)).toEqual({ok: false, reason: 'malformed-details'});
    }
    for (const notAnObject of [null, undefined, 'ok', 7, [detailsBody()]]) {
      expect(parsePaymentDetails(notAnObject)).toEqual({ok: false, reason: 'malformed-details'});
    }
  });

  it('refuses a quote expiry in any spelling but the provider’s own, including the lenient ones', () => {
    // Pinned HERE and not only on `parseProviderInstant`, because this is the site that matters:
    // the quote deadline decides whether the one-shot submission is spent at all. `Date.parse`
    // accepts all three of these — the first two as DEVICE-LOCAL time, which is up to 14 hours of
    // skew between a phone and the provider, i.e. a long-dead price the wallet believes is live.
    // (Under jest the zone is pinned to UTC, so the skew itself cannot be reproduced here; what is
    // pinned is that the lenient spellings are REFUSED rather than read.)
    expect(Number.isFinite(Date.parse('2026-09-01 12:00:00'))).toBe(true);
    for (const expiration of ['2026-09-01 12:00:00', '2026-09-01T12:00:00', '2026-09-01T12:00:00+02:00', '2026-09-01']) {
      expect(parsePaymentDetails(detailsBody({quote: {id: 'q', expiration}}))).toEqual({
        ok: false,
        reason: 'malformed-details',
      });
    }
  });

  it('treats the till’s own price as display context — never as a reason to refuse the payment', () => {
    // It is the MERCHANT's figure ("CHF 1"), shown beside the asset amount so the payer can check
    // it against the price on the till. Like the merchant name it is display context, so its
    // absence yields null and the payment proceeds — a body without it used to refuse the WHOLE
    // payment on a field nothing read, which is a refusal that buys the payer nothing.
    for (const requestedAmount of [undefined, null, {asset: 'CHF'}, {asset: '', amount: 1}, {amount: 1}, 'CHF 1']) {
      expect(parsePaymentDetails(detailsBody({requestedAmount}))).toEqual({
        ok: true,
        details: expect.objectContaining({requestedAmount: null}),
      });
    }
    // A JSON NUMBER (measured: `requestedAmount.amount` is a number while asset amounts are
    // strings) becomes an exact decimal string, the same as everywhere else in this parser.
    expect(detailsOf({requestedAmount: {asset: 'CHF', amount: 1.5}}).requestedAmount).toEqual({asset: 'CHF', amount: '1.5'});
  });
});

describe('ocpPriceText', () => {
  it('spells the till’s own price for the review line, without touching a digit', () => {
    // The ordinary case, from the measured body: a JSON number 1 → "CHF 1".
    expect(ocpPriceText({asset: 'CHF', amount: '1'})).toBe('CHF 1');
    // No rounding and no re-precision: a long amount survives whole, which is what makes this a
    // spelling function and not a formatter (dpay does not quote, and must not restate a price).
    expect(ocpPriceText({asset: 'EUR', amount: '1234.567890123456789'})).toBe('EUR 1234.567890123456789');
  });

  it('straightens the two calculator spellings the provider’s grammar admits', () => {
    // `RE_DECIMAL_AMOUNT` accepts `1.` because the live provider sends exactly that for its VCHF
    // amount. Rendered raw it collides with the copy's own full stop ("charging CHF 1.."), and a
    // leading bare point reads as a typo — so the point is straightened and nothing else is.
    expect(ocpPriceText({asset: 'CHF', amount: '1.'})).toBe('CHF 1');
    expect(ocpPriceText({asset: 'CHF', amount: '.5'})).toBe('CHF 0.5');
  });

  it('cannot be used to clear the review screen', () => {
    // The provider's `asset` is free text this parser only TRIMS — a ticker of newlines would push
    // the host line, the countdown and the destination account out of view, which is the same
    // layout weapon the merchant name closes. Same door, same helper.
    expect(ocpPriceText({asset: '\n'.repeat(40) + 'CHF', amount: '1'})).toBe('CHF 1');
    expect(ocpPriceText({asset: '‮CHF​', amount: '1'})).toBe('CHF 1');
    // And the amount grammar bounds the CHARACTERS, not the LENGTH: a thousand-digit price does the
    // same damage with no control character in it. A cut is MARKED — a cut price is a different
    // price, and an unmarked truncation would read as the whole one.
    const long = ocpPriceText({asset: 'CHF', amount: '9'.repeat(1000)});
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(40);
    // A cap that never cuts a real price: the mark appears only on a figure no till would send.
    expect(ocpPriceText({asset: 'CHF', amount: '1234567.89'})).toBe('CHF 1234567.89');
  });

  it('refuses a method that omits its availability flag, rather than reading absence as permission', () => {
    // `available` is measured on every live response and is the provider saying whether it can
    // settle that method at all. A body without a boolean there is a shape this parser does not
    // know: defaulting it to "available" would put an option on screen that fails only after the
    // payer has chosen it and, on the IC rail, after the quote is already being spent.
    for (const available of [undefined, null, 'true', 1, 'false']) {
      const body = detailsBody({
        transferAmounts: [{method: 'InternetComputer', available, assets: [{asset: 'ICP', amount: 1}]}],
      });
      expect(parsePaymentDetails(body)).toEqual({ok: false, reason: 'malformed-details'});
    }
  });

  it('refuses a callback that yields no submission URL — BEFORE anything can be paid', () => {
    // The loss path's worst shape: a callback with no `/cb/` segment means a payment made against
    // this till could never be reported. Discovering that after the transfer leaves irreversible
    // funds on-chain with no request even issued, so it is refused here, at parse time, while
    // nothing has moved. Its OWN reason, not `malformed-details`: rescanning yields the same
    // callback, so the two facts do not share an instruction.
    for (const callback of [
      'https://api.dfx.swiss/v1/lnurlp/pl_beeddb41cd4b6d9e', // the segment is simply absent
      'https://api.dfx.swiss/v1/lnurlp/cb/',                 // present, but names no till
      'https://api.dfx.swiss/cb',                            // not a segment: no trailing slash
      'https://api.dfx.swiss/',
    ]) {
      expect(parsePaymentDetails(detailsBody({callback}))).toEqual({ok: false, reason: 'unreportable-callback'});
    }
    // The provider's own query survives onto the submission URL — it belongs to the provider, and
    // the submission only ADDS its four parameters to it.
    const parsed = parsePaymentDetails(detailsBody({callback: 'https://api.dfx.swiss/v1/lnurlp/cb/pl_x?tenant=zug'}));
    expect(parsed).toEqual({
      ok: true,
      details: expect.objectContaining({submitUrl: 'https://api.dfx.swiss/v1/lnurlp/tx/pl_x?tenant=zug'}),
    });
  });

  it('refuses a callback the wallet would have to call over http', () => {
    // This is the URL that reports an irreversible transfer; it gets the same https rule the
    // scanned code does.
    expect(parsePaymentDetails(detailsBody({callback: 'http://api.dfx.swiss/v1/lnurlp/cb/pl_beeddb41cd4b6d9e'}))).toEqual({
      ok: false,
      reason: 'not-https',
    });
  });

  it('refuses the whole body when one asset amount is unreadable', () => {
    // Dropping the unreadable entry would put a shorter menu on screen with nothing to explain the
    // gap — and the missing row might be the only asset the payer holds.
    for (const amount of [null, 'abc', -1, Number.NaN, {}]) {
      const body = detailsBody({
        transferAmounts: [
          {method: 'InternetComputer', available: true, assets: [{asset: 'ICP', amount: 1}, {asset: 'VCHF', amount}]},
        ],
      });
      expect(parsePaymentDetails(body)).toEqual({ok: false, reason: 'malformed-details'});
    }
  });
});

describe('selectPayableOffers', () => {
  it('pays exactly what the wallet carries, in exact raw units', () => {
    const {payable} = selectPayableOffers(detailsOf(), WALLET_ASSETS, BEFORE_EXPIRY);
    // Native ICP and SOL only. ckBTC and VCHF are on the till's list and in this wallet, but the
    // provider verifies every Internet Computer payment against the ICP LEDGER whatever asset was
    // declared — measured 2026-09-03 at the cost of one real payment — so paying either would move
    // money the sale is never credited for. They are refused by name below, never silently dropped.
    expect(payable).toEqual([
      {method: 'InternetComputer', asset: 'ICP', amount: '0.19', assetId: 'ic:8', rawAmount: '19000000'},
      {method: 'Solana', asset: 'SOL', amount: '0.006', assetId: 'solana:SOL', rawAmount: '6000000'},
    ]);
  });

  it('refuses every IC asset but native ICP, by name, because the provider cannot verify them', () => {
    // The expensive lesson, pinned. The provider reads the reported block index off the ICP ledger
    // for every `InternetComputer` asset, so only native ICP is ever looked up on the right ledger.
    // Proven by bracketing the provider's found/not-found boundary: it falls on the ICP ledger's
    // tip (38_148_321), not on VCHF's (81_001) or ckBTC's (4_593_555).
    const {payable, refused} = selectPayableOffers(detailsOf(), WALLET_ASSETS, BEFORE_EXPIRY);
    for (const asset of ['ckBTC', 'VCHF', 'VEUR']) {
      expect(refused).toContainEqual({method: 'InternetComputer', asset, reason: 'provider-checks-icp-ledger'});
    }
    expect(payable.filter(o => o.method === 'InternetComputer').map(o => o.asset)).toEqual(['ICP']);
  });

  it('refuses Solana USDC by name even though the wallet carries that exact asset', () => {
    // The wallet HAS solana:USDC — the refusal is a decision (the provider's URI carries no
    // spl-token parameter and it is unresolved whether its address is the owner or the token
    // account), not a missing row. Hiding it would leave the payer wondering why their USDC is not
    // on the list.
    expect(WALLET_ASSETS.some(a => a.id === 'solana:USDC')).toBe(true);
    const {payable, refused} = selectPayableOffers(detailsOf(), WALLET_ASSETS, BEFORE_EXPIRY);
    expect(payable.some(o => o.asset === 'USDC')).toBe(false);
    expect(refused).toContainEqual({method: 'Solana', asset: 'USDC', reason: 'solana-usdc-unsupported'});
  });

  it('names the offered assets this wallet does not carry', () => {
    const {refused} = selectPayableOffers(detailsOf(), WALLET_ASSETS, BEFORE_EXPIRY);
    // VEUR is an IC asset, so it is now refused for the provider reason BEFORE the wallet lookup is
    // reached — the same precedence Solana USDC has. USDT still exercises the not-carried branch.
    expect(refused).toContainEqual({method: 'Solana', asset: 'USDT', reason: 'asset-not-in-wallet'});
    // ckUSDC and ckETH are dpay assets the PROVIDER does not accept: they are simply absent from
    // its offers, so nothing about them appears on either side of this split.
    expect(refused.some(r => r.asset === 'ckUSDC' || r.asset === 'ckETH')).toBe(false);
  });

  it('refuses a settlement method this wallet has no rail for', () => {
    const details = detailsOf({
      transferAmounts: [
        {method: 'Lightning', available: true, assets: [{asset: 'BTC', amount: 0.000016}]},
        {method: 'Ethereum', available: true, assets: [{asset: 'USDC', amount: 1.13}]},
      ],
    });
    const {payable, refused} = selectPayableOffers(details, WALLET_ASSETS, BEFORE_EXPIRY);
    expect(payable).toEqual([]);
    expect(refused).toEqual([
      {method: 'Lightning', asset: 'BTC', reason: 'unknown-method'},
      {method: 'Ethereum', asset: 'USDC', reason: 'unknown-method'},
    ]);
  });

  it('refuses a method the provider itself marked unavailable, by name, instead of offering it', () => {
    // MEASURED: the live provider returns `available: false` for methods it currently cannot
    // service. Keeping such an offer payable hands the payer an asset whose failure surfaces only
    // at the destination call — after they chose it — and the wallet DOES carry both IC assets
    // here, so this refusal is the provider's statement, not a missing row.
    const details = detailsOf({
      transferAmounts: [
        {
          method: 'InternetComputer',
          available: false,
          assets: [{asset: 'ckBTC', amount: 0.000016}, {asset: 'VCHF', amount: 1}],
        },
        {method: 'Solana', available: true, assets: [{asset: 'SOL', amount: 0.006}]},
      ],
    });
    const {payable, refused} = selectPayableOffers(details, WALLET_ASSETS, BEFORE_EXPIRY);
    expect(payable).toEqual([
      {method: 'Solana', asset: 'SOL', amount: '0.006', assetId: 'solana:SOL', rawAmount: '6000000'},
    ]);
    expect(refused).toEqual([
      {method: 'InternetComputer', asset: 'ckBTC', reason: 'method-unavailable'},
      {method: 'InternetComputer', asset: 'VCHF', reason: 'method-unavailable'},
    ]);

    // A method this wallet has no rail for keeps THAT reason even when the provider also marks it
    // unavailable: "dpay can't pay this at all" is the permanent, truthful answer, and the live
    // provider marks exactly such methods (TaprootAsset, Spark, Arkade) unavailable on every read.
    const noRail = detailsOf({
      transferAmounts: [{method: 'Spark', available: false, assets: [{asset: 'BTC', amount: 0.000016}]}],
    });
    expect(selectPayableOffers(noRail, WALLET_ASSETS, BEFORE_EXPIRY).refused).toEqual([
      {method: 'Spark', asset: 'BTC', reason: 'unknown-method'},
    ]);
  });

  it('refuses an amount the asset cannot express, and a zero, instead of rounding either', () => {
    const details = detailsOf({
      transferAmounts: [
        {
          method: 'InternetComputer',
          available: true,
          assets: [{asset: 'ICP', amount: '0.000000001'}],
        },
        // The zero goes on the Solana rail: an IC asset other than native ICP never reaches the
        // amount check any more, because the provider cannot verify it (`provider-checks-icp-ledger`).
        {method: 'Solana', available: true, assets: [{asset: 'SOL', amount: 0}]},
      ],
    });
    const {payable, refused} = selectPayableOffers(details, WALLET_ASSETS, BEFORE_EXPIRY);
    expect(payable).toEqual([]);
    expect(refused).toEqual([
      {method: 'InternetComputer', asset: 'ICP', reason: 'bad-amount'},
      {method: 'Solana', asset: 'SOL', reason: 'bad-amount'},
    ]);
  });

  it('refuses every offer once the quote has expired, with the one reason that matters', () => {
    // The quote is the price; past its expiry nothing on the list can be taken, and the single
    // actionable instruction is to rescan the till.
    const details = detailsOf();
    const {payable, refused} = selectPayableOffers(details, WALLET_ASSETS, EXPIRES_AT_MS);
    expect(payable).toEqual([]);
    expect(refused).toHaveLength(7);
    expect(refused.every(r => r.reason === 'quote-expired')).toBe(true);
    // One millisecond earlier the same quote is still live.
    expect(selectPayableOffers(details, WALLET_ASSETS, EXPIRES_AT_MS - 1).payable).toHaveLength(2);
  });

  it('refuses a token two wallet rows both answer to, rather than guessing which was meant', () => {
    // A malformed catalog could ship two rows with the same ledger token on the same chain; paying
    // "one of them" would be paying an asset the payer never chose.
    // Native ICP, because it is the one IC asset that still reaches the wallet lookup at all.
    const icp = WALLET_ASSETS.find(a => a.id === 'ic:8');
    if (icp === undefined || icp.protocol !== 'ic') throw new Error('the bundled catalog must carry ICP');
    const twins: SelectableAsset[] = [icp, {...icp, id: 'ic:80', currency: 80}];
    const details = detailsOf({
      transferAmounts: [{method: 'InternetComputer', available: true, assets: [{asset: 'ICP', amount: 1}]}],
    });
    expect(selectPayableOffers(details, twins, BEFORE_EXPIRY)).toEqual({
      payable: [],
      refused: [{method: 'InternetComputer', asset: 'ICP', reason: 'ambiguous-asset'}],
    });
  });

  it('returns two empty lists when the till offers nothing, without inventing an option', () => {
    const details = detailsOf();
    expect(selectPayableOffers({...details, transferAmounts: []}, WALLET_ASSETS, BEFORE_EXPIRY)).toEqual({
      payable: [],
      refused: [],
    });
  });
});

