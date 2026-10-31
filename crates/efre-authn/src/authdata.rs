//! WebAuthn authenticator data: strict parsing and efre's checks
//! (ARCHITECTURE §4.5 check 5–6 and §4.6 response checks).
//!
//! Layout: `rpIdHash (32) || flags (1) || signCount (u32 BE) || [attestedCredentialData]
//! || [extensions]`, where attested credential data is `aaguid (16) || credIdLen (u16 BE)
//! || credId || credentialPublicKey (one CBOR item)` and extensions are one CBOR map.

use minicbor::Decoder;
use minicbor::data::Type;
use sha2::{Digest, Sha256};

use crate::{AuthnError, MAX_CREDENTIAL_ID_LEN, RP_ID};

/// User present.
pub const FLAG_UP: u8 = 0x01;
/// User verified.
pub const FLAG_UV: u8 = 0x04;
/// Backup eligible (a syncable passkey).
pub const FLAG_BE: u8 = 0x08;
/// Backed up.
pub const FLAG_BS: u8 = 0x10;
/// Attested credential data included.
pub const FLAG_AT: u8 = 0x40;
/// Extension data included.
pub const FLAG_ED: u8 = 0x80;

const HEADER_LEN: usize = 32 + 1 + 4;

/// Parsed authenticator data, borrowing from the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthData<'a> {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub sign_count: u32,
    pub attested: Option<AttestedCredential<'a>>,
    pub extensions: Extensions,
}

/// Attested credential data (present when `FLAG_AT` is set).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestedCredential<'a> {
    pub aaguid: [u8; 16],
    pub credential_id: &'a [u8],
    /// The COSE public key, exactly as encoded (one CBOR map).
    pub public_key_cbor: &'a [u8],
}

/// The authenticator extension outputs efre cares about. Unknown extensions are ignored.
#[derive(Default, Debug, Clone, Copy, PartialEq, Eq)]
pub struct Extensions {
    pub hmac_secret: Option<bool>,
    pub cred_protect: Option<u8>,
}

fn invalid(what: &'static str) -> AuthnError {
    AuthnError::InvalidResponse(what)
}

/// Parses authenticator data strictly: the AT/ED flags must match the data that is
/// present, the credential id must be 1..=1023 bytes, the public key must be one CBOR
/// map, the extensions one CBOR map with no duplicate keys, and nothing may follow.
pub fn parse(bytes: &[u8]) -> Result<AuthData<'_>, AuthnError> {
    if bytes.len() < HEADER_LEN {
        return Err(invalid("authenticator data too short"));
    }
    let mut rp_id_hash = [0u8; 32];
    rp_id_hash.copy_from_slice(&bytes[..32]);
    let flags = bytes[32];
    let sign_count = u32::from_be_bytes([bytes[33], bytes[34], bytes[35], bytes[36]]);
    let mut rest = &bytes[HEADER_LEN..];

    let attested = if flags & FLAG_AT != 0 {
        if rest.len() < 18 {
            return Err(invalid("attested credential data truncated"));
        }
        let mut aaguid = [0u8; 16];
        aaguid.copy_from_slice(&rest[..16]);
        let id_len = usize::from(u16::from_be_bytes([rest[16], rest[17]]));
        if id_len == 0 || id_len > MAX_CREDENTIAL_ID_LEN {
            return Err(invalid("credential id length"));
        }
        rest = &rest[18..];
        if rest.len() < id_len {
            return Err(invalid("credential id truncated"));
        }
        let (credential_id, after_id) = rest.split_at(id_len);
        let mut d = Decoder::new(after_id);
        if d.datatype().map_err(|_| invalid("credential public key"))? != Type::Map {
            return Err(invalid("credential public key"));
        }
        d.skip().map_err(|_| invalid("credential public key"))?;
        let (public_key_cbor, after_key) = after_id.split_at(d.position());
        rest = after_key;
        Some(AttestedCredential {
            aaguid,
            credential_id,
            public_key_cbor,
        })
    } else {
        None
    };

    let extensions = if flags & FLAG_ED != 0 {
        let mut d = Decoder::new(rest);
        let extensions = parse_extensions(&mut d)?;
        rest = &rest[d.position()..];
        extensions
    } else {
        Extensions::default()
    };

    if !rest.is_empty() {
        return Err(invalid("trailing bytes after authenticator data"));
    }
    Ok(AuthData {
        rp_id_hash,
        flags,
        sign_count,
        attested,
        extensions,
    })
}

