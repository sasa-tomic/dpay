// Trust Wallet fund-button support (2026-08-17 plan "Trust Wallet fund button").
//
// One-tap "fund my dpay wallet from Trust Wallet": the My-address surfaces deep-link Trust's
// SEND screen with the user's dpay deposit address pre-filled. The user reviews + confirms
// INSIDE Trust — dpay never sees a key, never quotes an amount, never converts (the no-swap
// non-negotiable). Research findings verified 2026-08-17 (Trust developer docs + the
// wallet-core registry cloned at third_party/wallet-core) — do NOT re-derive:
//
//   • Official send link: https://link.trustwallet.com/send?asset=<UAI>&address=<addr>
//     (the https form, NOT trust:// — when Trust is absent it routes to a download landing
//     instead of dead-tapping).
//   • Universal Asset Ids: BTC = c0 (coinId 0), SOL = c501 (coinId 501), SPL token =
//     c501_t<mint-base58>. NO testnet UAI ids exist in the registry → testnet rails keep the
//     copy/QR status quo (see isTrustWalletFundableBtc).
//   • Fire-and-forget: the send link gives NO return callback / no tx hash. Not a gap — the
//     existing deposit polling (BTC-family balance recheck; SOL balance poll) reconciles.
//   • The link's `data` param is NOT used (unreliable for calldata) — ckETH/ckUSDC deposits
//     stay on the WalletConnect path (dpay-built depositEth / approve+depositErc20 calldata).
//   • NO amount pre-fill, ever — dpay does not quote or imply conversion (no-swap).
import {isTestnetCurrency, type CurrencyDescriptor} from './config/catalog';

/** The dpay assets Trust's send screen can pre-fill: BTC + native SOL by fixed id, and ANY
 *  registered SPL token by mint (`SPL:<mint>` → Trust's `c501_t<mint>` id). Generic over the
 *  token registry — EURC (or any future token) needs no new entry here. */
export type TrustWalletAsset = 'BTC' | 'SOL' | `SPL:${string}`;

/** Trust Universal Asset Ids (wallet-core registry): BTC = c0 (coinId 0), SOL = c501 (coinId 501),
 *  SPL token = c501_t<mint-base58>. The SPL id embeds the CALLER's mint (the asset row's own
 *  truth) — never a second copy of any mint string here. */
function trustUai(asset: TrustWalletAsset): string {
  if (asset === 'BTC') return 'c0';
  if (asset === 'SOL') return 'c501';
  return `c501_t${asset.slice('SPL:'.length)}`;
}

/** Build Trust Wallet's send deep link for an asset + destination address. Pure + total. */
export function trustWalletSendUrl(asset: TrustWalletAsset, address: string): string {
  return `https://link.trustwallet.com/send?asset=${trustUai(asset)}&address=${encodeURIComponent(address)}`;
}

/**
 * IC-rail eligibility: ONLY mainnet CkBtcUtxo. A plain transfer to the ckBTC-minter-derived
 * address is exactly what Trust's send screen does — no calldata needed. Everything else stays
 * off the Trust path: CkEthErc20 (ckETH/ckUSDC) needs dpay-built calldata (WalletConnect owns
 * it), and testnet ckBTC has no Trust UAI id (copy/QR status quo). Fail-closed on null.
 */
export function isTrustWalletFundableBtc(desc: CurrencyDescriptor | null): boolean {
  return desc != null && desc.minter_family === 'CkBtcUtxo' && !isTestnetCurrency(desc);
}
