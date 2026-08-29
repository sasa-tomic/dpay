//! dpay-icp — the pure-Rust IC user-principal rail core.
//!
//! Offline construction of full IC request envelopes for a device ed25519 key: principal
//! derivation, `request_id` hashing, ed25519 signing, the CBOR envelope (serde_cbor 0.11
//! emission rules), and hand-rolled ICRC-1/2 candid codecs. Transport-free, HTTP-free,
//! alloc-only; builds natively and for wasm32-unknown-unknown.
//!
//! Byte-exactness is the product: every wire shape here is pinned by golden vectors
//! (`tests/goldens.rs`) generated with the production crates (`ic-transport-types` 0.48.1 /
//! `serde_cbor` 0.11.2 / `candid` 0.10.22 / `icrc-ledger-types` 0.1.12 / `ed25519-dalek` 2.2).

pub mod cbor;
pub mod envelope;
pub mod icrc;
pub mod principal;
pub mod reply;
pub mod request_id;

pub use envelope::{ingress_expiry, sign_query, sign_read_state, sign_update, CallRequest};
pub use principal::{Account, AccountIdentifier, Principal};
pub use request_id::{request_id, RidValue};

/// Everything that can go wrong on this rail. Hand-rolled Display/Error (no thiserror —
/// the crate must stay dependency-minimal for wasm32/UniFFI).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IcpError {
    /// Principal text is not well-formed base32/crc32/length (details in the message).
    PrincipalText(String),
    /// Principal blob exceeds the 29-byte IC limit.
    PrincipalTooLong(usize),
    /// DIDL bytes are malformed (truncated, bad LEB128, unexpected shape).
    DidlDecode(String),
    /// The DIDL blob decoded fine but is not the expected shape for this decoder.
    DidlType(String),
    /// CBOR bytes are malformed.
    CborDecode(String),
}

impl std::fmt::Display for IcpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PrincipalText(m) => write!(f, "invalid principal text: {m}"),
            Self::PrincipalTooLong(n) => {
                write!(f, "principal blob is {n} bytes; IC maximum is 29")
            }
            Self::DidlDecode(m) => write!(f, "DIDL decode error: {m}"),
            Self::DidlType(m) => write!(f, "DIDL shape mismatch: {m}"),
            Self::CborDecode(m) => write!(f, "CBOR decode error: {m}"),
        }
    }
}

impl std::error::Error for IcpError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_is_stable() {
        assert_eq!(IcpError::PrincipalTooLong(30).to_string(), "principal blob is 30 bytes; IC maximum is 29");
        assert!(IcpError::DidlDecode("truncated".into()).to_string().contains("DIDL decode error"));
    }
}