fn parse_extensions(d: &mut Decoder<'_>) -> Result<Extensions, AuthnError> {
    let bad = || invalid("extensions");
    let len = d.map().map_err(|_| bad())?.ok_or_else(bad)?; // definite length only
    let mut out = Extensions::default();
    let mut seen: Vec<&str> = Vec::new();
    for _ in 0..len {
        let key = d.str().map_err(|_| bad())?;
        if seen.contains(&key) {
            return Err(invalid("duplicate extension"));
        }
        seen.push(key);
        match key {
            "hmac-secret" => out.hmac_secret = Some(d.bool().map_err(|_| bad())?),
            "credProtect" => out.cred_protect = Some(d.u8().map_err(|_| bad())?),
            _ => d.skip().map_err(|_| bad())?,
        }
    }
    Ok(out)
}

/// SHA-256 of efre's RP ID, as it must appear in every authenticator data.
pub fn rp_id_hash() -> [u8; 32] {
    Sha256::digest(RP_ID.as_bytes()).into()
}

fn check_common(auth: &AuthData<'_>) -> Result<(), AuthnError> {
    if auth.rp_id_hash != rp_id_hash() {
        return Err(invalid("relying party id hash"));
    }
    if auth.flags & FLAG_UP == 0 {
        return Err(invalid("user presence not asserted"));
    }
    if auth.flags & FLAG_UV == 0 {
        return Err(invalid("user verification not performed"));
    }
    Ok(())
}

/// Checks a MakeCredential result (ARCHITECTURE §4.5 checks 5 and 6).
///
/// * RP ID hash, UP, UV, AT and ED; BE/BS must be clear (not a syncable passkey).
/// * The credential id must be the one Windows reported.
/// * `hmac-secret` must be `true`. If it is missing, Windows dropped the extension for
///   a non-discoverable credential (ARCHITECTURE §4.4, D1): `UnsupportedPlatform`.
/// * `credProtect` must be 3 (userVerificationRequired). Missing also means the
///   platform did not pass the extension through (`UnsupportedPlatform`); any other
///   level is a refused credential (`AttestationRejected`).
pub fn check_registration(
    auth: &AuthData<'_>,
    expected_credential_id: &[u8],
) -> Result<(), AuthnError> {
    check_common(auth)?;
    if auth.flags & FLAG_AT == 0 {
        return Err(invalid("attested credential data missing"));
    }
    if auth.flags & FLAG_ED == 0 {
        return Err(AuthnError::UnsupportedPlatform);
    }
    if auth.flags & (FLAG_BE | FLAG_BS) != 0 {
        return Err(AuthnError::AttestationRejected(
            "backup-eligible credential",
        ));
    }
    let attested = auth
        .attested
        .as_ref()
        .ok_or_else(|| invalid("attested credential data missing"))?;
    if attested.credential_id != expected_credential_id {
        return Err(invalid("credential id mismatch"));
    }
    match auth.extensions.hmac_secret {
        Some(true) => {}
        Some(false) | None => return Err(AuthnError::UnsupportedPlatform),
    }
    match auth.extensions.cred_protect {
        Some(3) => Ok(()),
        None => Err(AuthnError::UnsupportedPlatform),
        Some(_) => Err(AuthnError::AttestationRejected("credProtect level")),
    }
}

