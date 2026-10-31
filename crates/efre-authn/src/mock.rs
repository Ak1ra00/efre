//! Deterministic test authenticator.
//!
//! Compiled only with the `mock` feature, which only tests and dev builds enable.
//! It models a set of YubiKeys, of which at most one is "inserted":
//!
//! * credentials are stateless, like a real YubiKey's non-discoverable credentials:
//!   the id carries a MAC under the key's secret, so a key recognises only its own;
//! * the hmac-secret output is `HMAC-SHA256(CredRandom, salt)` with
//!   `CredRandom = HMAC-SHA256(key_secret, "credRandomWithUV" || credential_id)`;
//! * failures (cancel, timeout, wrong PIN, ...) can be scripted for the next operation.

#[cfg(not(debug_assertions))]
compile_error!(
    "efre-authn's `mock` feature must never be enabled in a release build (see ARCHITECTURE §11)"
);

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard};

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::{
    Aaguid, AssertRequest, Assertion, Authenticator, AuthnError, CredentialId, EnrollRequest,
    Enrollment, PRF_LEN, PrfOutput, Salt,
};

/// Unique marker that CI searches for in release binaries. If it is ever found,
/// the mock leaked into a release build and CI fails.
pub const MOCK_MARKER: &str = "EFRE-MOCK-AUTHENTICATOR-MUST-NOT-SHIP";

const CRED_PREFIX: &[u8; 4] = b"MOCK";
const CRED_NONCE_LEN: usize = 16;
const CRED_MAC_LEN: usize = 16;
const CRED_LEN: usize = CRED_PREFIX.len() + CRED_NONCE_LEN + CRED_MAC_LEN;

/// Handle to one simulated YubiKey.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MockKeyId(usize);

struct MockKey {
    secret: Zeroizing<[u8; 32]>,
    aaguid: Aaguid,
    pin_blocked: bool,
    issued: u64,
}

#[derive(Default)]
struct State {
    keys: Vec<MockKey>,
    inserted: Option<usize>,
    script: VecDeque<AuthnError>,
    enrollments: usize,
    assertions: usize,
}

/// Deterministic in-memory authenticator for tests and dev builds.
pub struct MockAuthenticator {
    marker: &'static str,
    state: Mutex<State>,
}

impl Default for MockAuthenticator {
    fn default() -> Self {
        Self::new()
    }
}

impl MockAuthenticator {
    pub fn new() -> Self {
        Self {
            marker: MOCK_MARKER,
            state: Mutex::new(State::default()),
        }
    }

    /// The marker string (keeps it referenced so it is present wherever the mock is).
    pub fn marker(&self) -> &'static str {
        self.marker
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Adds a simulated YubiKey whose secret is derived from `label`.
    pub fn add_key(&self, label: &str) -> MockKeyId {
        let mut secret = Zeroizing::new([0u8; 32]);
        let digest = Sha256::new()
            .chain_update(b"efre-mock-key\0")
            .chain_update(label.as_bytes())
            .finalize();
        secret.copy_from_slice(&digest);
        let mut aaguid = [0u8; 16];
        aaguid.copy_from_slice(&Sha256::digest(label.as_bytes())[..16]);
        let mut state = self.state();
        state.keys.push(MockKey {
            secret,
            aaguid: Aaguid(aaguid),
            pin_blocked: false,
            issued: 0,
        });
        MockKeyId(state.keys.len() - 1)
    }

    /// Plugs in `key` (only one key is inserted at a time).
    pub fn insert(&self, key: MockKeyId) {
        self.state().inserted = Some(key.0);
    }

    /// Unplugs the inserted key.
    pub fn unplug(&self) {
        self.state().inserted = None;
    }

    /// Makes `key` behave as if its PIN were blocked.
    pub fn block_pin(&self, key: MockKeyId) {
        if let Some(k) = self.state().keys.get_mut(key.0) {
            k.pin_blocked = true;
        }
    }

    /// The next operation (enroll or assert) fails with `error`. Calls queue up.
    pub fn fail_next(&self, error: AuthnError) {
        self.state().script.push_back(error);
    }

    /// Number of enroll calls so far (each is one Windows prompt).
    pub fn enrollments(&self) -> usize {
        self.state().enrollments
    }

    /// Number of assert calls so far (each is one Windows prompt).
    pub fn assertions(&self) -> usize {
        self.state().assertions
    }

    /// The AAGUID reported by `key`.
    pub fn aaguid(&self, key: MockKeyId) -> Option<Aaguid> {
        self.state().keys.get(key.0).map(|k| k.aaguid)
    }
}

/// Common checks before an operation: scripted failure, device present, PIN usable.
fn begin(state: &mut State) -> Result<usize, AuthnError> {
    if let Some(error) = state.script.pop_front() {
        return Err(error);
    }
    let index = state.inserted.ok_or(AuthnError::NoDevice)?;
    let key = state.keys.get(index).ok_or(AuthnError::NoDevice)?;
    if key.pin_blocked {
        return Err(AuthnError::PinBlocked);
    }
    Ok(index)
}

fn hmac(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; 32]> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
        .unwrap_or_else(|_| unreachable!("HMAC accepts keys of any length"));
    for part in parts {
        mac.update(part);
    }
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

fn recognises(key: &MockKey, credential: &CredentialId) -> bool {
    let bytes = credential.as_bytes();
    if bytes.len() != CRED_LEN || !bytes.starts_with(CRED_PREFIX) {
        return false;
    }
    let (nonce, tag) = bytes[CRED_PREFIX.len()..].split_at(CRED_NONCE_LEN);
    let expected = hmac(&*key.secret, &[b"cred", nonce]);
    expected[..CRED_MAC_LEN] == *tag
}

