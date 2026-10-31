//! Authenticator abstraction for efre.
//!
//! The vault never talks to a YubiKey directly. It asks an [`Authenticator`] to
//! create a credential ([`Authenticator::enroll`]) or to evaluate the CTAP2
//! `hmac-secret` extension for one of a set of enrolled credentials
//! ([`Authenticator::assert`]). The 32-byte outputs ([`PrfOutput`]) are the only
//! key material that comes from the YubiKey.
//!
//! * `windows` (cfg(windows)): the Windows WebAuthn API (`webauthn.dll`), loaded from
//!   System32 only. Implemented in phase 3.
//! * `mock` (feature `mock`, tests/dev only): a deterministic HMAC-based authenticator.
//!
//! See `docs/ARCHITECTURE.md` §4 for the exact WebAuthn parameters.

pub mod attestation;
pub mod authdata;
mod types;

pub use types::{
    Aaguid, AssertRequest, Assertion, Authenticator, AuthnError, CredentialId, EnrollRequest,
    Enrollment, MAX_CREDENTIAL_ID_LEN, PRF_LEN, PrfOutput, RP_ID, SALT_LEN, Salt, SaltRequest,
};

#[cfg(feature = "mock")]
pub mod mock;

#[cfg(windows)]
pub mod windows;
