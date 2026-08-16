// Typed jest stub for vite `?url` asset imports (moduleNameMapper `\\?url$`, wired in
// jest.config.js). Only the wasm-core shim (`e2e/web/dpay-core-wasm.ts`) imports a `?url` asset
// today; under jest the vite asset transform never runs, so the specifier resolves here instead.
// Mirrors vite's semantics: the default export is the URL the asset would be served at.
export default '/dpay-core.wasm';
