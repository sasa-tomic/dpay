//! ckERC-20 / ckETH / ckBTC / ckUSDC constants and the pure onramp resolver
//! (`ckerc20_onramp_from_descriptor`). Single-sourced verified values shared by the
//! [`FakeLedger`](super::fake::FakeLedger) catalog and the `AgentLedger`.

use serde::Serialize;

use super::types::{CurrencyDescriptor, LedgerError, MinterFamily};

/// Verified constants for the ckUSDC onramp (ckERC-20 family). ckUSDC has NO per-principal IC deposit
/// address and NO user-callable mint — the user performs two Ethereum transactions from their own
/// wallet (approve + depositErc20); the relay only surfaces these so the app can build the calldata
/// (see OPEN_ISSUES.md O6 + `app/cketh.ts`). In production these are read at runtime from the ckETH
/// minter's `get_minter_info`; the constants below are the authoritative values
/// (verified 2026-07-31 — do not re-derive). Single-sourced here so the FakeLedger + AgentLedger
/// impls can't drift from the verified addresses.
///
/// The `helper_address` is NETWORK-scoped, not minter-scoped: Ethereum mainnet and Sepolia testnet
/// each deploy their own CkDeposit helper contract under the same ckETH minter. The chain-id gate in
/// [`ckerc20_onramp_from_descriptor`] selects the right one from the descriptor's `chain_id`. The
/// drift-free source for either value is the minter's
/// `get_minter_info.deposit_with_subaccount_helper_contract_address` (OPEN_ISSUES #1/#2 testnet
/// wiring). `CKUSDC_ERC20_ADDRESS` is the token contract (USDC), NOT the helper — kept separate so a
/// per-token descriptor's `token_contract` stays the source of truth for the ERC-20 address.
pub(crate) const CKERC20_HELPER_ADDRESS_MAINNET: &str =
    "0x18901044688D3756C35Ed2b36D93e6a5B8e00E68";
pub(crate) const CKERC20_HELPER_ADDRESS_SEPOLIA: &str =
    "0x2D39863d30716aaf2B7fFFd85Dd03Dda2BFC2E38";
pub(crate) const CKUSDC_ERC20_ADDRESS: &str =
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

/// The ckETH LEDGER principal (mainnet) — the gas ledger a ckERC20 `withdraw_erc20` burns ckETH gas
/// fees from (the amount comes from the ckERC20 amount ledger). Verified against the IC mainnet
/// ckETH ledger `ss2fx-dyaaa-aaaar-qacoq-cai` (2026-08-06). Single-sourced here so the FakeLedger
/// catalog's per-ckERC20 `gas_ledger` field can't drift from the real value the AgentLedger reads at
/// runtime from the facade's `currencies()` query. `None` for non-ckERC20 families (BTC / native ETH /
/// DEMO): native ckETH's gas ledger IS its own `ledger` (the `withdraw_eth` path), so it carries no
/// separate `gas_ledger`.
pub(crate) const CKETH_LEDGER_PRINCIPAL: &str = "ss2fx-dyaaa-aaaar-qacoq-cai";

/// The ckBTC MINTER principal (mainnet) — `mqygn-kiaaa-aaaar-qaadq-cai`, the live chain-key Bitcoin
/// minter whose `retrieve_btc_with_approval` burns ckBTC → sends native BTC, and whose
/// `retrieve_btc_min_amount` (= 50_000) backs [`RETRIEVE_BTC_MIN_AMOUNT`] above. Single-sourced here
/// so the FakeLedger catalog's ckBTC `minter` field can't drift from the verified value; the same
/// literal is the drift-prone value cross-checked against `dfx/catalog_truth.json` (see the
/// `catalog_truth_tests` module below). Verified 2026-08-06.
pub(crate) const CKBTC_MINTER_PRINCIPAL: &str = "mqygn-kiaaa-aaaar-qaadq-cai";

/// The ckETH MINTER principal (mainnet) — `sv3dd-oaaaa-aaaar-qacoa-cai`, the live ckETH minter that
/// handles native ETH (`withdraw_eth`) AND every ckERC20 token (`withdraw_erc20`). Shared by all
/// ckERC20 catalog entries (ckUSDC/ckUSDT/ckDAI) + the native-ckETH entry, so it is referenced 5× in
/// [`fake_catalog`] — single-sourced here so the copies can't drift. Cross-checked against
/// `dfx/catalog_truth.json`. Verified 2026-08-06.
pub(crate) const CKETH_MINTER_PRINCIPAL: &str = "sv3dd-oaaaa-aaaar-qacoa-cai";

