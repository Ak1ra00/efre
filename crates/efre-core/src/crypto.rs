//! Cryptographic operations of ARCHITECTURE §5, built only from audited primitives:
//! XChaCha20-Poly1305 (`chacha20poly1305`), HKDF-SHA256 (`hkdf`), HMAC-SHA256 (`hmac`),
//! SHA-256 (`sha2`) and the OS CSPRNG (`rand::rngs::SysRng`).

use chacha20poly1305::aead::{AeadInOut, KeyInit};
use chacha20poly1305::{Tag, XChaCha20Poly1305, XNonce};
use efre_authn::{PrfOutput, Salt};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::TryRng;
use rand::rngs::SysRng;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Result, Tamper, VaultError};

pub(crate) const KEY_LEN: usize = 32;
pub(crate) const ID_LEN: usize = 16;
pub(crate) const NONCE_LEN: usize = 24;
pub(crate) const TAG_LEN: usize = 16;
pub(crate) const MAC_LEN: usize = 32;
pub(crate) const WRAPPED_LEN: usize = KEY_LEN + TAG_LEN;

pub(crate) const LBL_DATA: &[u8] = b"efre/v1/data";
pub(crate) const LBL_HEADER: &[u8] = b"efre/v1/header";
pub(crate) const LBL_KEK: &[u8] = b"efre/v1/kek";
pub(crate) const LBL_MANIFEST: &[u8] = b"efre/v1/manifest";

/// Plaintext records are padded to a multiple of this (§5.4).
pub(crate) const PAD_BUCKET: usize = 256;
/// Largest record payload efre writes or accepts.
pub(crate) const MAX_PAYLOAD: usize = 1024 * 1024;
/// Smallest valid record ciphertext: one bucket plus the tag.
pub(crate) const MIN_RECORD_CIPHERTEXT: usize = PAD_BUCKET + TAG_LEN;

type HmacSha256 = Hmac<Sha256>;

/// Fills `buf` from the OS CSPRNG; failure is an error, never a fallback.
pub(crate) fn fill_random(buf: &mut [u8]) -> Result<()> {
    SysRng.try_fill_bytes(buf).map_err(|_| VaultError::Rng)
}

pub(crate) fn random<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    fill_random(&mut out)?;
    Ok(out)
}

fn cipher(key: &[u8; KEY_LEN]) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new_from_slice(key)
        .unwrap_or_else(|_| unreachable!("XChaCha20-Poly1305 keys are 32 bytes"))
}

fn hmac(key: &[u8; KEY_LEN]) -> HmacSha256 {
    <HmacSha256 as KeyInit>::new_from_slice(key)
        .unwrap_or_else(|_| unreachable!("HMAC accepts 32-byte keys"))
}

// ---------------------------------------------------------------------------------
// Key slots (§5.3)
// ---------------------------------------------------------------------------------

/// `KEK = HKDF-SHA256(salt = slot salt, ikm = PRF, info = LBL_KEK || vault_id || slot_id)`.
pub(crate) fn derive_kek(
    prf: &PrfOutput,
    salt: &Salt,
    vault_id: &[u8; ID_LEN],
    slot_id: &[u8; ID_LEN],
) -> Zeroizing<[u8; KEY_LEN]> {
    let mut kek = Zeroizing::new([0u8; KEY_LEN]);
    Hkdf::<Sha256>::new(Some(&salt.0), prf.expose())
        .expand_multi_info(&[LBL_KEK, vault_id, slot_id], &mut *kek)
        .unwrap_or_else(|_| unreachable!("32 bytes is a valid HKDF-SHA256 output length"));
    kek
}

/// `vault_id (16) || slot_id (16) || u16 BE format_version`.
fn slot_aad(vault_id: &[u8; ID_LEN], slot_id: &[u8; ID_LEN], format_version: u16) -> [u8; 34] {
    let mut aad = [0u8; 34];
    aad[..16].copy_from_slice(vault_id);
    aad[16..32].copy_from_slice(slot_id);
    aad[32..].copy_from_slice(&format_version.to_be_bytes());
    aad
}

