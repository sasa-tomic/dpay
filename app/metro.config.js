const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * Resolver alias: `@walletconnect/ethereum-provider@2.23.10` dynamically imports
 * `@reown/appkit/core` for its built-in QR modal. The installed `@reown/appkit@1.8.19`
 * does not export that subpath and is web-only (lit, DOM APIs) — it cannot bundle under
 * Metro/RN. We redirect the import to a local stub (`shims/reown-appkit-core.js`) so
 * `createBundleReleaseJsAndAssets` succeeds. The stub is dead code at runtime: the WC
 * onramp is gated behind a non-empty `WALLETCONNECT_PROJECT_ID` (defaults to empty).
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      if (moduleName === '@reown/appkit/core') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(__dirname, 'shims/reown-appkit-core.js'),
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
