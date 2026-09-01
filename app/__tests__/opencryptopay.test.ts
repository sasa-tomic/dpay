import {describe, it, expect} from '@jest/globals';
import {
  decodeLnurl,
  parseOcpScan,
  parseIcpUri,
  parseSolanaUri,
  parsePaymentDetails,
  selectPayableOffers,
  type OcpDetails,
} from '../lib/opencryptopay';
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
    expect(parseSolanaUri(`solana:${SOL_ADDR}?label=Till`)).toEqual({ok: false, reason: 'bad-amount'});
  });

  it('refuses a URI belonging to another scheme', () => {
    expect(parseSolanaUri(ICP_URI)).toEqual({ok: false, reason: 'wrong-scheme'});
    expect(parseSolanaUri('')).toEqual({ok: false, reason: 'wrong-scheme'});
  });
});

describe('parsePaymentDetails', () => {
  it('narrows the till’s answer and derives the payment id from the callback', () => {
    const parsed = parsePaymentDetails(detailsBody());
    if (!parsed.ok) throw new Error(`expected a parse, got ${parsed.reason}`);
    const d = parsed.details;
    expect(d.paymentId).toBe('pl_beeddb41cd4b6d9e');
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

  it('refuses a body missing anything the payment depends on', () => {
    for (const body of [
      detailsBody({callback: undefined}),
      detailsBody({quote: undefined}),
      detailsBody({quote: {id: '', expiration: EXPIRATION}}),
      detailsBody({quote: {id: 'q', expiration: 'not a date'}}),
      detailsBody({quote: {id: 'q', expiration: 1788264000}}),
      detailsBody({requestedAmount: undefined}),
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
    expect(payable).toEqual([
      {method: 'InternetComputer', asset: 'ckBTC', amount: '0.000016', assetId: 'ic:1', rawAmount: '1600'},
      {method: 'InternetComputer', asset: 'VCHF', amount: '1', assetId: 'ic:7', rawAmount: '100000000'},
      {method: 'InternetComputer', asset: 'ICP', amount: '0.19', assetId: 'ic:8', rawAmount: '19000000'},
      {method: 'Solana', asset: 'SOL', amount: '0.006', assetId: 'solana:SOL', rawAmount: '6000000'},
    ]);
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
    expect(refused).toContainEqual({method: 'InternetComputer', asset: 'VEUR', reason: 'asset-not-in-wallet'});
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
          assets: [{asset: 'ICP', amount: '0.000000001'}, {asset: 'VCHF', amount: 0}],
        },
      ],
    });
    const {payable, refused} = selectPayableOffers(details, WALLET_ASSETS, BEFORE_EXPIRY);
    expect(payable).toEqual([]);
    expect(refused).toEqual([
      {method: 'InternetComputer', asset: 'ICP', reason: 'bad-amount'},
      {method: 'InternetComputer', asset: 'VCHF', reason: 'bad-amount'},
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
    expect(selectPayableOffers(details, WALLET_ASSETS, EXPIRES_AT_MS - 1).payable).toHaveLength(4);
  });

  it('refuses a token two wallet rows both answer to, rather than guessing which was meant', () => {
    // A malformed catalog could ship two rows with the same ledger token on the same chain; paying
    // "one of them" would be paying an asset the payer never chose.
    const vchf = WALLET_ASSETS.find(a => a.id === 'ic:7');
    if (vchf === undefined || vchf.protocol !== 'ic') throw new Error('the bundled catalog must carry VCHF');
    const twins: SelectableAsset[] = [vchf, {...vchf, id: 'ic:70', currency: 70}];
    const details = detailsOf({
      transferAmounts: [{method: 'InternetComputer', available: true, assets: [{asset: 'VCHF', amount: 1}]}],
    });
    expect(selectPayableOffers(details, twins, BEFORE_EXPIRY)).toEqual({
      payable: [],
      refused: [{method: 'InternetComputer', asset: 'VCHF', reason: 'ambiguous-asset'}],
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

