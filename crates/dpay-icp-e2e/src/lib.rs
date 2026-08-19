//! Env-gated e2e proofs for the user-principal rail (`dpay_icp`).
//!
//! Two INDEPENDENT proofs that the hand-rolled envelopes are accepted by real IC ingress code,
//! beyond the PocketIC gateway covered by `dpay-icp-tests`:
//!
//! * (A) **offline dfx replica** (`tests/replica.rs`) — `dfx start` fronts `/api/v2` on 4943 with
//!   the dfx webserver → PocketIC backend, a second ingress implementation. Driven by
//!   `scripts/icp-replica-e2e.sh` (`DPAY_IC_REPLICA_URL` + `DPAY_IC_LEDGER_ID`); without the env
//!   the tests print `skipped` and pass.
//! * (B) **opt-in mainnet** (`tests/mainnet.rs`) — signed read-only queries (no cycles, no state
//!   change) from a throwaway fixed-seed key against `https://icp-api.io` (`DPAY_IC_MAINNET=1`),
//!   driven by `scripts/icp-mainnet-probe.sh`. NEVER part of `check`/`verify`.
//!
//! This lib holds the harness halves that do not depend on `dpay_icp`: a reqwest transport and a
//! minimal definite-length CBOR + IC certificate/hashtree decoder. The env-gated tests in
//! `tests/` early-return "skipped" (and pass) unless their env gate is set, so
//! `cargo nextest run -p dpay-icp-e2e` is green with no replica and no network.

use std::error::Error;
use std::time::Duration;

/// Boxed-error alias: harness code fails for one-shot textual reasons, not typed conditions.
pub type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// `Content-Type` for every `/api/v2` body (envelopes in, CBOR responses out).
pub const CBOR_CONTENT_TYPE: &str = "application/cbor";

// --- fixed throwaway device keys ---------------------------------------------------------------
// Deterministic RFC 8032 test seeds — never real funds. The replica suite funds P1's principal
// (`scripts/icp-replica-e2e.sh` transfers from the ledger's minting account, i.e. the dfx
// identity); the mainnet probe key is read-only (queries only, no cycles, no state change).

/// Funded sender P1 on the local dfx replica.
pub const P1_SEED: [u8; 32] = [0x01; 32];
/// Throwaway read-only key for the opt-in mainnet probe.
pub const PROBE_SEED: [u8; 32] = [0x0e; 32];

/// Deterministic signing key from a fixed seed (no RNG — env-gated tests must be reproducible).
pub fn dev_key(seed: &[u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(seed)
}

// --- CBOR + response decoders ---------------------------------------------------------------------
// Moved into `dpay_icp::reply` (now shared with the app's FFI/wasm surface); re-exported here so
// the env-gated tests keep a single decoder implementation everywhere.

pub use dpay_icp::reply::{
    cbor_encode, cbor_parse, decode_query_response, decode_read_state_tree, read_state_time,
    request_status, tree_lookup, uleb, Cbor, Lookup, QueryOutcome, RequestStatus, Tree,
};

// --- transport -----------------------------------------------------------------------------------

/// Flip one byte of the envelope's top-level `sender_sig` byte string (bad-signature negative
/// control): every other field stays identical, so the ingress's failure can only be the
/// signature check. Per the public spec (and ic-transport-types `Envelope`), `sender_sig` is a
/// plain byte-string field beside `content`/`sender_pubkey` — NOT a nested record.
pub fn corrupt_sender_sig(envelope: &[u8]) -> Result<Vec<u8>> {
    let mut v = cbor_parse(envelope)?;
    let sig = v
        .get_mut("sender_sig")
        .and_then(|s| match s {
            Cbor::Bytes(b) => Some(b),
            _ => None,
        })
        .ok_or("envelope missing top-level sender_sig bytes")?;
    let Some(first) = sig.first_mut() else { return Err("sender_sig is empty".into()) };
    *first ^= 0xff;
    let mut out = Vec::with_capacity(envelope.len());
    cbor_encode(&v, &mut out);
    Ok(out)
}

/// A raw `/api/v2` HTTP response (status + body), so tests can assert on both.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Best-effort body preview for failure messages (error bodies are text; reply bodies CBOR).
    /// Char-boundary-safe: never panics on multi-byte UTF-8 from the lossy conversion.
    pub fn body_preview(&self, max: usize) -> String {
        let text = String::from_utf8_lossy(&self.body);
        let text = text.trim();
        if text.len() <= max {
            return text.to_string();
        }
        let cut = text.char_indices().map(|(i, _)| i).find(|i| i > &max).unwrap_or(max);
        format!("{}…", &text[..cut.saturating_sub(1)])
    }
}

/// Minimal blocking `/api/v2` client. `base` is host root without trailing slash, e.g.
/// `http://127.0.0.1:4943` or `https://icp-api.io` (rustls — no native TLS).
#[derive(Debug, Clone)]
pub struct IcHttp {
    base: String,
    http: reqwest::blocking::Client,
}

impl IcHttp {
    pub fn new(base: impl Into<String>) -> Result<Self> {
        let http = reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build()?;
        Ok(Self { base: base.into().trim_end_matches('/').to_string(), http })
    }

    /// POST a signed envelope to `/api/v2/canister/<canister>/<kind>` where kind is
    /// `query` | `call` | `read_state`. Returns the raw status + body.
    pub fn submit(&self, canister_text: &str, kind: &str, envelope: &[u8]) -> Result<HttpResponse> {
        let url = format!("{base}/api/v2/canister/{canister_text}/{kind}", base = self.base);
        let response = self
            .http
            .post(&url)
            .header("Content-Type", CBOR_CONTENT_TYPE)
            .body(envelope.to_vec())
            .send()?;
        let status = response.status().as_u16();
        let body = response.bytes()?.to_vec();
        Ok(HttpResponse { status, body })
    }
}

// --- harness unit tests (always run; no env, no network) ------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_sender_sig_flips_only_the_signature() {
        // {content: 1, sender_sig: h'00aa55', sender_pubkey: h'42'} — spec envelope shape:
        // sender_sig is a TOP-LEVEL byte string.
        let env = Cbor::Map(vec![
            (Cbor::Text("content".into()), Cbor::Uint(1)),
            (Cbor::Text("sender_pubkey".into()), Cbor::Bytes(vec![0x42])),
            (Cbor::Text("sender_sig".into()), Cbor::Bytes(vec![0x00, 0xaa, 0x55])),
        ]);
        let mut buf = Vec::new();
        cbor_encode(&env, &mut buf);
        let corrupted = corrupt_sender_sig(&buf).unwrap();
        let back = cbor_parse(&corrupted).unwrap();
        assert_eq!(back.get("content").and_then(Cbor::as_u64), Some(1));
        assert_eq!(back.get("sender_pubkey").and_then(Cbor::as_bytes), Some(&[0x42][..]));
        assert_eq!(back.get("sender_sig").and_then(Cbor::as_bytes), Some(&[0xff, 0xaa, 0x55][..]));
    }

    #[test]
    fn body_preview_is_char_boundary_safe() {
        let r = HttpResponse { status: 200, body: "héllo wörld padding".as_bytes().to_vec() };
        let p = r.body_preview(6);
        // never splits a multi-byte char, never emits control bytes
        assert!(p.chars().all(|c| !c.is_control()));
        assert!(p.ends_with('…'));
        assert!(p.chars().count() <= 8, "preview should stay near the cap: {p:?}");
        let r = HttpResponse { status: 200, body: b"short".to_vec() };
        assert_eq!(r.body_preview(50), "short");
    }
}
