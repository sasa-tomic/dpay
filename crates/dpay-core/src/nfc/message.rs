//! NFC v2 application messages carried by the generic frame codec.

use super::{NfcError, MAX_PAYLOAD};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

const BUNDLE_MAGIC: &[u8; 4] = b"DPN2";
const BUNDLE_HEADER_LEN: usize = 4 + 32 + 2 + 2;

/// Fixed byte length of a merchant-signed NFC result.
pub const NFC_RESULT_LEN: usize = 1 + 1 + 16 + 32 + 64;
const RESULT_VERSION: u8 = 2;
const RESULT_DOMAIN: &[u8] = b"dpay-nfc-result-v2";

/// The two IC envelopes needed by an offline payer: submit the update, then poll its request id.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NfcBundle {
    pub request_id: [u8; 32],
    pub update: Vec<u8>,
    pub read_state: Vec<u8>,
}

impl NfcBundle {
    /// Encode `DPN2 | request_id | update_len_be | read_state_len_be | update | read_state`.
    pub fn encode(&self) -> Result<Vec<u8>, NfcError> {
        if self.update.is_empty() || self.read_state.is_empty() {
            return Err(NfcError::BadMessage);
        }
        let update_len = u16::try_from(self.update.len()).map_err(|_| NfcError::BadMessage)?;
        let read_state_len =
            u16::try_from(self.read_state.len()).map_err(|_| NfcError::BadMessage)?;
        let total = BUNDLE_HEADER_LEN
            .checked_add(self.update.len())
            .and_then(|n| n.checked_add(self.read_state.len()))
            .ok_or(NfcError::BadMessage)?;
        if total > MAX_PAYLOAD {
            return Err(NfcError::BadMessage);
        }

        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(BUNDLE_MAGIC);
        out.extend_from_slice(&self.request_id);
        out.extend_from_slice(&update_len.to_be_bytes());
        out.extend_from_slice(&read_state_len.to_be_bytes());
        out.extend_from_slice(&self.update);
        out.extend_from_slice(&self.read_state);
        Ok(out)
    }

    /// Decode a bundle and require the declared lengths to consume the input exactly.
    pub fn decode(bytes: &[u8]) -> Result<Self, NfcError> {
        if bytes.len() < BUNDLE_HEADER_LEN || bytes.len() > MAX_PAYLOAD {
            return Err(NfcError::BadMessage);
        }
        if &bytes[..4] != BUNDLE_MAGIC {
            return Err(NfcError::BadMessage);
        }

        let mut request_id = [0u8; 32];
        request_id.copy_from_slice(&bytes[4..36]);
        let update_len = u16::from_be_bytes([bytes[36], bytes[37]]) as usize;
        let read_state_len = u16::from_be_bytes([bytes[38], bytes[39]]) as usize;
        if update_len == 0 || read_state_len == 0 {
            return Err(NfcError::BadMessage);
        }
        let expected = BUNDLE_HEADER_LEN
            .checked_add(update_len)
            .and_then(|n| n.checked_add(read_state_len))
            .ok_or(NfcError::BadMessage)?;
        if expected != bytes.len() || expected > MAX_PAYLOAD {
            return Err(NfcError::BadMessage);
        }
        let update_end = BUNDLE_HEADER_LEN + update_len;
        Ok(NfcBundle {
            request_id,
            update: bytes[BUNDLE_HEADER_LEN..update_end].to_vec(),
            read_state: bytes[update_end..].to_vec(),
        })
    }
}

/// Merchant's authenticated settlement outcome.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NfcResultStatus {
    Settled = 0,
    Rejected = 1,
    Unknown = 2,
}

impl NfcResultStatus {
    pub fn from_byte(byte: u8) -> Result<Self, NfcError> {
        match byte {
            0 => Ok(Self::Settled),
            1 => Ok(Self::Rejected),
            2 => Ok(Self::Unknown),
            _ => Err(NfcError::BadMessage),
        }
    }

    pub fn byte(self) -> u8 {
        self as u8
    }
}

