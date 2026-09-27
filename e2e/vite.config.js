// vite config for the e2e web build of the REAL app/App.tsx via react-native-web.
//
// This is `ui/vite.config.js` VERBATIM in spirit (RNW alias/extension/esbuild-jsx config) plus the
// extra aliases the real App.tsx needs: react-native-svg/qrcode-svg/vision-camera/async-storage ->
// thin shims, and `./relayConfig` (imported by App.tsx) -> our runtime override so the harness can
// point the app at the local test relay (or the live one) without touching App.tsx.
//
// Two important deviations from ui/vite.config.js:
//   - `react-native` is aliased with a REGEX anchored to ^react-native$ so it matches ONLY the bare
//     specifier (NOT `react-native-svg`, `react-native-vision-camera`, etc.). ui/vite.config.js's
//     plain-string alias works there only because ui/src/App.jsx doesn't import those packages; the
//     REAL app does, and a prefix-match would rewrite them to non-existent `react-native-web-*`.
//   - All alias targets are ABSOLUTE PATHS resolved from `e2e/node_modules` at config load time
//     (createRequire). Node's resolution from `app/App.tsx` can't find `react-native-web` (it lives
//     in `e2e/node_modules`, not `app/node_modules`), so we resolve once here and hand the build a
//     path it can load from anywhere.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WEB = join(__dirname, 'web');

// Resolve once from this package's location (finds `e2e/node_modules/*`). IMPORTANT: pin the ESM
// `module` entry of react-native-web (NOT the CJS `main` that `require.resolve` returns). shims.ts
// does `import {NativeModules} from 'react-native-web'` (bare specifier) which vite resolves via
// the package.json `module` field → dist/index.js. If our alias points App.tsx's `react-native`
// import at the CJS main, vite ends up with TWO react-native-web instances and the shims' mutation
// of `NativeModules` lands on a different instance than the one the app reads → DpayCore undefined.
const require = createRequire(import.meta.url);
// Walk up from the CJS main (dist/cjs/index.js) to the package root, then down to the ESM entry.
const RN_WEB_CJS = require.resolve('react-native-web');              // .../react-native-web/dist/cjs/index.js
const RN_WEB_ROOT = dirname(dirname(dirname(RN_WEB_CJS)));            // .../react-native-web/
const RN_WEB = join(RN_WEB_ROOT, 'dist', 'index.js');                // the ESM `module` entry
const REACT = require.resolve('react');
const REACT_DOM = require.resolve('react-dom');
// `qrcode` + `react-native-svg` live only in app/node_modules (transitive deps the real app uses);
// resolve them from there once at config load so our shims can import them without second installs.
// IMPORTANT: resolve the ESM `module` entry (not the CJS `main`) — vite needs ESM for tree-shaking
// and for react-native-svg's `.web.js` extension precedence to kick in (the web build of the SVG
// elements). Pointing at `main` (CJS) breaks the default export of `Svg` and produces React #130.
const requireFromApp = createRequire(join(REPO_ROOT, 'app', 'package.json'));
const QRCODE = requireFromApp.resolve('qrcode');
const RN_SVG_DIR = join(REPO_ROOT, 'app', 'node_modules', 'react-native-svg');
const RN_SVG = join(RN_SVG_DIR, 'lib', 'module', 'index.js');

// react-native-web gotchas (mirrors ui/vite.config.js):
// - alias bare `react-native` -> `react-native-web`
// - prefer `.web.*` extensions so any *.web.tsx overrides win
// - some RN/RNW deps ship untranspiled JSX in .js files -> tell esbuild to treat .js as jsx
// - define the globals RN code expects (global, __DEV__, process.env.NODE_ENV)
// - deterministic output filenames (no content hash) so screenshots/goldens are stable
const rnExtensions = [
  '.web.tsx', '.tsx',
  '.web.ts', '.ts',
  '.web.jsx', '.jsx',
  '.web.js', '.js',
  '.json',
];

