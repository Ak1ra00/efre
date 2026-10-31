//! WebAuthn attestation objects and "packed" attestation verification against pinned
//! Yubico FIDO attestation CAs (ARCHITECTURE §4.5 checks 1–4).
//!
//! What `verify_packed` checks, all offline:
//! * `alg` is ES256 (-7) and the statement carries a certificate chain (no self
//!   attestation);
//! * the chain `x5c[0]` (+ `x5c[1..]` as candidate intermediates) builds to one of the
//!   pinned anchors in `roots/` with `rustls-webpki`: every signature on the path,
//!   validity periods at `now_unix`, basic constraints and path length (an end-entity
//!   certificate may not be a CA), name chaining, and rejection of unknown critical
//!   extensions;
//! * the attestation signature over `authData || clientDataHash` verifies with
//!   `x5c[0]`'s P-256 key;
//! * `x5c[0]` meets the WebAuthn packed certificate requirements efre relies on: its
//!   subject OU is "Authenticator Attestation", and it carries the FIDO AAGUID
//!   extension (1.3.6.1.4.1.45724.1.1.4), equal to the authenticator data's AAGUID.
//!   The extension is mandatory here (WebAuthn §8.2.1 requires it whenever a root is
//!   shared by several models, which is true of every Yubico root).
//!
//! What it does not check: revocation (no network, ever), Extended Key Usage (any
//! EKU, or none, is accepted: Yubico's attestation certificates do not use EKU and the
//! anchors themselves are FIDO-only), and certificate policies.

use minicbor::Decoder;
use minicbor::data::Type;
use rustls_pki_types::{CertificateDer, SignatureVerificationAlgorithm, TrustAnchor, UnixTime};
use webpki::{EndEntityCert, ExtendedKeyUsageValidator, KeyPurposeIdIter};

use crate::AuthnError;

/// A WebAuthn attestation object (`fmt`, `attStmt`, `authData`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttestationObject<'a> {
    pub fmt: &'a str,
    /// The parsed statement for `fmt == "packed"`; `None` for any other format.
    pub stmt: Option<PackedStatement<'a>>,
    pub auth_data: &'a [u8],
}

/// A "packed" attestation statement. `x5c` is empty for self attestation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackedStatement<'a> {
    pub alg: i64,
    pub sig: &'a [u8],
    pub x5c: Vec<&'a [u8]>,
}

/// COSE ES256 (ECDSA P-256 with SHA-256).
const ES256: i64 = -7;
/// Upper bound on certificates in `x5c`.
const MAX_X5C: usize = 8;

fn invalid() -> AuthnError {
    AuthnError::InvalidResponse("attestation object")
}

/// Parses an attestation object strictly: a definite-length CBOR map with text keys,
/// no duplicates, `fmt`/`attStmt`/`authData` all present, nothing after the map.
pub fn parse_attestation_object(bytes: &[u8]) -> Result<AttestationObject<'_>, AuthnError> {
    let mut d = Decoder::new(bytes);
    let len = d.map().map_err(|_| invalid())?.ok_or_else(invalid)?;
    let (mut fmt, mut auth_data, mut stmt_start) = (None, None, None);
    let mut seen: Vec<&str> = Vec::new();
    for _ in 0..len {
        let key = d.str().map_err(|_| invalid())?;
        if seen.contains(&key) {
            return Err(invalid());
        }
        seen.push(key);
        match key {
            "fmt" => fmt = Some(d.str().map_err(|_| invalid())?),
            "authData" => auth_data = Some(d.bytes().map_err(|_| invalid())?),
            "attStmt" => {
                if d.datatype().map_err(|_| invalid())? != Type::Map {
                    return Err(invalid());
                }
                stmt_start = Some(d.position());
                d.skip().map_err(|_| invalid())?;
            }
            _ => d.skip().map_err(|_| invalid())?,
        }
    }
    if d.position() != bytes.len() {
        return Err(invalid());
    }
    let fmt = fmt.ok_or_else(invalid)?;
    let auth_data = auth_data.ok_or_else(invalid)?;
    let stmt_start = stmt_start.ok_or_else(invalid)?;
    let stmt = if fmt == "packed" {
        Some(parse_packed(&bytes[stmt_start..])?)
    } else {
        None
    };
    Ok(AttestationObject {
        fmt,
        stmt,
        auth_data,
    })
}

