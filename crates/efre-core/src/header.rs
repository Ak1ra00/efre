//! The plaintext, MAC-authenticated vault header (ARCHITECTURE §5.5).
//!
//! All integers are big-endian. The parser is strict: exact magic, known versions,
//! lengths within bounds, no trailing bytes, no duplicate slot or credential ids.

use efre_authn::{CredentialId, MAX_CREDENTIAL_ID_LEN};

use crate::crypto::{ID_LEN, NONCE_LEN, WRAPPED_LEN};
use crate::error::{Result, VaultError};

pub(crate) const MAGIC: [u8; 4] = *b"EFRE";
/// On-disk format written by this build.
pub(crate) const FORMAT_VERSION: u16 = 1;
/// Oldest format this build opens; anything older is a downgrade and refused.
pub(crate) const MIN_FORMAT_VERSION: u16 = 1;
/// Record payload schema written and read by this build.
pub(crate) const SCHEMA_VERSION: u16 = 1;
pub(crate) const MAX_SLOTS: usize = 16;
pub(crate) const MAX_NICKNAME_CHARS: usize = 64;
const MAX_NICKNAME_BYTES: usize = 256;

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Slot {
    pub(crate) slot_id: [u8; ID_LEN],
    pub(crate) aaguid: [u8; 16],
    pub(crate) salt: [u8; 32],
    pub(crate) enrolled_at: i64,
    pub(crate) credential_id: CredentialId,
    pub(crate) nickname: String,
    pub(crate) wrap_nonce: [u8; NONCE_LEN],
    pub(crate) wrapped_vmk: [u8; WRAPPED_LEN],
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Header {
    pub(crate) format_version: u16,
    pub(crate) schema_version: u16,
    pub(crate) vault_id: [u8; ID_LEN],
    pub(crate) slots: Vec<Slot>,
}

/// Validates a key nickname: 1..=64 characters, at most 256 bytes, no control
/// characters, no leading/trailing whitespace.
pub(crate) fn validate_nickname(nickname: &str) -> Result<()> {
    let chars = nickname.chars().count();
    if chars == 0
        || chars > MAX_NICKNAME_CHARS
        || nickname.len() > MAX_NICKNAME_BYTES
        || nickname.chars().any(char::is_control)
        || nickname.trim() != nickname
    {
        return Err(VaultError::Invalid("key nickname"));
    }
    Ok(())
}

impl Header {
    /// Checks every invariant the decoder enforces, so encode/decode round-trip.
    fn validate(&self) -> Result<()> {
        if self.slots.is_empty() {
            return Err(VaultError::NoKeys);
        }
        if self.slots.len() > MAX_SLOTS {
            return Err(VaultError::TooManyKeys);
        }
        for (i, slot) in self.slots.iter().enumerate() {
            validate_nickname(&slot.nickname)?;
            for other in &self.slots[i + 1..] {
                if other.slot_id == slot.slot_id || other.credential_id == slot.credential_id {
                    return Err(VaultError::Invalid("duplicate key slot"));
                }
            }
        }
        Ok(())
    }

    pub(crate) fn encode(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut out = Vec::with_capacity(25 + self.slots.len() * 400);
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&self.format_version.to_be_bytes());
        out.extend_from_slice(&self.schema_version.to_be_bytes());
        out.extend_from_slice(&self.vault_id);
        out.push(u8::try_from(self.slots.len()).map_err(|_| VaultError::TooManyKeys)?);
        for slot in &self.slots {
            out.extend_from_slice(&slot.slot_id);
            out.extend_from_slice(&slot.aaguid);
            out.extend_from_slice(&slot.salt);
            out.extend_from_slice(&slot.enrolled_at.to_be_bytes());
            let cred = slot.credential_id.as_bytes();
            let cred_len =
                u16::try_from(cred.len()).map_err(|_| VaultError::Invalid("credential id"))?;
            out.extend_from_slice(&cred_len.to_be_bytes());
            out.extend_from_slice(cred);
            let nick = slot.nickname.as_bytes();
            let nick_len =
                u16::try_from(nick.len()).map_err(|_| VaultError::Invalid("key nickname"))?;
            out.extend_from_slice(&nick_len.to_be_bytes());
            out.extend_from_slice(nick);
            out.extend_from_slice(&slot.wrap_nonce);
            out.extend_from_slice(&slot.wrapped_vmk);
        }
        Ok(out)
    }

    /// Parses an untrusted header. Version checks happen here, before any key is used.
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self> {
        let mut r = Reader { bytes, pos: 0 };
        if r.array::<4>()? != MAGIC {
            return Err(VaultError::NotAVault);
        }
        let format_version = r.u16()?;
        if format_version > FORMAT_VERSION {
            return Err(VaultError::TooNew);
        }
        if format_version < MIN_FORMAT_VERSION {
            return Err(VaultError::UnsupportedVersion);
        }
        let schema_version = r.u16()?;
        if schema_version > SCHEMA_VERSION {
            return Err(VaultError::TooNew);
        }
        if schema_version != SCHEMA_VERSION {
            return Err(VaultError::UnsupportedVersion);
        }
        let vault_id = r.array::<ID_LEN>()?;
        let count = usize::from(r.u8()?);
        if count == 0 || count > MAX_SLOTS {
            return Err(VaultError::Corrupt("key slot count"));
        }
        let mut slots = Vec::with_capacity(count);
        for _ in 0..count {
            let slot_id = r.array::<ID_LEN>()?;
            let aaguid = r.array::<16>()?;
            let salt = r.array::<32>()?;
            let enrolled_at = i64::from_be_bytes(r.array::<8>()?);
            let cred_len = usize::from(r.u16()?);
            if cred_len == 0 || cred_len > MAX_CREDENTIAL_ID_LEN {
                return Err(VaultError::Corrupt("credential id length"));
            }
            let credential_id = CredentialId::new(r.take(cred_len)?.to_vec())
                .map_err(|_| VaultError::Corrupt("credential id length"))?;
            let nick_len = usize::from(r.u16()?);
            if nick_len == 0 || nick_len > MAX_NICKNAME_BYTES {
                return Err(VaultError::Corrupt("key nickname"));
            }
            let nickname = String::from_utf8(r.take(nick_len)?.to_vec())
                .map_err(|_| VaultError::Corrupt("key nickname"))?;
            let wrap_nonce = r.array::<NONCE_LEN>()?;
            let wrapped_vmk = r.array::<WRAPPED_LEN>()?;
            slots.push(Slot {
                slot_id,
                aaguid,
                salt,
                enrolled_at,
                credential_id,
                nickname,
                wrap_nonce,
                wrapped_vmk,
            });
        }
        if r.pos != bytes.len() {
            return Err(VaultError::Corrupt("trailing header bytes"));
        }
        let header = Self {
            format_version,
            schema_version,
            vault_id,
            slots,
        };
        header
            .validate()
            .map_err(|_| VaultError::Corrupt("key slots"))?;
        Ok(header)
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.bytes.len());
        let end = end.ok_or(VaultError::Corrupt("truncated header"))?;
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.take(N)?
            .try_into()
            .map_err(|_| VaultError::Corrupt("truncated header"))
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.array::<2>()?))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use proptest::prelude::*;

    pub(crate) fn sample_slot(n: u8) -> Slot {
        Slot {
            slot_id: [n; ID_LEN],
            aaguid: [n.wrapping_add(1); 16],
            salt: [n.wrapping_add(2); 32],
            enrolled_at: 1_700_000_000 + i64::from(n),
            credential_id: CredentialId::new(vec![n; 48]).unwrap(),
            nickname: format!("Key {n}"),
            wrap_nonce: [n.wrapping_add(3); NONCE_LEN],
            wrapped_vmk: [n.wrapping_add(4); WRAPPED_LEN],
        }
    }

    fn sample() -> Header {
        Header {
            format_version: FORMAT_VERSION,
            schema_version: SCHEMA_VERSION,
            vault_id: [9; ID_LEN],
            slots: vec![sample_slot(1), sample_slot(2)],
        }
    }

    #[test]
    fn layout_is_exactly_as_documented() {
        let h = Header {
            slots: vec![sample_slot(1)],
            ..sample()
        };
        let bytes = h.encode().unwrap();
        assert_eq!(&bytes[..4], b"EFRE");
        assert_eq!(&bytes[4..6], &[0, 1]); // format_version
        assert_eq!(&bytes[6..8], &[0, 1]); // schema_version
        assert_eq!(&bytes[8..24], &[9; 16]); // vault_id
        assert_eq!(bytes[24], 1); // slot_count
        let s = &bytes[25..];
        assert_eq!(&s[..16], &[1; 16]); // slot_id
        assert_eq!(&s[16..32], &[2; 16]); // aaguid
        assert_eq!(&s[32..64], &[3; 32]); // salt
        assert_eq!(&s[64..72], &1_700_000_001i64.to_be_bytes()); // enrolled_at
        assert_eq!(&s[72..74], &48u16.to_be_bytes()); // cred_id_len
        assert_eq!(&s[74..122], &[1; 48]); // cred_id
        assert_eq!(&s[122..124], &5u16.to_be_bytes()); // nickname_len
        assert_eq!(&s[124..129], b"Key 1"); // nickname
        assert_eq!(&s[129..153], &[4; 24]); // wrap_nonce
        assert_eq!(&s[153..201], &[5; 48]); // wrapped_vmk
        assert_eq!(s.len(), 201);
    }

    #[test]
    fn version_checks() {
        let mut bytes = sample().encode().unwrap();
        bytes[5] = 0; // format_version 0: older than supported (downgrade)
        assert!(matches!(
            Header::decode(&bytes),
            Err(VaultError::UnsupportedVersion)
        ));
        bytes[5] = 2; // format_version 2: newer
        assert!(matches!(Header::decode(&bytes), Err(VaultError::TooNew)));
        bytes[5] = 1;
        bytes[7] = 2; // schema_version 2
        assert!(matches!(Header::decode(&bytes), Err(VaultError::TooNew)));
        bytes[7] = 0;
        assert!(matches!(
            Header::decode(&bytes),
            Err(VaultError::UnsupportedVersion)
        ));
    }

    #[test]
    fn strictness() {
        let good = sample().encode().unwrap();
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(Header::decode(&trailing).is_err());
        assert!(Header::decode(&good[..good.len() - 1]).is_err());
        let mut magic = good.clone();
        magic[0] = b'X';
        assert!(matches!(Header::decode(&magic), Err(VaultError::NotAVault)));
        let mut zero_slots = good.clone();
        zero_slots[24] = 0;
        assert!(Header::decode(&zero_slots).is_err());

        let dup = Header {
            slots: vec![sample_slot(1), sample_slot(1)],
            ..sample()
        };
        assert!(dup.encode().is_err());
        let mut same_cred = sample();
        same_cred.slots[1].credential_id = same_cred.slots[0].credential_id.clone();
        assert!(same_cred.encode().is_err());
    }

    #[test]
    fn nicknames() {
        for ok in ["Primary", "Backup — safe", "🔑 keychain", &"x".repeat(64)] {
            validate_nickname(ok).unwrap();
        }
        for bad in ["", " lead", "trail ", "a\nb", "tab\t", &"x".repeat(65)] {
            assert!(validate_nickname(bad).is_err(), "{bad:?}");
        }
    }

    fn arb_slot() -> impl Strategy<Value = Slot> {
        (
            any::<[u8; 16]>(),
            any::<[u8; 16]>(),
            any::<[u8; 32]>(),
            any::<i64>(),
            proptest::collection::vec(any::<u8>(), 1..=MAX_CREDENTIAL_ID_LEN),
            "[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,30}[a-zA-Z0-9]",
            any::<[u8; NONCE_LEN]>(),
            proptest::collection::vec(any::<u8>(), WRAPPED_LEN),
        )
            .prop_map(
                |(slot_id, aaguid, salt, enrolled_at, cred, nickname, wrap_nonce, wrapped)| Slot {
                    slot_id,
                    aaguid,
                    salt,
                    enrolled_at,
                    credential_id: CredentialId::new(cred).unwrap(),
                    nickname,
                    wrap_nonce,
                    wrapped_vmk: wrapped.try_into().unwrap(),
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        #[test]
        fn round_trip(vault_id in any::<[u8; 16]>(), slots in proptest::collection::vec(arb_slot(), 1..=MAX_SLOTS)) {
            let header = Header { format_version: FORMAT_VERSION, schema_version: SCHEMA_VERSION, vault_id, slots };
            // Random ids/credentials are unique with overwhelming probability.
            let bytes = header.encode().unwrap();
            prop_assert_eq!(Header::decode(&bytes).unwrap(), header);
        }

        #[test]
        fn decode_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..2048)) {
            let _ = Header::decode(&bytes);
        }

        #[test]
        fn decode_never_panics_near_valid(index in any::<prop::sample::Index>(), byte in any::<u8>()) {
            let mut bytes = sample().encode().unwrap();
            let i = index.index(bytes.len());
            bytes[i] = byte;
            let _ = Header::decode(&bytes);
        }
    }
}
