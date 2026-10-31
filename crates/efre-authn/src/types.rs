use core::fmt;

use zeroize::Zeroizing;

/// WebAuthn relying-party id of every efre credential (ARCHITECTURE §4.3).
///
/// Not a valid web origin, so no website can ever request an efre credential.
pub const RP_ID: &str = "efre:";

/// Length of an hmac-secret salt (raw mode, ARCHITECTURE §4.6).
pub const SALT_LEN: usize = 32;

/// Length of an hmac-secret output.
pub const PRF_LEN: usize = 32;

/// Largest credential id efre accepts (CTAP2 limit).
pub const MAX_CREDENTIAL_ID_LEN: usize = 1023;

/// An authenticator-issued credential id. Public data.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CredentialId(Vec<u8>);

impl CredentialId {
    /// Wraps credential id bytes, enforcing `1..=MAX_CREDENTIAL_ID_LEN`.
    pub fn new(bytes: Vec<u8>) -> Result<Self, AuthnError> {
        if bytes.is_empty() || bytes.len() > MAX_CREDENTIAL_ID_LEN {
            return Err(AuthnError::InvalidResponse("credential id length"));
        }
        Ok(Self(bytes))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for CredentialId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CredentialId({} bytes)", self.0.len())
    }
}

/// Authenticator model identifier from the attested credential data. Public data.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Aaguid(pub [u8; 16]);

/// A 32-byte hmac-secret salt. Public data: it is stored in the vault header.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Salt(pub [u8; SALT_LEN]);

impl fmt::Debug for Salt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Salt(..)")
    }
}

/// A 32-byte hmac-secret output: key material. Zeroized on drop, never printed.
pub struct PrfOutput(Zeroizing<[u8; PRF_LEN]>);

impl PrfOutput {
    /// Takes ownership of an output buffer.
    pub fn new(bytes: Zeroizing<[u8; PRF_LEN]>) -> Self {
        Self(bytes)
    }

    /// The raw output, for key derivation only.
    pub fn expose(&self) -> &[u8; PRF_LEN] {
        &self.0
    }
}

impl fmt::Debug for PrfOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrfOutput([REDACTED])")
    }
}

/// Create a new non-discoverable credential (MakeCredential).
#[derive(Debug)]
pub struct EnrollRequest<'a> {
    /// WebAuthn user handle. efre passes the vault id.
    pub user_id: &'a [u8],
    /// Credentials already enrolled in this vault. If the inserted key holds one of
    /// them, enrollment fails with [`AuthnError::AlreadyEnrolled`].
    pub exclude: &'a [CredentialId],
}

/// Result of a successful, fully verified enrollment.
#[derive(Debug)]
pub struct Enrollment {
    pub credential_id: CredentialId,
    pub aaguid: Aaguid,
}

/// Salts to evaluate for one allowed credential.
#[derive(Debug)]
pub struct SaltRequest<'a> {
    pub credential_id: &'a CredentialId,
    pub first: Salt,
    /// Optional second salt, evaluated in the same touch (used during VMK rotation).
    pub second: Option<Salt>,
}

/// Get an assertion (GetAssertion with hmac-secret) from any one of `allow`.
#[derive(Debug)]
pub struct AssertRequest<'a> {
    pub allow: &'a [SaltRequest<'a>],
}

/// hmac-secret outputs from the credential that answered.
#[derive(Debug)]
pub struct Assertion {
    /// Must be one of the requested credential ids.
    pub credential_id: CredentialId,
    pub first: PrfOutput,
    /// Present if and only if a second salt was requested for this credential.
    pub second: Option<PrfOutput>,
}

/// Every outcome the UI distinguishes (ARCHITECTURE §4.7). Carries no secret data.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AuthnError {
    #[error("the operation was cancelled")]
    Cancelled,
    #[error("timed out waiting for the security key")]
    Timeout,
    #[error("no security key found")]
    NoDevice,
    #[error("this security key is not enrolled in this vault")]
    UnknownKey,
    #[error("this security key is already enrolled")]
    AlreadyEnrolled,
    #[error("incorrect PIN")]
    WrongPin,
    #[error("the security key's PIN is blocked")]
    PinBlocked,
    #[error("the security key has no PIN set or cannot verify the user")]
    PinNotSet,
    #[error("this version of Windows cannot create the credential efre needs")]
    UnsupportedPlatform,
    #[error("the security key's attestation was rejected: {0}")]
    AttestationRejected(&'static str),
    #[error("the security key returned no secret")]
    NoSecret,
    #[error("invalid authenticator response: {0}")]
    InvalidResponse(&'static str),
    #[error("Windows reported error 0x{0:08X}")]
    Platform(u32),
}

/// A source of FIDO2 credentials and hmac-secret outputs.
///
/// Implementations must use user verification (PIN or fingerprint) and user presence
/// for every call, and the same UV setting for enrollment and assertion.
pub trait Authenticator: Send + Sync {
    /// Creates a non-discoverable credential with `hmac-secret` and
    /// `credProtect = userVerificationRequired`, after verifying attestation.
    fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Enrollment, AuthnError>;

    /// Gets an assertion from one of the allowed credentials and evaluates its salts.
    fn assert(&self, request: &AssertRequest<'_>) -> Result<Assertion, AuthnError>;

    /// Cancels a pending operation, if any (used when the vault locks).
    fn cancel(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_id_bounds() {
        assert!(CredentialId::new(Vec::new()).is_err());
        assert!(CredentialId::new(vec![0; MAX_CREDENTIAL_ID_LEN + 1]).is_err());
        assert!(CredentialId::new(vec![7; MAX_CREDENTIAL_ID_LEN]).is_ok());
    }

    #[test]
    fn secrets_are_redacted_in_debug() {
        let prf = PrfOutput::new(Zeroizing::new([0xAB; PRF_LEN]));
        assert_eq!(format!("{prf:?}"), "PrfOutput([REDACTED])");
        assert_eq!(format!("{:?}", Salt([0x11; SALT_LEN])), "Salt(..)");
    }
}