fn parse_packed(bytes: &[u8]) -> Result<PackedStatement<'_>, AuthnError> {
    let mut d = Decoder::new(bytes);
    let len = d.map().map_err(|_| invalid())?.ok_or_else(invalid)?;
    let (mut alg, mut sig, mut x5c) = (None, None, None);
    let mut seen: Vec<&str> = Vec::new();
    for _ in 0..len {
        let key = d.str().map_err(|_| invalid())?;
        if seen.contains(&key) {
            return Err(invalid());
        }
        seen.push(key);
        match key {
            "alg" => alg = Some(d.i64().map_err(|_| invalid())?),
            "sig" => sig = Some(d.bytes().map_err(|_| invalid())?),
            "x5c" => {
                let n = d.array().map_err(|_| invalid())?.ok_or_else(invalid)?;
                let n = usize::try_from(n).map_err(|_| invalid())?;
                if n == 0 || n > MAX_X5C {
                    return Err(invalid());
                }
                let mut certs = Vec::with_capacity(n);
                for _ in 0..n {
                    certs.push(d.bytes().map_err(|_| invalid())?);
                }
                x5c = Some(certs);
            }
            // ECDAA and anything else is not supported.
            _ => return Err(invalid()),
        }
    }
    Ok(PackedStatement {
        alg: alg.ok_or_else(invalid)?,
        sig: sig.ok_or_else(invalid)?,
        x5c: x5c.unwrap_or_default(),
    })
}

/// Yubico FIDO attestation CAs efre trusts. See `roots/README.md` for sources and
/// fingerprints; `tests::pinned_fingerprints` asserts them.
const PINNED: &[&[u8]] = &[
    include_bytes!("roots/yubico-u2f-root-ca-serial-457200631.der"),
    include_bytes!("roots/yubico-fido-root-ca-serial-450203556.der"),
    include_bytes!("roots/yubico-fido-attestation-a-1.der"),
    include_bytes!("roots/yubico-fido-attestation-b-1.der"),
    include_bytes!("roots/yubico-fido-attestation-b2-1.der"),
];

/// Signature algorithms accepted on certificate paths.
static CHAIN_ALGS: &[&dyn SignatureVerificationAlgorithm] = &[
    webpki::ring::ECDSA_P256_SHA256,
    webpki::ring::ECDSA_P256_SHA384,
    webpki::ring::ECDSA_P384_SHA256,
    webpki::ring::ECDSA_P384_SHA384,
    webpki::ring::ED25519,
    webpki::ring::RSA_PKCS1_2048_8192_SHA256,
    webpki::ring::RSA_PKCS1_2048_8192_SHA384,
    webpki::ring::RSA_PKCS1_2048_8192_SHA512,
];

/// Accepts any EKU (or none); see the module documentation.
struct AnyEku;

impl ExtendedKeyUsageValidator for AnyEku {
    fn validate(&self, iter: KeyPurposeIdIter<'_, '_>) -> Result<(), webpki::Error> {
        // Still reject a malformed EKU extension.
        for purpose in iter {
            purpose?;
        }
        Ok(())
    }
}

fn rejected(reason: &'static str) -> AuthnError {
    AuthnError::AttestationRejected(reason)
}

/// Verifies a "packed" attestation statement against the pinned Yubico anchors.
pub fn verify_packed(
    stmt: &PackedStatement<'_>,
    auth_data: &[u8],
    client_data_hash: &[u8; 32],
    aaguid: &[u8; 16],
    now_unix: u64,
) -> Result<(), AuthnError> {
    verify_packed_with(PINNED, stmt, auth_data, client_data_hash, aaguid, now_unix)
}