// The app icon the web manifest points at: the SAME PNG the APK's launcher uses. Read from the
// Android res tree at build time rather than copied into e2e/web, so the project has ONE icon.
const ICON_SRC = join(REPO_ROOT, 'app/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png');

// Extensions worth precompressing. WOFF2 is brotli INSIDE the container and PNG is already
// deflated — re-compressing either spends bytes rather than saving them, and the relay would then
// have to decide which of two encodings to serve. wasm/js/html/json compress 3–4× (measured:
// wallet.js 1_386_466 → 327_616, dpay-core.wasm 393_133 → 119_439).
const COMPRESSIBLE = new Set(['.js', '.mjs', '.html', '.css', '.wasm', '.json', '.webmanifest', '.svg', '.txt']);

/**
 * web-prod only. Emits the PWA surface OPEN_ISSUES X10 is about — `/manifest.webmanifest`,
 * `/icon-192.png` and `/sw.js` — then brotli-precompresses every compressible dist file into a
 * `.br` sibling that `crates/dpay-relay/build.rs` pairs with its origin file.
 *
 * The service worker's whole policy is in `e2e/web/sw.js`; this plugin only fills in the two
 * things a template cannot know: the exact precache list (every emitted asset, so a lazily
 * imported chunk is available offline too) and a VERSION that is a hash over the CONTENT of all
 * of them, which is what makes the update path deterministic.
 */
function dpayWebProdAssets() {
  const digest = (buf) => createHash('sha256').update(buf).digest('hex');
  return {
    name: 'dpay-web-prod-assets',
    apply: 'build',
    // AFTER vite's own html plugin: `wallet.html` only enters the bundle in that plugin's
    // generateBundle, and the shell document is the one file the precache cannot be built without.
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const icon = readFileSync(ICON_SRC);
      const manifest = JSON.stringify(
        {
          name: 'dpay · Wallet',
          short_name: 'dpay',
          description:
            'dpay web wallet — the same app, in your browser. Non-custodial: your key never leaves this device.',
          start_url: '/wallet',
          scope: '/wallet',
          display: 'standalone',
          background_color: '#EBF0ED',
          theme_color: '#EBF0ED',
          icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }],
        },
        null,
        2,
      );
      // Emitted AFTER their bytes are folded into the precache list below: rolldown does not make
      // a file emitted from this hook visible in `bundle` during the same hook, so reading them
      // back would silently leave them out of both the precache and the version.
      this.emitFile({ type: 'asset', fileName: 'icon-192.png', source: icon });
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });

      // Precache = the shell document + every emitted asset (lazy chunks included, so Transactions
      // and the SOL rail open offline too) + the two root files above. Served paths, not dist
      // paths: `wallet.html` is what the relay answers `/wallet` with, and `/sw.js` is never
      // cached by the worker that IS it.
      const bytesOf = (f) => Buffer.from(f.type === 'chunk' ? f.code : f.source);
      const shell = [
        ['/wallet', bytesOf(bundle['wallet.html'])],
        ['/icon-192.png', icon],
        ['/manifest.webmanifest', Buffer.from(manifest)],
        ...Object.keys(bundle)
          .filter((f) => f !== 'wallet.html')
          .map((f) => [`/${f}`, bytesOf(bundle[f])]),
      ].sort(([a], [b]) => (a < b ? -1 : 1));
      const precache = shell.map(([p]) => p);
      const parts = shell.map(([p, bytes]) => `${p}:${digest(bytes)}`);
      const version = digest(Buffer.from(parts.join('\n'))).slice(0, 16);
      const template = readFileSync(join(WEB, 'sw.js'), 'utf8');
      const source = template
        .replace('__DPAY_SW_VERSION__', version)
        .replace('__DPAY_SW_PRECACHE__', JSON.stringify(precache, null, 2));
      if (source.includes('__DPAY_SW_')) {
        throw new Error('sw.js template placeholders were not both substituted');
      }
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
    // After rollup has written the dist: brotli the compressible files at max quality. Build-time
    // cost (~5s, once) instead of per-request CPU, and the relay ships the bytes verbatim.
    writeBundle(opts) {
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (COMPRESSIBLE.has(name.slice(name.lastIndexOf('.')))) {
            const raw = readFileSync(p);
            writeFileSync(
              `${p}.br`,
              brotliCompressSync(raw, {
                params: {
                  [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
                  [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
                },
              }),
            );
          }
        }
      };
      walk(opts.dir);
    },
  };
}

