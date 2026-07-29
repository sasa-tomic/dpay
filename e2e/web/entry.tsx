// Web entry — mounts the REAL `app/App.tsx` (unmodified) via react-dom. The native shims (`shims.ts`)
// are imported FIRST as a side-effect import, so by the time App.tsx evaluates
//   const {DpayCore, DpayNfc} = NativeModules
// the shims have already installed those onto react-native-web's `NativeModules` singleton.
//
// The relay URL the app boots against comes from `?relay=` (set by the harness when it serves the
// page) — see `relay-config.ts`, which `vite.config.js` aliases App.tsx's `./relayConfig` import to.
import './shims';
// React + react-dom must come from e2e/node_modules (single copy); `resolve.dedupe` in the vite
// config enforces one copy across the whole graph (so react-native-web uses the same React).
import React from 'react';
import { createRoot } from 'react-dom/client';
// The REAL app. Untouched — every TS path runs verbatim (payments.ts, the wallet state machine, the
// fetch calls to the relay). Only the I/O boundary (DpayCore signing, camera scan, NFC seam,
// clipboard/Share) is shimmed, by `shims.ts`.
import App from '../../app/App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('e2e entry: #root not found in index.html');
createRoot(rootEl).render(React.createElement(App));