/// The ckUSDC LEDGER principal (mainnet) — `xevnm-gaaaa-aaaar-qafnq-cai`, the live ckUSDC ICRC-1
/// ledger. Reused as the demo ledger stand-in for the OTHER ckERC20 catalog entries (ckUSDT/ckDAI/
/// native-ckETH) since the offline FakeLedger has no per-token ledger — referenced 4× in
/// [`fake_catalog`], single-sourced here so the copies can't drift. Cross-checked against
/// `dfx/catalog_truth.json`. Verified 2026-08-06.
pub(crate) const CKUSDC_LEDGER_PRINCIPAL: &str = "xevnm-gaaaa-aaaar-qafnq-cai";

/// Onramp parameters for a CkEthErc20-family currency (ckUSDC etc. OR native ckETH). The app builds
/// the user's Ethereum transaction(s) from these; the user signs in their own wallet (non-custodial).
/// The deposit `principal` arg is the USER's own IC principal (derived in-app from their key); the
/// subaccount is omitted (ICRC-1 default). In production these come from the ckETH minter's
/// `get_minter_info`; the offline FakeLedger returns the verified mainnet constants.
///
/// `kind` discriminates the two deposit shapes sharing the CkEthErc20 family + the SAME helper:
///  - `"erc20"`: two txs (approve the ERC-20, then `depositErc20`) — `erc20_address` is `Some`.
///  - `"native_eth"`: ONE payable tx (`depositEth`) carrying the ETH `value` — `erc20_address` is
///    `None` (the descriptor's `token_contract` is null). The discriminator within the family is the
///    descriptor's `token_contract`, surfaced here so the app need not re-derive it.
#[derive(Serialize)]
pub struct CkErc20OnrampParams {
    pub helper_address: String,             // the CkDeposit helper contract (0x…) — shared by both kinds
    pub erc20_address: Option<String>,      // Some(addr) for erc20; None for native_eth
    pub kind: String,                       // "erc20" | "native_eth"
}

/// Resolve ckERC-20 / native-ETH onramp params from a catalog descriptor (MC8 U2). PURE +
/// single-sourced — both the FakeLedger and AgentLedger `ckerc20_onramp_params` impls delegate here so
/// the fail-closed gate is identical across the offline demo + the live canister paths.
///
/// **Gate (fail-closed — non-custodial / no-swap honesty):** returns `Err(Transient)` (→ HTTP 503)
/// unless ALL of:
/// 1. `desc` is `Some` (the currency exists in the catalog), AND
/// 2. `desc.minter_family == Some(CkEthErc20)` (it is a CkEthErc20-family currency).
///
/// Within the family, `token_contract` discriminates the two deposit shapes:
///  - `Some(addr)` ⇒ `"erc20"`: a known ERC-20 token (ckUSDC). Two txs (approve + depositErc20). The
///    `erc20_address` is the descriptor's token (fail-closed would NEVER fall back to ckUSDC's address
///    for a different token — but `Some` already carries the right per-token address).
///  - `None` ⇒ `"native_eth"`: native ETH. ONE payable `depositEth` tx; `erc20_address` is `None`.
///
/// A non-CkEthErc20 family (e.g. CkBtcUtxo, CkSol) or a missing descriptor MUST surface a 503 — it
/// must NEVER fall back to a default address.
///
/// The `helper_address` is NETWORK-scoped (Ethereum mainnet vs Sepolia testnet each deploy their own
/// CkDeposit helper under the same ckETH minter); the descriptor's `chain_id` selects which verified
/// constant to surface. The match is EXPLICIT and FAIL-CLOSED on an unknown chain_id: a future
/// ckERC20 deployed on, say, Polygon (chain_id 137) that hasn't been wired into the relay must NOT
/// silently mis-route to the mainnet helper (the user's deposit would never arrive). Known chains:
/// mainnet (`Some(1)`) and Sepolia (`Some(11155111)`). `None` is treated as mainnet — a CkEthErc20
/// currency with no `chain_id` is a metadata gap (the cold-start fallback before the catalog
/// populated chain_id), and the mainnet helper is the safe default. The SAME helper serves both
/// `depositEth` and `depositErc20` (see DFINITY `DepositHelperWithSubaccount.sol` `CkDeposit`).
pub fn ckerc20_onramp_from_descriptor(
    desc: Option<&CurrencyDescriptor>,
) -> Result<CkErc20OnrampParams, LedgerError> {
    let d = desc.ok_or_else(|| LedgerError::Transient("no ckERC-20 onramp for currency".into()))?;
    if d.minter_family != Some(MinterFamily::CkEthErc20) {
        return Err(LedgerError::Transient("no ckERC-20 onramp for currency".into()));
    }
    // Network-scoped helper, EXPLICIT + fail-closed: known chain_ids resolve to their verified
    // helper; an UNKNOWN chain_id returns Err (Transient → HTTP 503) instead of silently mis-routing
    // to the mainnet helper. `None` falls through to mainnet — the cold-start metadata-gap default.
    // The SAME helper contract serves native ETH (depositEth) and ERC-20 (depositErc20).
    let helper_address = match d.chain_id {
        Some(1) | None => CKERC20_HELPER_ADDRESS_MAINNET,
        Some(11155111) => CKERC20_HELPER_ADDRESS_SEPOLIA,
        Some(other) => {
            return Err(LedgerError::Transient(format!(
                "unknown chain_id {other} for CkEthErc20 onramp (only mainnet=1 and Sepolia=11155111 are wired)"
            )));
        }
    };
    // Discriminate within the family by token_contract: Some = ERC-20 token; None = native ETH.
    let (erc20_address, kind) = match &d.token_contract {
        Some(addr) => (Some(addr.clone()), "erc20"),
        None => (None, "native_eth"),
    };
    Ok(CkErc20OnrampParams {
        helper_address: helper_address.to_string(),
        erc20_address,
        kind: kind.to_string(),
    })
}