fn verify_packed_with(
    anchors_der: &[&[u8]],
    stmt: &PackedStatement<'_>,
    auth_data: &[u8],
    client_data_hash: &[u8; 32],
    aaguid: &[u8; 16],
    now_unix: u64,
) -> Result<(), AuthnError> {
    if stmt.alg != ES256 {
        return Err(rejected("attestation algorithm is not ES256"));
    }
    let (leaf, intermediates) = stmt
        .x5c
        .split_first()
        .ok_or_else(|| rejected("self attestation"))?;
    if anchors_der.is_empty() {
        return Err(rejected("no trusted attestation roots"));
    }
    let anchor_certs: Vec<CertificateDer<'_>> = anchors_der
        .iter()
        .map(|d| CertificateDer::from(*d))
        .collect();
    let anchors: Vec<TrustAnchor<'_>> = anchor_certs
        .iter()
        .map(webpki::anchor_from_trusted_cert)
        .collect::<Result<_, _>>()
        .map_err(|_| rejected("invalid pinned root"))?;
    let intermediates: Vec<CertificateDer<'_>> = intermediates
        .iter()
        .map(|d| CertificateDer::from(*d))
        .collect();
    let leaf_der = CertificateDer::from(*leaf);
    let ee = EndEntityCert::try_from(&leaf_der).map_err(|_| rejected("malformed certificate"))?;
    ee.verify_for_usage(
        CHAIN_ALGS,
        &anchors,
        &intermediates,
        UnixTime::since_unix_epoch(core::time::Duration::from_secs(now_unix)),
        AnyEku,
        None,
        None,
    )
    .map_err(|_| rejected("certificate does not chain to a Yubico FIDO root"))?;

    let mut signed = Vec::with_capacity(auth_data.len() + client_data_hash.len());
    signed.extend_from_slice(auth_data);
    signed.extend_from_slice(client_data_hash);
    ee.verify_signature(webpki::ring::ECDSA_P256_SHA256, &signed, stmt.sig)
        .map_err(|_| rejected("attestation signature"))?;

    let fields = der::leaf_fields(leaf).map_err(|_| rejected("malformed certificate"))?;
    if !fields.ou_authenticator_attestation {
        return Err(rejected(
            "certificate subject is not an authenticator attestation",
        ));
    }
    match fields.aaguid {
        Some(cert_aaguid) if &cert_aaguid == aaguid => Ok(()),
        Some(_) => Err(rejected("certificate AAGUID does not match")),
        None => Err(rejected("certificate has no AAGUID extension")),
    }
}

/// Minimal DER reading for the two certificate fields webpki does not expose. Runs
/// only on a certificate webpki has already parsed and path-validated.
mod der {
    pub(super) struct LeafFields {
        pub(super) ou_authenticator_attestation: bool,
        pub(super) aaguid: Option<[u8; 16]>,
    }

    #[derive(Debug)]
    pub(super) struct Malformed;

    const SEQUENCE: u8 = 0x30;
    const SET: u8 = 0x31;
    const OID: u8 = 0x06;
    const OCTET_STRING: u8 = 0x04;
    const BOOLEAN: u8 = 0x01;
    const EXTENSIONS: u8 = 0xA3; // [3] EXPLICIT
    /// 2.5.4.11 organizationalUnitName.
    const OU: &[u8] = &[0x55, 0x04, 0x0B];
    /// 1.3.6.1.4.1.45724.1.1.4 id-fido-gen-ce-aaguid.
    const FIDO_AAGUID: &[u8] = &[
        0x2B, 0x06, 0x01, 0x04, 0x01, 0x82, 0xE5, 0x1C, 0x01, 0x01, 0x04,
    ];
    const ATTESTATION_OU: &[u8] = b"Authenticator Attestation";