/// Seals the VMK under a KEK with a fresh random nonce. Returns `(nonce, ct || tag)`.
pub(crate) fn wrap_vmk(
    kek: &[u8; KEY_LEN],
    vault_id: &[u8; ID_LEN],
    slot_id: &[u8; ID_LEN],
    format_version: u16,
    vmk: &[u8; KEY_LEN],
) -> Result<([u8; NONCE_LEN], [u8; WRAPPED_LEN])> {
    let nonce: [u8; NONCE_LEN] = random()?;
    let mut out = [0u8; WRAPPED_LEN];
    out[..KEY_LEN].copy_from_slice(vmk);
    let aad = slot_aad(vault_id, slot_id, format_version);
    match cipher(kek).encrypt_inout_detached(
        &XNonce::from(nonce),
        &aad,
        (&mut out[..KEY_LEN]).into(),
    ) {
        Ok(tag) => {
            out[KEY_LEN..].copy_from_slice(&tag);
            Ok((nonce, out))
        }
        Err(_) => {
            out.zeroize();
            Err(VaultError::Invalid("key wrap failed"))
        }
    }
}

/// Opens a wrapped VMK. Any failure means this KEK (key + salt) does not open this slot.
pub(crate) fn unwrap_vmk(
    kek: &[u8; KEY_LEN],
    vault_id: &[u8; ID_LEN],
    slot_id: &[u8; ID_LEN],
    format_version: u16,
    nonce: &[u8; NONCE_LEN],
    wrapped: &[u8; WRAPPED_LEN],
) -> Result<Zeroizing<[u8; KEY_LEN]>> {
    let mut vmk = Zeroizing::new([0u8; KEY_LEN]);
    vmk.copy_from_slice(&wrapped[..KEY_LEN]);
    let tag = Tag::try_from(&wrapped[KEY_LEN..])
        .unwrap_or_else(|_| unreachable!("wrapped VMK tag is 16 bytes"));
    let aad = slot_aad(vault_id, slot_id, format_version);
    cipher(kek)
        .decrypt_inout_detached(&XNonce::from(*nonce), &aad, (&mut vmk[..]).into(), &tag)
        .map_err(|_| VaultError::KeyRejected)?;
    Ok(vmk)
}

// ---------------------------------------------------------------------------------
// Records (§5.4)
// ---------------------------------------------------------------------------------

/// `vault_id (16) || record_id (16) || u16 BE schema_version`.
fn record_aad(vault_id: &[u8; ID_LEN], record_id: &[u8; ID_LEN], schema_version: u16) -> [u8; 34] {
    slot_aad(vault_id, record_id, schema_version)
}

/// Padded plaintext length for a payload: `256 * ceil((4 + len) / 256)`.
pub(crate) fn padded_len(payload_len: usize) -> usize {
    (4 + payload_len).div_ceil(PAD_BUCKET) * PAD_BUCKET
}

/// A record payload being built in place: `u32 len || payload || zero padding`, in a
/// buffer allocated once with room for the tag, so no copy of the plaintext is left
/// behind by reallocation.
pub(crate) struct PayloadBuf {
    buf: Zeroizing<Vec<u8>>,
    payload_len: usize,
}

impl PayloadBuf {
    /// Allocates a buffer for a payload of exactly `payload_len` bytes.
    pub(crate) fn new(payload_len: usize) -> Result<Self> {
        if payload_len > MAX_PAYLOAD {
            return Err(VaultError::Invalid("item is too large"));
        }
        let total = padded_len(payload_len);
        let mut buf = Zeroizing::new(Vec::with_capacity(total + TAG_LEN));
        buf.resize(total, 0);
        let len =
            u32::try_from(payload_len).map_err(|_| VaultError::Invalid("item is too large"))?;
        buf[..4].copy_from_slice(&len.to_be_bytes());
        Ok(Self { buf, payload_len })
    }

    /// The payload region to fill.
    pub(crate) fn payload_mut(&mut self) -> &mut [u8] {
        &mut self.buf[4..4 + self.payload_len]
    }