/// Fixed 114-byte result: `version | status | nonce | request_id | signature`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct NfcResult {
    pub status: NfcResultStatus,
    pub nonce: [u8; 16],
    pub request_id: [u8; 32],
    pub signature: [u8; 64],
}

impl NfcResult {
    /// Sign a result with the merchant key named by `PaymentRequest.to`.
    pub fn sign(
        key: &SigningKey,
        status: NfcResultStatus,
        nonce: [u8; 16],
        request_id: [u8; 32],
    ) -> Self {
        let signature = key
            .sign(&result_signing_bytes(status, &nonce, &request_id))
            .to_bytes();
        NfcResult {
            status,
            nonce,
            request_id,
            signature,
        }
    }

    pub fn to_bytes(&self) -> [u8; NFC_RESULT_LEN] {
        let mut out = [0u8; NFC_RESULT_LEN];
        out[0] = RESULT_VERSION;
        out[1] = self.status.byte();
        out[2..18].copy_from_slice(&self.nonce);
        out[18..50].copy_from_slice(&self.request_id);
        out[50..].copy_from_slice(&self.signature);
        out
    }

    /// Parse structural fields. Authenticity and request binding are checked by [`verify`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, NfcError> {
        if bytes.len() != NFC_RESULT_LEN || bytes[0] != RESULT_VERSION {
            return Err(NfcError::BadMessage);
        }
        let status = NfcResultStatus::from_byte(bytes[1])?;
        let mut nonce = [0u8; 16];
        nonce.copy_from_slice(&bytes[2..18]);
        let mut request_id = [0u8; 32];
        request_id.copy_from_slice(&bytes[18..50]);
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&bytes[50..]);
        Ok(NfcResult {
            status,
            nonce,
            request_id,
            signature,
        })
    }

    /// Verify the merchant signature and bind the result to the expected request nonce and IC id.
    pub fn verify(
        &self,
        merchant_public_key: &[u8; 32],
        expected_nonce: &[u8; 16],
        expected_request_id: &[u8; 32],
    ) -> Result<(), NfcError> {
        if &self.nonce != expected_nonce || &self.request_id != expected_request_id {
            return Err(NfcError::BadMessage);
        }
        let key =
            VerifyingKey::from_bytes(merchant_public_key).map_err(|_| NfcError::BadMessage)?;
        let signature = Signature::from_bytes(&self.signature);
        key.verify_strict(
            &result_signing_bytes(self.status, &self.nonce, &self.request_id),
            &signature,
        )
        .map_err(|_| NfcError::BadMessage)
    }

    pub fn parse_and_verify(
        bytes: &[u8],
        merchant_public_key: &[u8; 32],
        expected_nonce: &[u8; 16],
        expected_request_id: &[u8; 32],
    ) -> Result<Self, NfcError> {
        let result = Self::from_bytes(bytes)?;
        result.verify(merchant_public_key, expected_nonce, expected_request_id)?;
        Ok(result)
    }
}

