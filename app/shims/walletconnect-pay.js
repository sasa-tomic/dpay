// NOTE: build-time Metro satisfier for `@walletconnect/pay` (the Hermes boot-crash fix, round 2).
//
// `@reown/walletkit@1.6.0` statically imports `{WalletConnectPay}` from `@walletconnect/pay`
// (dep pinned `1.1.0`). That package's dist evaluates wasm-bindgen glue at MODULE SCOPE:
// `new TextDecoder('utf-8', {ignoreBOM: true, fatal: true})` followed by a bare `.decode()`.
// Hermes's built-in TextDecoder refuses the `fatal` option at construction (round-1 crash:
// "the 'fatal' option is unsupported"), and with the options shim in place its bare
// `decode(undefined)` still read `.buffer` of the argument (round-2 crash: "Cannot read
// property 'buffer' of undefined"). Module-scope evaluation cannot be caught by app code, so
// either form kills the app during the WalletKit import.
//
// This stub removes the defective module from the bundle entirely. Across walletkit's whole
// dist, `WalletConnectPay` is referenced exactly ONCE: `S.isAvailable() && (this.pay = new S(...))`
// inside the pay-feature init. dpay does not use WalletConnect Pay, so `isAvailable()` answering
// false makes walletkit skip that branch and every dpay-used surface (pairing, sessions, requests)
// is untouched. The defective dist never evaluates, so the crash is structurally impossible and
// the bundle shrinks by the pay module.
//
// Runtime safety: if a future walletkit changes the call shape and reaches the constructor, it
// throws a clear error instead of silently misbehaving.
//
// Retire this shim only when @reown/walletkit (or @walletconnect/pay) ships a Hermes-compatible
// pay module AND dpay has a reason to ship WC Pay — otherwise keep it; upstream's dist is the
// defect, this is the removal.
'use strict';

class WalletConnectPay {
  static isAvailable() {
    return false;
  }

  constructor() {
    throw new Error(
      'walletconnect-pay stub: WalletConnect Pay is intentionally unavailable in dpay (Hermes-incompatible upstream dist); this constructor is unreachable while isAvailable() answers false',
    );
  }
}

module.exports = {WalletConnectPay};
