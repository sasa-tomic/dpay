/**
 * Metro shim for `@reown/appkit/core`.
 *
 * `@walletconnect/ethereum-provider@2.23.10` dynamically imports `@reown/appkit/core`
 * for its built-in QR modal (`showQrModal: true`). The installed `@reown/appkit@1.8.19`
 * does not export that subpath and is web-only (lit, DOM APIs) — it cannot bundle under
 * Metro/RN. This stub satisfies the Metro resolver so `createBundleReleaseJsAndAssets`
 * succeeds.
 *
 * Runtime safety: dpay's WalletConnect onramp (`walletconnect.ts`) is gated behind a
 * non-empty `WALLETCONNECT_PROJECT_ID` (defaults to empty = disabled). The dynamic
 * import that reaches this stub is only evaluated inside `EthereumProvider.init()` when
 * `showQrModal` is true, which itself is only called when the onramp is enabled. Until a
 * proper `@walletconnect/modal-react-native` modal integration replaces the built-in
 * `@reown/appkit` modal path, this stub is dead code at runtime.
 *
 * If reached, it throws with a clear message rather than silently returning undefined.
 */

module.exports = {
  createAppKit() {
    throw new Error(
      'dpay: @reown/appkit QR modal is not available in this build. ' +
        'Configure @walletconnect/modal-react-native or set showQrModal:false.',
    );
  },
};
