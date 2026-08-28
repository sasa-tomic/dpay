//! OPT-IN mainnet read-only smoke for the native ICP index history adapter (U4) — NOT part of
//! check/verify. Network required (https://icp-api.io). Read-only: query calls only, no cycles,
//! no state change, throwaway fixed-seed key. Run via `just ic-index-probe`
//! (convention: the sibling of `ic-mainnet-probe`; without `DPAY_IC_MAINNET=1` every test here
//! prints "skipped" and returns, so the offline hot path never touches the network).
//!
//! Two proofs:
//!   1. INDEX PIN: `ledger_id()` on the pinned ICP index (qhbym-qaaaa-aaaaa-aaafq-cai) must
//!      return the pinned canonical ICP ledger (ryjl3-tyaaa-aaaaa-aaaba-cai) — if DFINITY ever
//!      re-points the index at a different ledger, dispatch on the ledger principal would
//!      silently read the WRONG asset's history, and this probe is the only place that can
//!      catch it.
//!   2. ADAPTER SMOKE: one small account-history query through `transactions_on_ledger` with
//!      the canonical ICP ledger principal — exercising the full new path against production
//!      (dispatch → get_account_transactions → Candid decode → TxnRecord mapping). The
//!      throwaway account has no history, so the expected result is an EMPTY, Ok history: the
//!      point is that the real index accepts our query shape (account/start/max_results) and
//!      the reply decodes, not that rows come back.

#![cfg(feature = "agent")]

use candid::{decode_one, encode_args, Principal};
use dpay_relay::agent_ledger::{icp_index_for_ledger, ICP_INDEX, ICP_LEDGER};
use dpay_relay::{AgentLedger, Ledger};

const MAINNET_URL: &str = "https://icp-api.io";

#[test]
fn icp_index_mainnet_pin_and_account_history_smoke() {
    if std::env::var("DPAY_IC_MAINNET").is_err() {
        eprintln!("skipped: set DPAY_IC_MAINNET=1 (opt-in mainnet probe, needs network)");
        return;
    }

    // Offline pin sanity first (free): the dispatch table maps exactly the canonical pair.
    let icp_ledger = Principal::from_text(ICP_LEDGER).expect("pinned ICP ledger parses");
    let icp_index = Principal::from_text(ICP_INDEX).expect("pinned ICP index parses");
    assert_eq!(icp_index_for_ledger(&icp_ledger), Some(icp_index));

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        // 1. The index's own ledger_id() must equal the pinned ICP ledger.
        let agent = ic_agent::Agent::builder()
            .with_url(MAINNET_URL)
            .build()
            .expect("build mainnet agent");
        agent.fetch_root_key().await.expect("fetch root key");
        let reply = agent
            .query(&icp_index, "ledger_id")
            .with_arg(encode_args(()).expect("encode empty ledger_id arg"))
            .call()
            .await
            .expect("ledger_id query on the pinned index");
        let ledger_id = decode_one::<Principal>(&reply).expect("decode ledger_id principal");
        assert_eq!(
            ledger_id.to_text(),
            icp_ledger.to_text(),
            "the pinned ICP index no longer fronts the pinned ICP ledger — dispatch would \
             read the wrong asset's history; re-pin after verifying on the forum/IC status"
        );

        // 2. One account-history query through the new adapter, throwaway key.
        //    Fixed test seed — NOT secret; any 32 bytes work for a read-only query.
        let seed: [u8; 32] = core::array::from_fn(|i| (i as u8).wrapping_mul(11).wrapping_add(7));
        let pk = ed25519_dalek::SigningKey::from_bytes(&seed)
            .verifying_key()
            .to_bytes();
        let agent = AgentLedger::connect(MAINNET_URL, icp_index)
            .await
            .expect("AgentLedger connect to mainnet");
        let rows = agent
            .transactions_on_ledger(ICP_LEDGER, pk, 1, 5, None)
            .await
            .expect("account history through the ICP index adapter");
        assert!(
            rows.len() <= 5,
            "history respects the limit even against the real index"
        );
        // The throwaway account should be EMPTY; if it is not, the rows must at least be
        // well-formed TxnRecords (currency tag copied from the request, decimal strings).
        for r in &rows {
            assert_eq!(r.currency, 1);
            assert!(r.amount.0 > 0, "a returned row must carry a real amount");
        }
        eprintln!(
            "icp-index mainnet smoke: ledger_id pin OK, adapter query OK, {} row(s) for the \
             throwaway account",
            rows.len()
        );
    });
}