fn result_signing_bytes(
    status: NfcResultStatus,
    nonce: &[u8; 16],
    request_id: &[u8; 32],
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(RESULT_DOMAIN.len() + 1 + 1 + 16 + 32);
    bytes.extend_from_slice(RESULT_DOMAIN);
    bytes.push(RESULT_VERSION);
    bytes.push(status.byte());
    bytes.extend_from_slice(nonce);
    bytes.extend_from_slice(request_id);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_roundtrip_is_byte_exact() {
        let bundle = NfcBundle {
            request_id: [0x23; 32],
            update: vec![1, 2, 3, 4],
            read_state: vec![5, 6, 7],
        };
        let bytes = bundle.encode().unwrap();
        assert_eq!(&bytes[..4], b"DPN2");
        assert_eq!(&bytes[4..36], &[0x23; 32]);
        assert_eq!(&bytes[36..40], &[0, 4, 0, 3]);
        assert_eq!(NfcBundle::decode(&bytes).unwrap(), bundle);
    }

    #[test]
    fn bundle_rejects_empty_bad_lengths_magic_trailing_and_oversize() {
        let good = NfcBundle {
            request_id: [1; 32],
            update: vec![2],
            read_state: vec![3],
        }
        .encode()
        .unwrap();
        assert_eq!(NfcBundle::decode(&good[..39]), Err(NfcError::BadMessage));

        let mut bad = good.clone();
        bad[0] ^= 1;
        assert_eq!(NfcBundle::decode(&bad), Err(NfcError::BadMessage));
        let mut bad = good.clone();
        bad[37] = 2;
        assert_eq!(NfcBundle::decode(&bad), Err(NfcError::BadMessage));
        let mut bad = good.clone();
        bad.extend_from_slice(&[4]);
        assert_eq!(NfcBundle::decode(&bad), Err(NfcError::BadMessage));
        let empty_update = NfcBundle {
            request_id: [0; 32],
            update: vec![],
            read_state: vec![1],
        };
        assert_eq!(empty_update.encode(), Err(NfcError::BadMessage));
        let empty_read_state = NfcBundle {
            request_id: [0; 32],
            update: vec![1],
            read_state: vec![],
        };
        assert_eq!(empty_read_state.encode(), Err(NfcError::BadMessage));
        let oversized = NfcBundle {
            request_id: [0; 32],
            update: vec![1; MAX_PAYLOAD],
            read_state: vec![1],
        };
        assert_eq!(oversized.encode(), Err(NfcError::BadMessage));
    }

    #[test]
    fn every_result_status_signs_parses_and_verifies() {
        let merchant = SigningKey::from_bytes(&[7; 32]);
        let nonce = [8; 16];
        let request_id = [9; 32];
        for status in [
            NfcResultStatus::Settled,
            NfcResultStatus::Rejected,
            NfcResultStatus::Unknown,
        ] {
            let result = NfcResult::sign(&merchant, status, nonce, request_id);
            let bytes = result.to_bytes();
            assert_eq!(bytes.len(), NFC_RESULT_LEN);
            assert_eq!(bytes[0], RESULT_VERSION);
            assert_eq!(bytes[1], status.byte());
            assert_eq!(
                NfcResult::parse_and_verify(
                    &bytes,
                    &merchant.verifying_key().to_bytes(),
                    &nonce,
                    &request_id,
                )
                .unwrap(),
                result
            );
        }
    }

    #[test]
    fn result_rejects_bad_length_version_status_nonce_id_key_and_signature() {
        let merchant = SigningKey::from_bytes(&[7; 32]);
        let other = SigningKey::from_bytes(&[6; 32]);
        let nonce = [8; 16];
        let request_id = [9; 32];
        let bytes =
            NfcResult::sign(&merchant, NfcResultStatus::Settled, nonce, request_id).to_bytes();
        assert_eq!(
            NfcResult::from_bytes(&bytes[..113]),
            Err(NfcError::BadMessage)
        );
        let mut bad = bytes;
        bad[0] = 1;
        assert_eq!(NfcResult::from_bytes(&bad), Err(NfcError::BadMessage));
        let mut bad = bytes;
        bad[1] = 3;
        assert_eq!(NfcResult::from_bytes(&bad), Err(NfcError::BadMessage));
        let parsed = NfcResult::from_bytes(&bytes).unwrap();
        assert_eq!(
            parsed.verify(&merchant.verifying_key().to_bytes(), &[0; 16], &request_id),
            Err(NfcError::BadMessage)
        );
        assert_eq!(
            parsed.verify(&merchant.verifying_key().to_bytes(), &nonce, &[0; 32]),
            Err(NfcError::BadMessage)
        );
        assert_eq!(
            parsed.verify(&other.verifying_key().to_bytes(), &nonce, &request_id),
            Err(NfcError::BadMessage)
        );
        let mut bad = bytes;
        bad[113] ^= 1;
        assert_eq!(
            NfcResult::parse_and_verify(
                &bad,
                &merchant.verifying_key().to_bytes(),
                &nonce,
                &request_id,
            ),
            Err(NfcError::BadMessage)
        );
    }
}