    #[cfg(test)]
    pub(crate) fn payload(&self) -> &[u8] {
        &self.buf[4..4 + self.payload_len]
    }
}

/// Encrypts a filled payload buffer in place. Returns `(nonce, ciphertext || tag)`.
pub(crate) fn seal_record(
    data_key: &[u8; KEY_LEN],
    vault_id: &[u8; ID_LEN],
    record_id: &[u8; ID_LEN],
    schema_version: u16,
    payload: PayloadBuf,
) -> Result<([u8; NONCE_LEN], Vec<u8>)> {
    let nonce: [u8; NONCE_LEN] = random()?;
    let aad = record_aad(vault_id, record_id, schema_version);
    let mut buf = payload.buf;
    let tag = cipher(data_key)
        .encrypt_inout_detached(&XNonce::from(nonce), &aad, (&mut buf[..]).into())
        .map_err(|_| VaultError::Invalid("record encryption failed"))?;
    // `buf` now holds only ciphertext; capacity was reserved, so this does not reallocate.
    buf.extend_from_slice(&tag);
    Ok((nonce, core::mem::take(&mut *buf)))
}

/// A decrypted, unpadded record payload. Zeroized on drop.
pub(crate) struct RecordPlaintext {
    buf: Zeroizing<Vec<u8>>,
    len: usize,
}

impl RecordPlaintext {
    pub(crate) fn payload(&self) -> &[u8] {
        &self.buf[4..4 + self.len]
    }
}

/// Decrypts and unpads a record, failing closed on any inconsistency.
pub(crate) fn open_record(
    data_key: &[u8; KEY_LEN],
    vault_id: &[u8; ID_LEN],
    record_id: &[u8; ID_LEN],
    schema_version: u16,
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
) -> Result<RecordPlaintext> {
    let bad = || VaultError::Tampered(Tamper::Record);
    if ciphertext.len() < MIN_RECORD_CIPHERTEXT
        || !(ciphertext.len() - TAG_LEN).is_multiple_of(PAD_BUCKET)
        || ciphertext.len() - TAG_LEN > padded_len(MAX_PAYLOAD)
    {
        return Err(bad());
    }
    let (body, tag) = ciphertext.split_at(ciphertext.len() - TAG_LEN);
    let tag = Tag::try_from(tag).map_err(|_| bad())?;
    let mut buf = Zeroizing::new(body.to_vec());
    let aad = record_aad(vault_id, record_id, schema_version);
    cipher(data_key)
        .decrypt_inout_detached(&XNonce::from(*nonce), &aad, (&mut buf[..]).into(), &tag)
        .map_err(|_| bad())?;
    let len_bytes: [u8; 4] = buf[..4].try_into().map_err(|_| bad())?;
    let len = usize::try_from(u32::from_be_bytes(len_bytes)).map_err(|_| bad())?;
    if len > MAX_PAYLOAD || 4 + len > buf.len() || padded_len(len) != buf.len() {
        return Err(bad());
    }
    if buf[4 + len..].iter().any(|&b| b != 0) {
        return Err(bad());
    }
    Ok(RecordPlaintext { buf, len })
}

// ---------------------------------------------------------------------------------
// Header and manifest MACs (§5.5, §5.8)
// ---------------------------------------------------------------------------------

/// `HMAC-SHA256(header_mac_key, header.body)`.
pub(crate) fn header_mac(key: &[u8; KEY_LEN], body: &[u8]) -> [u8; MAC_LEN] {
    let mut mac = hmac(key);
    mac.update(body);
    mac.finalize().into_bytes().into()
}

/// Constant-time header MAC verification.
pub(crate) fn verify_header_mac(
    key: &[u8; KEY_LEN],
    body: &[u8],
    tag: &[u8; MAC_LEN],
) -> Result<()> {
    let mut mac = hmac(key);
    mac.update(body);
    mac.verify_slice(tag)
        .map_err(|_| VaultError::Tampered(Tamper::Header))
}