    /// Reads one TLV, returning `(tag, value, rest)`.
    fn tlv(input: &[u8]) -> Result<(u8, &[u8], &[u8]), Malformed> {
        let (&tag, rest) = input.split_first().ok_or(Malformed)?;
        let (&first, rest) = rest.split_first().ok_or(Malformed)?;
        let (len, rest) = if first < 0x80 {
            (usize::from(first), rest)
        } else {
            let n = usize::from(first & 0x7F);
            if n == 0 || n > 4 || rest.len() < n {
                return Err(Malformed);
            }
            let len = rest[..n]
                .iter()
                .fold(0usize, |acc, &b| (acc << 8) | usize::from(b));
            (len, &rest[n..])
        };
        if rest.len() < len {
            return Err(Malformed);
        }
        let (value, rest) = rest.split_at(len);
        Ok((tag, value, rest))
    }

    fn expect(input: &[u8], tag: u8) -> Result<(&[u8], &[u8]), Malformed> {
        let (t, value, rest) = tlv(input)?;
        if t != tag {
            return Err(Malformed);
        }
        Ok((value, rest))
    }

    pub(super) fn leaf_fields(cert: &[u8]) -> Result<LeafFields, Malformed> {
        let (certificate, _) = expect(cert, SEQUENCE)?;
        let (tbs, _) = expect(certificate, SEQUENCE)?;
        let mut rest = tbs;
        // [0] version (optional), serialNumber, signature, issuer, validity, subject, spki.
        let (tag, _, after) = tlv(rest)?;
        if tag == 0xA0 {
            rest = after;
        }
        for _ in 0..4 {
            rest = tlv(rest)?.2; // serial, signature, issuer, validity
        }
        let (subject, after_subject) = expect(rest, SEQUENCE)?;
        rest = tlv(after_subject)?.2; // subjectPublicKeyInfo
        let ou_authenticator_attestation = subject_has_ou(subject)?;

        let mut aaguid = None;
        while !rest.is_empty() {
            let (tag, value, after) = tlv(rest)?;
            rest = after;
            if tag != EXTENSIONS {
                continue; // issuerUniqueID / subjectUniqueID
            }
            let (mut exts, _) = expect(value, SEQUENCE)?;
            while !exts.is_empty() {
                let (ext, after_ext) = expect(exts, SEQUENCE)?;
                exts = after_ext;
                let (oid, mut body) = expect(ext, OID)?;
                if let Ok((BOOLEAN, _, after_crit)) = tlv(body) {
                    body = after_crit;
                }
                let (extn_value, _) = expect(body, OCTET_STRING)?;
                if oid == FIDO_AAGUID {
                    if aaguid.is_some() {
                        return Err(Malformed); // duplicate extension
                    }
                    let (inner, trailing) = expect(extn_value, OCTET_STRING)?;
                    if !trailing.is_empty() {
                        return Err(Malformed);
                    }
                    aaguid = Some(inner.try_into().map_err(|_| Malformed)?);
                }
            }
        }
        Ok(LeafFields {
            ou_authenticator_attestation,
            aaguid,
        })
    }

