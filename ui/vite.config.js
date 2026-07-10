import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// react-native-web gotchas, all in one place:
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

export default defineConfig({
  plugins: [react()],
  define: {
    global: 'window',
    __DEV__: 'false',
    'process.env.NODE_ENV': '"production"',
  },
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    extensions: rnExtensions,
  },
  optimizeDeps: {
    include: ['react-native-web'],
    // NOTE: Vite 8 optimizes deps with Rolldown and prints a one-time deprecation
    // notice for `esbuildOptions` (it prefers `rolldownOptions`). It is honored and
    // harmless — kept here so RN-ecosystem deps that ship raw JSX in .js files still
    // prebundle. react-native-web@0.21 dist is precompiled, so this is belt-and-braces.
    esbuildOptions: {
      loader: { '.js': 'jsx' },
      resolveExtensions: rnExtensions,
      jsx: 'automatic',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