/// One stored record, as the manifest sees it.
pub(crate) struct ManifestEntry<'a> {
    pub(crate) id: &'a [u8; ID_LEN],
    pub(crate) nonce: &'a [u8; NONCE_LEN],
    pub(crate) ciphertext: &'a [u8],
}

fn manifest(
    key: &[u8; KEY_LEN],
    format_version: u16,
    vault_id: &[u8; ID_LEN],
    entries: &[ManifestEntry<'_>],
) -> Result<HmacSha256> {
    let count = u32::try_from(entries.len()).map_err(|_| VaultError::Invalid("too many items"))?;
    let mut mac = hmac(key);
    mac.update(LBL_MANIFEST);
    mac.update(&format_version.to_be_bytes());
    mac.update(vault_id);
    mac.update(&count.to_be_bytes());
    let mut previous: Option<&[u8; ID_LEN]> = None;
    for entry in entries {
        // Entries must be strictly ascending by id (the storage layer guarantees it).
        if previous.is_some_and(|p| p >= entry.id) {
            return Err(VaultError::Corrupt("record order"));
        }
        previous = Some(entry.id);
        let digest = Sha256::new()
            .chain_update(entry.nonce)
            .chain_update(entry.ciphertext)
            .finalize();
        mac.update(entry.id);
        mac.update(&digest);
    }
    Ok(mac)
}

/// Manifest MAC over all records, sorted ascending by id (§5.8).
pub(crate) fn manifest_mac(
    key: &[u8; KEY_LEN],
    format_version: u16,
    vault_id: &[u8; ID_LEN],
    entries: &[ManifestEntry<'_>],
) -> Result<[u8; MAC_LEN]> {
    Ok(manifest(key, format_version, vault_id, entries)?
        .finalize()
        .into_bytes()
        .into())
}

/// Constant-time manifest verification.
pub(crate) fn verify_manifest_mac(
    key: &[u8; KEY_LEN],
    format_version: u16,
    vault_id: &[u8; ID_LEN],
    entries: &[ManifestEntry<'_>],
    tag: &[u8; MAC_LEN],
) -> Result<()> {
    manifest(key, format_version, vault_id, entries)?
        .verify_slice(tag)
        .map_err(|_| VaultError::Tampered(Tamper::Manifest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const VAULT: [u8; ID_LEN] = [1; ID_LEN];
    const SLOT: [u8; ID_LEN] = [2; ID_LEN];
    const RECORD: [u8; ID_LEN] = [3; ID_LEN];

    fn prf(byte: u8) -> PrfOutput {
        PrfOutput::new(Zeroizing::new([byte; 32]))
    }

    fn seal(key: &[u8; KEY_LEN], payload: &[u8]) -> ([u8; NONCE_LEN], Vec<u8>) {
        let mut buf = PayloadBuf::new(payload.len()).unwrap();
        buf.payload_mut().copy_from_slice(payload);
        seal_record(key, &VAULT, &RECORD, 1, buf).unwrap()
    }

    #[test]
    fn kek_depends_on_every_input() {
        let base = derive_kek(&prf(9), &Salt([7; 32]), &VAULT, &SLOT);
        for other in [
            derive_kek(&prf(8), &Salt([7; 32]), &VAULT, &SLOT),
            derive_kek(&prf(9), &Salt([6; 32]), &VAULT, &SLOT),
            derive_kek(&prf(9), &Salt([7; 32]), &[0; ID_LEN], &SLOT),
            derive_kek(&prf(9), &Salt([7; 32]), &VAULT, &[0; ID_LEN]),
        ] {
            assert_ne!(*base, *other);
        }
    }

    #[test]
    fn kek_matches_independent_hkdf() {
        let kek = derive_kek(&prf(9), &Salt([7; 32]), &VAULT, &SLOT);
        let mut info = Vec::new();
        info.extend_from_slice(b"efre/v1/kek");
        info.extend_from_slice(&VAULT);
        info.extend_from_slice(&SLOT);
        let mut expected = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&[7; 32]), &[9; 32])
            .expand(&info, &mut expected)
            .unwrap();
        assert_eq!(*kek, expected);
    }

    #[test]
    fn wrap_round_trip_and_every_binding() {
        let kek = [5u8; KEY_LEN];
        let vmk = [6u8; KEY_LEN];
        let (nonce, wrapped) = wrap_vmk(&kek, &VAULT, &SLOT, 1, &vmk).unwrap();
        assert_eq!(
            *unwrap_vmk(&kek, &VAULT, &SLOT, 1, &nonce, &wrapped).unwrap(),
            vmk
        );

        let reject = |r: Result<Zeroizing<[u8; KEY_LEN]>>| {
            assert!(matches!(r, Err(VaultError::KeyRejected)));
        };
        reject(unwrap_vmk(
            &[4; KEY_LEN],
            &VAULT,
            &SLOT,
            1,
            &nonce,
            &wrapped,
        )); // wrong KEK
        reject(unwrap_vmk(&kek, &[0; ID_LEN], &SLOT, 1, &nonce, &wrapped)); // other vault
        reject(unwrap_vmk(&kek, &VAULT, &[0; ID_LEN], 1, &nonce, &wrapped)); // other slot
        reject(unwrap_vmk(&kek, &VAULT, &SLOT, 2, &nonce, &wrapped)); // other format version
        for i in 0..NONCE_LEN {
            let mut n = nonce;
            n[i] ^= 1;
            reject(unwrap_vmk(&kek, &VAULT, &SLOT, 1, &n, &wrapped));
        }
        for i in 0..WRAPPED_LEN {
            let mut w = wrapped;
            w[i] ^= 0x80;
            reject(unwrap_vmk(&kek, &VAULT, &SLOT, 1, &nonce, &w));
        }
    }

    #[test]
    fn padding_buckets() {
        assert_eq!(padded_len(0), 256);
        assert_eq!(padded_len(252), 256);
        assert_eq!(padded_len(253), 512);
        let key = [8u8; KEY_LEN];
        for (len, ct_len) in [(0, 272), (252, 272), (253, 528), (1000, 1040)] {
            let (_, ct) = seal(&key, &vec![0xAA; len]);
            assert_eq!(ct.len(), ct_len, "payload {len}");
        }
        assert!(PayloadBuf::new(MAX_PAYLOAD + 1).is_err());
    }

    #[test]
    fn record_bindings() {
        let key = [8u8; KEY_LEN];
        let (nonce, ct) = seal(&key, b"hello");
        let open = |k: &[u8; KEY_LEN], v: &[u8; ID_LEN], r: &[u8; ID_LEN], s: u16| {
            open_record(k, v, r, s, &nonce, &ct)
        };
        assert_eq!(open(&key, &VAULT, &RECORD, 1).unwrap().payload(), b"hello");
        for result in [
            open(&[7; KEY_LEN], &VAULT, &RECORD, 1),
            open(&key, &[0; ID_LEN], &RECORD, 1),
            open(&key, &VAULT, &[0; ID_LEN], 1),
            open(&key, &VAULT, &RECORD, 2),
        ] {
            assert!(matches!(result, Err(VaultError::Tampered(Tamper::Record))));
        }
        // Truncated / extended ciphertexts.
        for bad in [
            &ct[..ct.len() - 1],
            &ct[..ct.len() - 256],
            &[ct.as_slice(), &[0u8; 256]].concat(),
        ] {
            assert!(open_record(&key, &VAULT, &RECORD, 1, &nonce, bad).is_err());
        }
    }

    #[test]
    fn rejects_bad_padding_even_with_valid_tag() {
        // Hand-build a plaintext whose padding is non-zero and seal it directly.
        let key = [8u8; KEY_LEN];
        let mut buf = PayloadBuf::new(1).unwrap();
        buf.payload_mut()[0] = 1;
        buf.buf[100] = 0xFF; // corrupt the padding before encryption
        let (nonce, ct) = seal_record(&key, &VAULT, &RECORD, 1, buf).unwrap();
        assert!(open_record(&key, &VAULT, &RECORD, 1, &nonce, &ct).is_err());
        // And a length prefix pointing past the bucket.
        let mut buf = PayloadBuf::new(1).unwrap();
        buf.buf[..4].copy_from_slice(&300u32.to_be_bytes());
        let (nonce, ct) = seal_record(&key, &VAULT, &RECORD, 1, buf).unwrap();
        assert!(open_record(&key, &VAULT, &RECORD, 1, &nonce, &ct).is_err());
    }

    #[test]
    fn header_mac_verifies_and_detects_changes() {
        let key = [3u8; KEY_LEN];
        let tag = header_mac(&key, b"body");
        verify_header_mac(&key, b"body", &tag).unwrap();
        assert!(verify_header_mac(&key, b"Body", &tag).is_err());
        assert!(verify_header_mac(&[4; KEY_LEN], b"body", &tag).is_err());
        let mut t = tag;
        t[31] ^= 1;
        assert!(verify_header_mac(&key, b"body", &t).is_err());
    }

    #[test]
    fn manifest_covers_membership_order_and_content() {
        let key = [3u8; KEY_LEN];
        let (a_id, b_id) = ([1u8; ID_LEN], [2u8; ID_LEN]);
        let n = [0u8; NONCE_LEN];
        let a = ManifestEntry {
            id: &a_id,
            nonce: &n,
            ciphertext: b"aaa",
        };
        let b = ManifestEntry {
            id: &b_id,
            nonce: &n,
            ciphertext: b"bbb",
        };
        let tag = manifest_mac(&key, 1, &VAULT, &[a, b]).unwrap();
        let entries = |ct_b: &'static [u8]| {
            vec![
                ManifestEntry {
                    id: &a_id,
                    nonce: &n,
                    ciphertext: b"aaa",
                },
                ManifestEntry {
                    id: &b_id,
                    nonce: &n,
                    ciphertext: ct_b,
                },
            ]
        };
        verify_manifest_mac(&key, 1, &VAULT, &entries(b"bbb"), &tag).unwrap();
        assert!(verify_manifest_mac(&key, 1, &VAULT, &entries(b"bbc"), &tag).is_err()); // changed
        let only_a = [ManifestEntry {
            id: &a_id,
            nonce: &n,
            ciphertext: b"aaa",
        }];
        assert!(verify_manifest_mac(&key, 1, &VAULT, &only_a, &tag).is_err()); // deleted
        assert!(verify_manifest_mac(&key, 1, &[9; ID_LEN], &entries(b"bbb"), &tag).is_err()); // other vault
        let reversed = [
            ManifestEntry {
                id: &b_id,
                nonce: &n,
                ciphertext: b"bbb",
            },
            ManifestEntry {
                id: &a_id,
                nonce: &n,
                ciphertext: b"aaa",
            },
        ];
        assert!(matches!(
            manifest_mac(&key, 1, &VAULT, &reversed),
            Err(VaultError::Corrupt(_))
        ));
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        #[test]
        fn record_round_trip(payload in proptest::collection::vec(any::<u8>(), 0..3000)) {
            let key = [8u8; KEY_LEN];
            let (nonce, ct) = seal(&key, &payload);
            prop_assert_eq!((ct.len() - TAG_LEN) % PAD_BUCKET, 0);
            let pt = open_record(&key, &VAULT, &RECORD, 1, &nonce, &ct).unwrap();
            prop_assert_eq!(pt.payload(), payload.as_slice());
        }

        #[test]
        fn any_single_bit_flip_fails_closed(
            payload in proptest::collection::vec(any::<u8>(), 0..600),
            index in any::<prop::sample::Index>(),
            bit in 0u8..8,
            in_nonce in any::<bool>(),
        ) {
            let key = [8u8; KEY_LEN];
            let (mut nonce, mut ct) = seal(&key, &payload);
            if in_nonce {
                nonce[index.index(NONCE_LEN)] ^= 1 << bit;
            } else {
                let i = index.index(ct.len());
                ct[i] ^= 1 << bit;
            }
            prop_assert!(open_record(&key, &VAULT, &RECORD, 1, &nonce, &ct).is_err());
        }
    }
}
