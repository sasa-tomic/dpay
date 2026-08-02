module.exports = {
  presets: ['module:@react-native/babel-preset'],
  env: {
    // Jest-only: transform the dynamic `import('./walletconnect')` isolation boundary in wallet.ts
    // into a CommonJS `require` (babel-jest outputs CJS and jest's VM does not support native
    // ESM dynamic import without --experimental-vm-modules). Scoped to `env.test` so Metro (RN)
    // and Vite (e2e) keep the NATIVE dynamic import — Metro code-splits it, Vite emits a separate
    // chunk that is never loaded on the web-first path. Activated automatically because jest sets
    // NODE_ENV=test; the RN/vite builds never set that env. (MC8 U6.2 WC isolation.)
    test: {
      plugins: ['@babel/plugin-transform-dynamic-import'],
    },
  },
};