    fn subject_has_ou(mut name: &[u8]) -> Result<bool, Malformed> {
        let mut found = false;
        while !name.is_empty() {
            let (mut rdn, after) = expect(name, SET)?;
            name = after;
            while !rdn.is_empty() {
                let (atv, after_atv) = expect(rdn, SEQUENCE)?;
                rdn = after_atv;
                let (oid, value) = expect(atv, OID)?;
                let (tag, text, _) = tlv(value)?;
                // UTF8String or PrintableString.
                if oid == OU && (tag == 0x0C || tag == 0x13) && text == ATTESTATION_OU {
                    found = true;
                }
            }
        }
        Ok(found)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authdata;
    use proptest::prelude::*;
    use sha2::{Digest, Sha256};

    /// Real YubiKey 5Ci registration ("packed", chains to Yubico U2F Root CA Serial
    /// 457200631), from webauthn-rs-core 0.5.5 `test_registration_ipados_5ci`
    /// (MPL-2.0, https://github.com/kanidm/webauthn-rs). RP id 172.20.0.141.
    const YK5CI_ATTESTATION: &[u8] =
        include_bytes!("../tests/fixtures/yubikey-5ci-packed-attestation-object.cbor");
    const YK5CI_CLIENT_DATA: &[u8] =
        include_bytes!("../tests/fixtures/yubikey-5ci-client-data.json");
    /// YubiKey 5Ci AAGUID c5ef55ff-ad9a-4b9f-b580-adebafe026d0.
    const YK5CI_AAGUID: [u8; 16] = [
        0xC5, 0xEF, 0x55, 0xFF, 0xAD, 0x9A, 0x4B, 0x9F, 0xB5, 0x80, 0xAD, 0xEB, 0xAF, 0xE0, 0x26,
        0xD0,
    ];
    /// 2026-10-31T00:00:00Z, inside every pinned certificate's validity.
    const NOW: u64 = 1_793_404_800;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn fixture() -> (AttestationObject<'static>, [u8; 32]) {
        let obj = parse_attestation_object(YK5CI_ATTESTATION).unwrap();
        let cdh: [u8; 32] = Sha256::digest(YK5CI_CLIENT_DATA).into();
        (obj, cdh)
    }

    #[test]
    fn pinned_fingerprints() {
        let expected = [
            // Yubico U2F Root CA Serial 457200631
            "0fa1386f80eb8713263ae5c1d84deb455bdf08aea50ab05503cefee82b092d42",
            // Yubico FIDO Root CA Serial 450203556
            "35f1a54b353bfb711e6d42adbeb76c0e9dead095018e6a94783ba2192fd6faad",
            // Yubico FIDO Attestation A 1
            "4ebabc9cbc964f722c985f3784d057e9ef5dcf454dcb4f767fccca58cf16a4e8",
            // Yubico FIDO Attestation B 1
            "4eadda86ff62cff987e111a07910d8554de42f71d5d6da7744610e09012dd319",
            // Yubico FIDO Attestation B2 1
            "3c6fe819adbd80afe75dc90af7bba34c95b2b7ac64384816e033f63b7c93848b",
        ];
        assert_eq!(PINNED.len(), expected.len());
        for (der, fp) in PINNED.iter().zip(expected) {
            assert_eq!(hex(&Sha256::digest(der)), fp);
            webpki::anchor_from_trusted_cert(&CertificateDer::from(*der)).unwrap();
        }
    }

    #[test]
    fn parses_the_real_attestation_object() {
        let (obj, _) = fixture();
        assert_eq!(obj.fmt, "packed");
        let stmt = obj.stmt.as_ref().unwrap();
        assert_eq!(stmt.alg, -7);
        assert_eq!(stmt.x5c.len(), 1);
        let auth = authdata::parse(obj.auth_data).unwrap();
        assert_eq!(auth.attested.as_ref().unwrap().aaguid, YK5CI_AAGUID);
        // A web registration: not for efre's RP id, so efre's own checks refuse it.
        assert!(authdata::check_registration(&auth, &[0]).is_err());
    }

    #[test]
    fn verifies_a_real_yubikey_attestation() {
        let (obj, cdh) = fixture();
        let stmt = obj.stmt.as_ref().unwrap();
        verify_packed(stmt, obj.auth_data, &cdh, &YK5CI_AAGUID, NOW).unwrap();
        let fields = der::leaf_fields(stmt.x5c[0]).unwrap();
        assert!(fields.ou_authenticator_attestation);
        assert_eq!(fields.aaguid, Some(YK5CI_AAGUID));
    }

    #[test]
    fn leaf_fields_of_a_non_attestation_certificate() {
        // CA certificates carry neither the attestation OU nor the AAGUID extension.
        for der in PINNED {
            let fields = der::leaf_fields(der).unwrap();
            assert!(!fields.ou_authenticator_attestation);
            assert_eq!(fields.aaguid, None);
        }
        assert!(der::leaf_fields(&[0x30, 0x03, 0x30, 0x01]).is_err());
    }

    #[test]
    fn rejects_every_tampering() {
        let (obj, cdh) = fixture();
        let stmt = obj.stmt.clone().unwrap();
        let verify =
            |stmt: &PackedStatement<'_>, auth: &[u8], cdh: &[u8; 32], aaguid: &[u8; 16]| {
                verify_packed(stmt, auth, cdh, aaguid, NOW)
            };
        // Signature.
        let mut sig = stmt.sig.to_vec();
        let last = sig.len() - 1;
        sig[last] ^= 1;
        let bad_sig = PackedStatement {
            sig: &sig,
            ..stmt.clone()
        };
        assert!(verify(&bad_sig, obj.auth_data, &cdh, &YK5CI_AAGUID).is_err());
        // Authenticator data.
        let mut auth = obj.auth_data.to_vec();
        auth[40] ^= 1;
        assert!(verify(&stmt, &auth, &cdh, &YK5CI_AAGUID).is_err());
        // Client data hash.
        let mut other_cdh = cdh;
        other_cdh[0] ^= 1;
        assert!(verify(&stmt, obj.auth_data, &other_cdh, &YK5CI_AAGUID).is_err());
        // AAGUID.
        let mut aaguid = YK5CI_AAGUID;
        aaguid[15] ^= 1;
        assert_eq!(
            verify(&stmt, obj.auth_data, &cdh, &aaguid),
            Err(AuthnError::AttestationRejected(
                "certificate AAGUID does not match"
            ))
        );
        // Algorithm.
        let es384 = PackedStatement {
            alg: -35,
            ..stmt.clone()
        };
        assert!(verify(&es384, obj.auth_data, &cdh, &YK5CI_AAGUID).is_err());
        // Self attestation.
        let selfie = PackedStatement {
            x5c: Vec::new(),
            ..stmt.clone()
        };
        assert_eq!(
            verify(&selfie, obj.auth_data, &cdh, &YK5CI_AAGUID),
            Err(AuthnError::AttestationRejected("self attestation"))
        );
        // A modified certificate breaks its chain signature.
        let mut cert = stmt.x5c[0].to_vec();
        let pos = cert.windows(5).position(|w| w == b"Yubic").unwrap();
        cert[pos] = b'X';
        let forged = PackedStatement {
            x5c: vec![&cert],
            ..stmt.clone()
        };
        assert!(verify(&forged, obj.auth_data, &cdh, &YK5CI_AAGUID).is_err());
        // Outside the certificate's validity.
        assert!(verify_packed(&stmt, obj.auth_data, &cdh, &YK5CI_AAGUID, 1_000_000_000).is_err());
    }

