/** Hermes TextDecoder options tolerance — the boot guard for the WalletConnect import chain.
 *
 *  `@reown/walletkit` hard-imports `@walletconnect/pay`, whose module scope constructs
 *  `new TextDecoder('utf-8', {ignoreBOM: true, fatal: true})` (wasm-bindgen glue, then calls
 *  `decode()` immediately). Hermes's built-in TextDecoder rejects the `fatal` option at
 *  construction, so the import itself threw before any UI and the app crashed on start
 *  (JavascriptException: Failed to construct 'TextDecoder': the 'fatal' option is unsupported).
 *
 *  This module installs an options-tolerant wrapper BEFORE any `@walletconnect/*`/`@reown/*`
 *  module evaluates — it must stay the FIRST import of `walletkit.ts` (before the RN compat
 *  import, whose polyfills assume a working global).
 *
 *  Semantics: the wrapper accepts and DROPS `fatal`/`ignoreBOM` (Hermes only ever decodes
 *  utf-8 non-fatal) and forwards the label. Feature-detected: on runtimes whose TextDecoder
 *  already accepts options (Node/jest, browsers, and `fast-text-encoding`'s polyfill on
 *  devices where the global was absent) this is a no-op, so nothing else changes behavior.
 *
 *  Idempotent in effect (re-installing just re-wraps harmlessly); zero deps; no react-native
 *  import, so it also loads under jest and web. */

type DecodeInput = ArrayBufferView | ArrayBuffer;

export type TextDecoderInstall = 'wrapped' | 'not-needed' | 'absent';

/** The minimal surface the WalletConnect glue (and every other caller here) uses. */
interface TextDecoderLike {
  decode(input?: DecodeInput): string;
}

/** Wrap a TextDecoder base that refuses constructor options with one that tolerates them.
 *  Exported for tests; the production entry point is `installTextDecoderOptionsShim`. */
export function wrapRestrictedTextDecoder(
  base: new (label?: string) => TextDecoderLike,
): new (label?: string, options?: {fatal?: boolean; ignoreBOM?: boolean}) => TextDecoderLike & {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
} {
  class OptionsTolerantTextDecoder {
    private readonly inner: TextDecoderLike;

    constructor(label?: string, _options?: {fatal?: boolean; ignoreBOM?: boolean}) {
      // The label itself is fine on every known engine; only the options object throws.
      this.inner = new base(label ?? 'utf-8');
    }

    decode(input?: DecodeInput): string {
      // `stream` decoding is not part of any call site here (the WC glue decodes whole
      // wasm-memory slices); not forwarded, matching Hermes's own option-poor surface.
      return this.inner.decode(input);
    }

    get encoding(): string {
      return 'utf-8';
    }

    get fatal(): boolean {
      return false;
    }

    get ignoreBOM(): boolean {
      return false;
    }
  }

  return OptionsTolerantTextDecoder;
}

/** Feature-detect and install. Returns what happened, for tests and startup logs. */
export function installTextDecoderOptionsShim(): TextDecoderInstall {
  const scope = globalThis as unknown as {TextDecoder?: unknown};
  const Native = scope.TextDecoder;
  if (typeof Native !== 'function') return 'absent';
  try {
    // The exact construction the pay module performs at import time.
    const probe = new (Native as new (
      label?: string,
      options?: {fatal?: boolean; ignoreBOM?: boolean},
    ) => TextDecoderLike)('utf-8', {fatal: true, ignoreBOM: true});
    probe.decode();
    return 'not-needed';
  } catch {
    scope.TextDecoder = wrapRestrictedTextDecoder(Native as new (label?: string) => TextDecoderLike);
    return 'wrapped';
  }
}

const installed = installTextDecoderOptionsShim();
// Referenced so `noUnusedLocals` keeps its lint hands off while the side effect does the work.
void installed;