// The ONE divergent shim between the two builds: the e2e harness uses the inject-only camera
// (window.__DPAY_TEST_SCAN) because headless chrome has no lens to point at a printed QR; the
// web-prod build (/wallet) uses the REAL getUserMedia + jsQR camera. Everything else — including
// the money-critical wasm DpayCore — is the SAME code in both builds.
export default defineConfig(({ mode }) => {
  const webProd = mode === 'web-prod'; // `vite build --mode web-prod` → the dist the relay embeds
  const camera = webProd ? join(WEB, 'camera-real.tsx') : join(WEB, 'camera.ts');
  return {
    root: WEB,
    // The PWA surface + brotli precompression exist ONLY in the shipped build; the e2e dist is
    // served by sirv to a fresh browser context per flow and ships nowhere.
    plugins: webProd ? [react(), dpayWebProdAssets()] : [react()],
    // Resolve the real app from the repo root (vite root is e2e/web; App.tsx lives at app/App.tsx).
    resolve: {
      alias: [
        // EXACT bare-specifier match (regex-anchored) so `react-native-svg` etc. are NOT rewritten.
        // Absolute path so node resolution doesn't need a react-native-web copy in app/node_modules.
        { find: /^react-native$/, replacement: RN_WEB },

        // Force a single copy of react/react-dom across the graph (app/node_modules + e2e/node_modules
        // both have copies; react-native-web + react-dom must share the same React instance).
        { find: /^react$/, replacement: REACT },
        { find: /^react-dom$/, replacement: REACT_DOM },

        // The real App.tsx does `import {RELAY_DEFAULT} from './relayConfig'`. Intercept that import
        // and replace it with our web override module (reads ?relay= / window.__DPAY_RELAY / a
        // mode-aware default: same-origin for web-prod, 127.0.0.1:8787 for e2e).
        // Anchored regex so it matches the literal `./relayConfig` and `../relayConfig` only.
        { find: /^\.\.?\/relayConfig$/, replacement: join(WEB, 'relay-config.ts') },

        // react-native-qrcode-svg ships only `src/index.js` with JSX-in-.js; rolldown's parser rejects
        // it without a JSX hint. Replace it with our `.tsx` shim (same matrix→SVG path, same surface).
        { find: /^react-native-qrcode-svg$/, replacement: join(WEB, 'qrcode.tsx') },
        // The qrcode lib lives in app/node_modules; expose its absolute path so our shim resolves it
        // without needing a second install in e2e/node_modules.
        { find: /^qrcode$/, replacement: QRCODE },
        // react-native-svg lives in app/node_modules too. Absolute path so both the real App.tsx and
        // our qrcode.tsx shim resolve to the SAME copy (its `.web.js` build is what we want here; the
        // extension precedence picks it up automatically once the package is found).
        { find: /^react-native-svg$/, replacement: RN_SVG },

        // Native packages App.tsx imports that have no real web build usable by the harness. Each
        // shim lives under e2e/web/ and is the smallest boundary (camera — see the note above —
        // NFC seam noop, wasm DpayCore over crates/dpay-relay/assets/dpay-core.wasm).
        { find: /^react-native-vision-camera$/, replacement: camera },

        // MC8 U6.2 — WalletConnect isolation. wallet.ts's resolveOnrampProvider() is web-first and
        // only dynamic-imports ./walletconnect on native, so the WC branch is unreachable in this
        // build (Platform.OS === 'web' under react-native-web + no projectId). Alias BOTH WC
        // specifiers (the static `EthereumProvider` import + the side-effect `react-native-compat`
        // import inside walletconnect.ts) to a single noop shim so the bundle never executes real WC
        // code nor pulls its heavy dep tree. Mirrors the react-native-vision-camera alias above.
        { find: /^@walletconnect\/ethereum-provider$/, replacement: join(WEB, 'walletconnect-provider.ts') },
        { find: /^@walletconnect\/react-native-compat$/, replacement: join(WEB, 'walletconnect-provider.ts') },

        // qrcode-svg pokes `global.TextEncoder = require('text-encoding').TextEncoder` at the top of
        // its index. The `text-encoding` polyfill package is in app/node_modules and resolves via node
        // walk-up; alias it to a tiny shim that re-uses the BROWSER's native TextEncoder so we don't
        // accidentally ship a polyfill that overwrites a working native global. (text-encoding is also
        // missing from many thin caches; the alias removes a hidden dep.)
        { find: /^text-encoding$/, replacement: join(WEB, 'text-encoding.ts') },
      ],
      extensions: rnExtensions,
      // Belt-and-braces: even if a future alias misses, never pull in a second React.
      dedupe: ['react', 'react-dom', 'react-native-web'],
    },
    define: {
      global: 'window',
      __DEV__: webProd ? 'false' : 'true', // e2e keeps React's dev build for actionable error
                                     // messages; web-prod ships the minified production build.
      'process.env.NODE_ENV': webProd ? '"production"' : '"development"',
    },
    optimizeDeps: {
      // Do NOT pre-bundle react-native-web — pre-bundling creates a separate module instance from
      // the source-resolved one, which breaks the shims' mutation of `NativeModules` (the app reads a
      // different instance than the shims mutated → DpayCore is undefined → DPAY_SELFCHECK FAIL).
      // Letting vite resolve react-native-web naturally (no optimizeDeps pre-bundle) keeps a single
      // instance shared between shims.ts and app/App.tsx.
      include: ['@noble/ed25519', '@noble/hashes', 'qrcode'],
      exclude: ['react-native-web'],
      // NOTE: Vite 8 optimizes deps with Rolldown and prints a one-time deprecation notice for
      // `esbuildOptions` (mirrored from ui/vite.config.js). It is honored and harmless — kept here so
      // RN-ecosystem deps that ship raw JSX in .js files still prebundle.
      esbuildOptions: {
        loader: { '.js': 'jsx' },
        resolveExtensions: rnExtensions,
        jsx: 'automatic',
      },
    },
    build: {
      // e2e: outDir e2e/dist (the harness's `serveWeb` finds it there); web-prod: e2e/dist-prod
      // (the dist `just web` builds and the relay's build.rs embeds — gitignored, built at deploy
      // or test time, never committed).
      outDir: webProd ? join(__dirname, 'dist-prod') : join(__dirname, 'dist'),
      emptyOutDir: true,
      assetsInlineLimit: 0,
      // e2e keeps minification OFF so React/dev errors carry actionable stack traces and the word
      // 'balance' etc. stay searchable in the bundle. web-prod minifies with Vite 8's built-in
      // 'oxc' minifier (rolldown — no esbuild/terser package needed, which matters offline).
      minify: webProd ? 'oxc' : false,
      rollupOptions: webProd ? {
        // The prod page: e2e/web/wallet.html → dist-prod/wallet.html (served by the relay at
        // /wallet). Its hashed assets land in dist-prod/assets/ (served at /assets/<name> with
        // immutable caching — the relay's build.rs-generated asset table drives the headers).
        input: { wallet: join(WEB, 'wallet.html') },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      } : {
        // e2e: deterministic output filenames (no content hash) so screenshots/goldens are stable,
        // and the root index.html is the entry by default.
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name].js',
          assetFileNames: 'assets/[name][extname]',
        },
      },
    },
    server: { fs: { allow: [REPO_ROOT] } },
  };
});
