//! WebAuthn `clientDataJSON` for efre's native calls (ARCHITECTURE §4.3).
//!
//! A native caller of `webauthn.dll` supplies the client data itself; Windows only
//! hashes it. efre's origin is its RP ID, `efre:`, which no website can ever be.

use crate::RP_ID;

/// The WebAuthn ceremony the client data is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientDataType {
    /// `webauthn.create` (MakeCredential).
    Create,
    /// `webauthn.get` (GetAssertion).
    Get,
}

/// `{"type":…,"challenge":<base64url>,"origin":"efre:","crossOrigin":false}`, UTF-8.
pub fn client_data_json(kind: ClientDataType, challenge: &[u8; 32]) -> Vec<u8> {
    let kind = match kind {
        ClientDataType::Create => "webauthn.create",
        ClientDataType::Get => "webauthn.get",
    };
    format!(
        r#"{{"type":"{kind}","challenge":"{}","origin":"{RP_ID}","crossOrigin":false}}"#,
        base64url(challenge)
    )
    .into_bytes()
}

/// Base64url without padding (RFC 4648 §5), as WebAuthn requires for the challenge.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let symbols = chunk.len() + 1; // 1 byte -> 2 symbols, 2 -> 3, 3 -> 4
        for i in 0..symbols {
            let index = (n >> (18 - 6 * i)) & 0x3F;
            out.push(char::from(ALPHABET[index as usize]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_test_vectors_without_padding() {
        for (input, expected) in [
            ("", ""),
            ("f", "Zg"),
            ("fo", "Zm8"),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg"),
            ("fooba", "Zm9vYmE"),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url(input.as_bytes()), expected, "{input:?}");
        }
    }

    #[test]
    fn url_safe_alphabet() {
        // Standard base64 of FB FF BF is "+/+/"; base64url uses '-' and '_'.
        assert_eq!(base64url(&[0xFB, 0xFF, 0xBF]), "-_-_");
        assert_eq!(base64url(&[0xFF]), "_w");
    }

    #[test]
    fn exact_json_shape() {
        let challenge = [0u8; 32];
        let json = String::from_utf8(client_data_json(ClientDataType::Get, &challenge)).unwrap();
        assert_eq!(
            json,
            format!(
                r#"{{"type":"webauthn.get","challenge":"{}","origin":"efre:","crossOrigin":false}}"#,
                "A".repeat(43)
            )
        );
        let create = client_data_json(ClientDataType::Create, &[0xFF; 32]);
        let create = String::from_utf8(create).unwrap();
        assert!(create.starts_with(r#"{"type":"webauthn.create","challenge":"__"#));
        assert!(create.ends_with(r#"","origin":"efre:","crossOrigin":false}"#));
        // 32 bytes -> 43 base64url symbols, no padding.
        let start = create.find("challenge\":\"").unwrap() + "challenge\":\"".len();
        let end = create[start..].find('"').unwrap();
        assert_eq!(end, 43);
    }
}
