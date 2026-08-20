// NOTE: closed-by-design, build-time-only Metro satisfier for `@reown/appkit/core` (MC8 U6 capstone).
//
// `@walletconnect/ethereum-provider@2.23.10` STATICALLY references `@reown/appkit/core` (the built-in
// QR modal). The installed `@reown/appkit@1.8.19` has no `./core` export subpath and is web-only
// (lit + DOM APIs that cannot bundle under Metro/RN). This stub satisfies the Metro resolver so
// `createBundleReleaseJsAndAssets` succeeds — WITHOUT it the release bundle fails with
// `Unable to resolve module @reown/appkit/core`.
//
// Runtime safety: this stub is RUNTIME-UNREACHABLE while `app/walletconnect.ts` sets
// `showQrModal: false`. ethereum-provider only dynamic-imports the modal code path when showQrModal
// is true; with showQrModal:false that path is never evaluated, so `createAppKit()` is never called.
// dpay renders the pairing URI itself via a custom `<QRCode>` (the display_uri event → on-brand QR),
// completely bypassing the appkit modal. If reached anyway, this stub throws with a clear message
// rather than silently returning undefined.
//
// Closed by design: dpay deliberately keeps showQrModal:false (its own pairing QR is the product
// surface). Revisit only if ethereum-provider drops the static `@reown/appkit/core` reference OR
// dpay pins a version that doesn't import it — removing the shim WITHOUT that would re-break
// release bundling.

module.exports = {
  createAppKit() {
    throw new Error(
      'dpay: @reown/appkit QR modal is not available in this build. ' +
        'This path is runtime-dead under showQrModal:false (MC8 U6 capstone). ' +
        'If you see this, showQrModal was set back to true without a real modal integration.',
    );
  },
};