    #[test]
    fn rejects_other_roots_and_fails_closed_without_roots() {
        let (obj, cdh) = fixture();
        let stmt = obj.stmt.unwrap();
        // Only the 2024 roots: the 5Ci's 2014 chain does not build.
        assert!(
            verify_packed_with(&PINNED[1..], &stmt, obj.auth_data, &cdh, &YK5CI_AAGUID, NOW)
                .is_err()
        );
        assert_eq!(
            verify_packed_with(&[], &stmt, obj.auth_data, &cdh, &YK5CI_AAGUID, NOW),
            Err(AuthnError::AttestationRejected(
                "no trusted attestation roots"
            ))
        );
    }

    fn encode_attestation(entries: &[(&str, Value<'_>)]) -> Vec<u8> {
        let mut e = minicbor::Encoder::new(Vec::new());
        e.map(entries.len() as u64).unwrap();
        for (k, v) in entries {
            e.str(k).unwrap();
            v.encode(&mut e);
        }
        e.into_writer()
    }

    enum Value<'a> {
        Text(&'a str),
        Bytes(&'a [u8]),
        Int(i64),
        Map(Vec<(&'a str, Value<'a>)>),
        Array(Vec<Value<'a>>),
    }

    impl Value<'_> {
        fn encode(&self, e: &mut minicbor::Encoder<Vec<u8>>) {
            match self {
                Value::Text(t) => {
                    e.str(t).unwrap();
                }
                Value::Bytes(b) => {
                    e.bytes(b).unwrap();
                }
                Value::Int(i) => {
                    e.i64(*i).unwrap();
                }
                Value::Map(m) => {
                    e.map(m.len() as u64).unwrap();
                    for (k, v) in m {
                        e.str(k).unwrap();
                        v.encode(e);
                    }
                }
                Value::Array(a) => {
                    e.array(a.len() as u64).unwrap();
                    for v in a {
                        v.encode(e);
                    }
                }
            }
        }
    }

    #[test]
    fn attestation_object_parsing_rules() {
        let packed = |stmt: Vec<(&'static str, Value<'static>)>| {
            encode_attestation(&[
                ("fmt", Value::Text("packed")),
                ("attStmt", Value::Map(stmt)),
                ("authData", Value::Bytes(&[1, 2, 3])),
            ])
        };
        // Self attestation parses (and is refused by verify_packed).
        let selfie = packed(vec![("alg", Value::Int(-7)), ("sig", Value::Bytes(&[9]))]);
        let obj = parse_attestation_object(&selfie).unwrap();
        assert!(obj.stmt.unwrap().x5c.is_empty());
        // Other formats parse without a statement.
        let none = encode_attestation(&[
            ("fmt", Value::Text("none")),
            ("attStmt", Value::Map(vec![])),
            ("authData", Value::Bytes(&[1])),
        ]);
        let obj = parse_attestation_object(&none).unwrap();
        assert_eq!(obj.fmt, "none");
        assert!(obj.stmt.is_none());
        // Missing keys, duplicates, wrong types, trailing bytes, ECDAA, empty x5c.
        for bad in [
            encode_attestation(&[
                ("fmt", Value::Text("packed")),
                ("authData", Value::Bytes(&[1])),
            ]),
            encode_attestation(&[
                ("fmt", Value::Text("packed")),
                ("fmt", Value::Text("packed")),
                ("attStmt", Value::Map(vec![])),
                ("authData", Value::Bytes(&[1])),
            ]),
            encode_attestation(&[
                ("fmt", Value::Text("packed")),
                ("attStmt", Value::Bytes(&[1])),
                ("authData", Value::Bytes(&[1])),
            ]),
            packed(vec![("alg", Value::Int(-7))]),
            packed(vec![
                ("alg", Value::Int(-7)),
                ("sig", Value::Bytes(&[1])),
                ("ecdaaKeyId", Value::Bytes(&[1])),
            ]),
            packed(vec![
                ("alg", Value::Int(-7)),
                ("sig", Value::Bytes(&[1])),
                ("x5c", Value::Array(vec![])),
            ]),
            packed(vec![
                ("alg", Value::Int(-7)),
                ("sig", Value::Bytes(&[1])),
                ("x5c", Value::Array(vec![Value::Text("not bytes")])),
            ]),
            [YK5CI_ATTESTATION, &[0]].concat(),
            YK5CI_ATTESTATION[..YK5CI_ATTESTATION.len() - 1].to_vec(),
        ] {
            assert!(parse_attestation_object(&bad).is_err());
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        #[test]
        fn parse_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..1024)) {
            let _ = parse_attestation_object(&bytes);
        }

        #[test]
        fn mutated_real_object_never_panics_or_verifies_wrongly(
            index in any::<prop::sample::Index>(),
            bit in 0u8..8,
        ) {
            let mut bytes = YK5CI_ATTESTATION.to_vec();
            let i = index.index(bytes.len());
            bytes[i] ^= 1 << bit;
            if let Ok(obj) = parse_attestation_object(&bytes)
                && let Some(stmt) = obj.stmt.as_ref()
            {
                let cdh: [u8; 32] = Sha256::digest(YK5CI_CLIENT_DATA).into();
                // Any accepted mutation must leave every verified byte intact.
                if verify_packed(stmt, obj.auth_data, &cdh, &YK5CI_AAGUID, NOW).is_ok() {
                    let (orig, _) = fixture();
                    prop_assert_eq!(obj.auth_data, orig.auth_data);
                    prop_assert_eq!(stmt.sig, orig.stmt.as_ref().unwrap().sig);
                }
            }
        }

        #[test]
        fn leaf_field_reader_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..800)) {
            let _ = der::leaf_fields(&bytes);
        }
    }
}