/// Checks a GetAssertion result (ARCHITECTURE §4.6): RP ID hash, UP and UV.
pub fn check_assertion(auth: &AuthData<'_>) -> Result<(), AuthnError> {
    check_common(auth)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use minicbor::Encoder;
    use proptest::prelude::*;

    /// A minimal COSE EC2 key map (content is irrelevant to the parser).
    pub(crate) fn cose_key() -> Vec<u8> {
        let mut e = Encoder::new(Vec::new());
        e.map(3).unwrap();
        e.i8(1).unwrap().i8(2).unwrap();
        e.i8(3).unwrap().i8(-7).unwrap();
        e.i8(-1).unwrap().i8(1).unwrap();
        e.into_writer()
    }

    pub(crate) fn extensions(entries: &[(&str, ExtValue)]) -> Vec<u8> {
        let mut e = Encoder::new(Vec::new());
        e.map(entries.len() as u64).unwrap();
        for (k, v) in entries {
            e.str(k).unwrap();
            match v {
                ExtValue::Bool(b) => e.bool(*b).unwrap(),
                ExtValue::Int(i) => e.u8(*i).unwrap(),
                ExtValue::Text(t) => e.str(t).unwrap(),
            };
        }
        e.into_writer()
    }

    #[derive(Clone, Copy)]
    pub(crate) enum ExtValue {
        Bool(bool),
        Int(u8),
        Text(&'static str),
    }

    pub(crate) const CRED: &[u8] = &[0xC7; 64];
    pub(crate) const AAGUID: [u8; 16] = [0xAA; 16];

    /// Builds authenticator data as a YubiKey would for an efre enrollment.
    pub(crate) fn build(flags: u8, cred: Option<&[u8]>, ext: Option<Vec<u8>>) -> Vec<u8> {
        let mut out = rp_id_hash().to_vec();
        out.push(flags);
        out.extend_from_slice(&7u32.to_be_bytes());
        if let Some(cred) = cred {
            out.extend_from_slice(&AAGUID);
            out.extend_from_slice(&(cred.len() as u16).to_be_bytes());
            out.extend_from_slice(cred);
            out.extend_from_slice(&cose_key());
        }
        if let Some(ext) = ext {
            out.extend_from_slice(&ext);
        }
        out
    }

    fn good_ext() -> Vec<u8> {
        extensions(&[
            ("credProtect", ExtValue::Int(3)),
            ("hmac-secret", ExtValue::Bool(true)),
        ])
    }

    const REG_FLAGS: u8 = FLAG_UP | FLAG_UV | FLAG_AT | FLAG_ED;

    #[test]
    fn efre_rp_id_hash() {
        assert_eq!(rp_id_hash().to_vec(), Sha256::digest(b"efre:").to_vec());
    }

    #[test]
    fn parses_a_registration() {
        let bytes = build(REG_FLAGS, Some(CRED), Some(good_ext()));
        let auth = parse(&bytes).unwrap();
        assert_eq!(auth.sign_count, 7);
        let att = auth.attested.as_ref().unwrap();
        assert_eq!(att.aaguid, AAGUID);
        assert_eq!(att.credential_id, CRED);
        assert_eq!(att.public_key_cbor, cose_key().as_slice());
        assert_eq!(
            auth.extensions,
            Extensions {
                hmac_secret: Some(true),
                cred_protect: Some(3)
            }
        );
        check_registration(&auth, CRED).unwrap();
    }

    #[test]
    fn parses_an_assertion() {
        let bytes = build(FLAG_UP | FLAG_UV, None, None);
        let auth = parse(&bytes).unwrap();
        assert!(auth.attested.is_none());
        check_assertion(&auth).unwrap();
        for flags in [FLAG_UP, FLAG_UV, 0] {
            let bytes = build(flags, None, None);
            assert!(check_assertion(&parse(&bytes).unwrap()).is_err());
        }
        let mut other_rp = build(FLAG_UP | FLAG_UV, None, None);
        other_rp[0] ^= 1;
        assert!(check_assertion(&parse(&other_rp).unwrap()).is_err());
    }

    #[test]
    fn registration_rules() {
        let check = |flags: u8, ext: Option<Vec<u8>>, expected: &[u8]| {
            let bytes = build(flags, Some(CRED), ext);
            check_registration(&parse(&bytes).unwrap(), expected)
        };
        assert!(check(REG_FLAGS, Some(good_ext()), CRED).is_ok());
        // Missing UP / UV.
        assert!(check(REG_FLAGS & !FLAG_UP, Some(good_ext()), CRED).is_err());
        assert!(check(REG_FLAGS & !FLAG_UV, Some(good_ext()), CRED).is_err());
        // Syncable passkey.
        assert!(matches!(
            check(REG_FLAGS | FLAG_BE, Some(good_ext()), CRED),
            Err(AuthnError::AttestationRejected(_))
        ));
        assert!(check(REG_FLAGS | FLAG_BS, Some(good_ext()), CRED).is_err());
        // Different credential id.
        assert!(matches!(
            check(REG_FLAGS, Some(good_ext()), &[1, 2, 3]),
            Err(AuthnError::InvalidResponse(_))
        ));
        // No extensions at all: Windows dropped them (D1).
        assert_eq!(
            check(REG_FLAGS & !FLAG_ED, None, CRED),
            Err(AuthnError::UnsupportedPlatform)
        );
        // hmac-secret missing or false.
        for ext in [
            extensions(&[("credProtect", ExtValue::Int(3))]),
            extensions(&[
                ("credProtect", ExtValue::Int(3)),
                ("hmac-secret", ExtValue::Bool(false)),
            ]),
        ] {
            assert_eq!(
                check(REG_FLAGS, Some(ext), CRED),
                Err(AuthnError::UnsupportedPlatform)
            );
        }
        // credProtect missing, or a weaker level.
        assert_eq!(
            check(
                REG_FLAGS,
                Some(extensions(&[("hmac-secret", ExtValue::Bool(true))])),
                CRED
            ),
            Err(AuthnError::UnsupportedPlatform)
        );
        for level in [1, 2] {
            let ext = extensions(&[
                ("credProtect", ExtValue::Int(level)),
                ("hmac-secret", ExtValue::Bool(true)),
            ]);
            assert!(matches!(
                check(REG_FLAGS, Some(ext), CRED),
                Err(AuthnError::AttestationRejected(_))
            ));
        }
        // Unknown extensions are ignored.
        let ext = extensions(&[
            ("credProtect", ExtValue::Int(3)),
            ("hmac-secret", ExtValue::Bool(true)),
            ("minPinLength", ExtValue::Int(6)),
            ("x-vendor", ExtValue::Text("y")),
        ]);
        assert!(check(REG_FLAGS, Some(ext), CRED).is_ok());
    }

    #[test]
    fn strict_parsing() {
        let good = build(REG_FLAGS, Some(CRED), Some(good_ext()));
        // Trailing byte.
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(parse(&trailing).is_err());
        // Truncated anywhere.
        for len in 0..good.len() {
            assert!(parse(&good[..len]).is_err(), "truncated at {len}");
        }
        // AT set without data / data without AT.
        assert!(parse(&build(FLAG_UP | FLAG_UV | FLAG_AT, None, None)).is_err());
        assert!(parse(&build(FLAG_UP | FLAG_UV, Some(CRED), None)).is_err());
        // ED set without extensions / extensions without ED.
        assert!(parse(&build(FLAG_UP | FLAG_UV | FLAG_ED, None, None)).is_err());
        assert!(parse(&build(FLAG_UP | FLAG_UV, None, Some(good_ext()))).is_err());
        // Credential id lengths.
        assert!(parse(&build(REG_FLAGS, Some(&[]), Some(good_ext()))).is_err());
        assert!(parse(&build(REG_FLAGS, Some(&[1; 1024]), Some(good_ext()))).is_err());
        assert!(parse(&build(REG_FLAGS, Some(&[1; 1023]), Some(good_ext()))).is_ok());
        // Duplicate extension key, wrong value types, indefinite map, non-map.
        for ext in [
            extensions(&[
                ("hmac-secret", ExtValue::Bool(true)),
                ("hmac-secret", ExtValue::Bool(true)),
            ]),
            extensions(&[("hmac-secret", ExtValue::Int(1))]),
            extensions(&[("credProtect", ExtValue::Bool(true))]),
            vec![0xBF, 0xFF],
            vec![0x80],
            vec![0xA1, 0x01, 0x02],
        ] {
            assert!(parse(&build(REG_FLAGS, Some(CRED), Some(ext))).is_err());
        }
    }

    #[test]
    fn public_key_must_be_a_map() {
        let mut bytes = rp_id_hash().to_vec();
        bytes.push(FLAG_UP | FLAG_UV | FLAG_AT);
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&AAGUID);
        bytes.extend_from_slice(&1u16.to_be_bytes());
        bytes.push(9);
        bytes.push(0x80); // an empty array instead of a COSE map
        assert!(parse(&bytes).is_err());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn parse_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = parse(&bytes);
        }

        #[test]
        fn parse_never_panics_near_valid(index in any::<prop::sample::Index>(), byte in any::<u8>()) {
            let mut bytes = build(REG_FLAGS, Some(CRED), Some(good_ext()));
            let i = index.index(bytes.len());
            bytes[i] = byte;
            if let Ok(auth) = parse(&bytes) {
                let _ = check_registration(&auth, CRED);
            }
        }
    }
}