fn prf(key: &MockKey, credential: &CredentialId, salt: &Salt) -> PrfOutput {
    let cred_random = hmac(&*key.secret, &[b"credRandomWithUV", credential.as_bytes()]);
    let out = hmac(&*cred_random, &[&salt.0]);
    let mut bytes = Zeroizing::new([0u8; PRF_LEN]);
    bytes.copy_from_slice(&*out);
    PrfOutput::new(bytes)
}

impl Authenticator for MockAuthenticator {
    fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Enrollment, AuthnError> {
        let mut state = self.state();
        state.enrollments += 1;
        let index = begin(&mut state)?;
        let key = &mut state.keys[index];
        if request.exclude.iter().any(|c| recognises(key, c)) {
            return Err(AuthnError::AlreadyEnrolled);
        }
        key.issued += 1;
        let nonce_full = hmac(&*key.secret, &[b"nonce", &key.issued.to_be_bytes()]);
        let nonce = &nonce_full[..CRED_NONCE_LEN];
        let tag = hmac(&*key.secret, &[b"cred", nonce]);
        let mut id = Vec::with_capacity(CRED_LEN);
        id.extend_from_slice(CRED_PREFIX);
        id.extend_from_slice(nonce);
        id.extend_from_slice(&tag[..CRED_MAC_LEN]);
        Ok(Enrollment {
            credential_id: CredentialId::new(id)?,
            aaguid: key.aaguid,
        })
    }

    fn assert(&self, request: &AssertRequest<'_>) -> Result<Assertion, AuthnError> {
        let mut state = self.state();
        state.assertions += 1;
        let index = begin(&mut state)?;
        let key = &state.keys[index];
        let allowed = request
            .allow
            .iter()
            .find(|a| recognises(key, a.credential_id))
            .ok_or(AuthnError::UnknownKey)?;
        Ok(Assertion {
            credential_id: allowed.credential_id.clone(),
            first: prf(key, allowed.credential_id, &allowed.first),
            second: allowed
                .second
                .as_ref()
                .map(|s| prf(key, allowed.credential_id, s)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SaltRequest;

    fn enroll(
        mock: &MockAuthenticator,
        exclude: &[CredentialId],
    ) -> Result<Enrollment, AuthnError> {
        mock.enroll(&EnrollRequest {
            user_id: b"vault",
            exclude,
        })
    }

    fn assert_one(
        mock: &MockAuthenticator,
        cred: &CredentialId,
        salt: Salt,
        second: Option<Salt>,
    ) -> Result<Assertion, AuthnError> {
        mock.assert(&AssertRequest {
            allow: &[SaltRequest {
                credential_id: cred,
                first: salt,
                second,
            }],
        })
    }

    #[test]
    fn prf_is_deterministic_and_salt_and_key_dependent() {
        let mock = MockAuthenticator::new();
        let a = mock.add_key("a");
        let b = mock.add_key("b");
        mock.insert(a);
        let cred_a = enroll(&mock, &[]).unwrap().credential_id;
        let s1 = Salt([1; 32]);
        let s2 = Salt([2; 32]);
        let x = assert_one(&mock, &cred_a, s1, Some(s2)).unwrap();
        let y = assert_one(&mock, &cred_a, s1, None).unwrap();
        assert_eq!(x.first.expose(), y.first.expose());
        assert_ne!(x.first.expose(), x.second.as_ref().unwrap().expose());
        assert!(y.second.is_none());
        // Key b does not recognise key a's credential.
        mock.insert(b);
        assert_eq!(
            assert_one(&mock, &cred_a, s1, None).unwrap_err(),
            AuthnError::UnknownKey
        );
    }

    #[test]
    fn exclude_list_detects_same_key() {
        let mock = MockAuthenticator::new();
        let a = mock.add_key("a");
        let b = mock.add_key("b");
        mock.insert(a);
        let cred_a = enroll(&mock, &[]).unwrap().credential_id;
        assert_eq!(
            enroll(&mock, std::slice::from_ref(&cred_a)).unwrap_err(),
            AuthnError::AlreadyEnrolled
        );
        mock.insert(b);
        let cred_b = enroll(&mock, std::slice::from_ref(&cred_a))
            .unwrap()
            .credential_id;
        assert_ne!(cred_a, cred_b);
    }

    #[test]
    fn scripted_and_device_failures() {
        let mock = MockAuthenticator::new();
        let a = mock.add_key("a");
        assert_eq!(enroll(&mock, &[]).unwrap_err(), AuthnError::NoDevice);
        mock.insert(a);
        for error in [
            AuthnError::Cancelled,
            AuthnError::Timeout,
            AuthnError::WrongPin,
        ] {
            mock.fail_next(error.clone());
            assert_eq!(enroll(&mock, &[]).unwrap_err(), error);
        }
        let cred = enroll(&mock, &[]).unwrap().credential_id;
        mock.block_pin(a);
        assert_eq!(
            assert_one(&mock, &cred, Salt([0; 32]), None).unwrap_err(),
            AuthnError::PinBlocked
        );
        // 1 with no device + 3 scripted failures + 1 success.
        assert_eq!(mock.enrollments(), 5);
        assert_eq!(mock.assertions(), 1);
        assert_eq!(mock.marker(), MOCK_MARKER);
    }
}
