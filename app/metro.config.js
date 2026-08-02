const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * Resolver alias: `@walletconnect/ethereum-provider@2.23.10` STATICALLY references
 * `@reown/appkit/core` (the built-in QR modal). The installed `@reown/appkit@1.8.19`
 * does not export that subpath and is web-only (lit, DOM APIs) — it cannot bundle under
 * Metro/RN. We redirect the import to a local stub (`shims/reown-appkit-core.js`) so
 * `createBundleReleaseJsAndAssets` succeeds. The stub is RUNTIME-DEAD code: with the MC8 U6
 * capstone, `walletconnect.ts` sets `showQrModal:false` and renders the pairing URI itself via
 * a custom <QRCode> (display_uri event). ethereum-provider only dynamic-imports the modal when
 * showQrModal is true, so the stub's `createAppKit()` is never called at runtime. See the shim's
 * FIXME for retirement conditions.
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