// ---------------------------------------------------------------------------
// ckerc20_onramp_from_descriptor — chain_id fail-closed (M5).
// ---------------------------------------------------------------------------
// The chain_id → helper_address match must NOT silently fall back to mainnet for an UNKNOWN chain:
// a future ckERC20 deployed on, say, Polygon (chain_id 137) that hasn't been wired into the relay
// would mis-route deposits to the mainnet helper and the user's funds would never arrive. The match
// must be explicit: mainnet (1) and Sepolia (11155111) are the only known-good chains; anything
// else fails-closed with a clear error so the operator notices instead of a silent misroute.
#[cfg(test)]
mod ckerc20_onramp_chain_id_tests {
    use super::*;
    use crate::ledger::RampCapability;

    fn cketh_descriptor(chain_id: Option<u32>) -> CurrencyDescriptor {
        CurrencyDescriptor {
            currency: 99,
            ledger: "aaaaa-aa".to_string(),
            mintable: false,
            minter: None,
            minter_family: Some(MinterFamily::CkEthErc20),
            symbol: None,
            decimals: Some(18),
            wrapper_name: None,
            backing_symbol: None,
            network: None,
            display_decimals: None,
            fee: None,
            cap: None,
            chain_id,
            token_contract: None,
            gas_ledger: None,
            onramp: RampCapability::Direct,
            offramp: RampCapability::Direct,
        }
    }

    #[test]
    fn unknown_chain_id_is_rejected_not_silently_mainnet_routed() {
        let desc = cketh_descriptor(Some(999));
        let res = ckerc20_onramp_from_descriptor(Some(&desc));
        assert!(
            res.is_err(),
            "an unknown chain_id must fail-closed, not silently route to the mainnet helper"
        );
    }

    #[test]
    fn mainnet_chain_id_resolves_to_mainnet_helper() {
        let desc = cketh_descriptor(Some(1));
        let onramp = ckerc20_onramp_from_descriptor(Some(&desc)).expect("mainnet ok");
        assert_eq!(onramp.helper_address, CKERC20_HELPER_ADDRESS_MAINNET);
    }

    #[test]
    fn sepolia_chain_id_resolves_to_sepolia_helper() {
        let desc = cketh_descriptor(Some(11155111));
        let onramp = ckerc20_onramp_from_descriptor(Some(&desc)).expect("sepolia ok");
        assert_eq!(onramp.helper_address, CKERC20_HELPER_ADDRESS_SEPOLIA);
    }
}
