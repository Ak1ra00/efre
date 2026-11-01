// STUB: replaced by Agent F's implementation at merge.
//! Password and passphrase generator.
//!
//! Placeholder with the final API only: every call fails with
//! [`VaultError::Invalid`] until the real generator lands.

use secrecy::SecretString;

use crate::VaultError;

pub struct PasswordOptions {
    pub length: usize,
    pub lowercase: bool,
    pub uppercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

pub struct PassphraseOptions {
    pub words: usize,
    pub separator: String,
    pub capitalize: bool,
    pub include_number: bool,
}

pub struct Generated {
    pub value: SecretString,
    pub entropy_bits: f64,
}

pub fn password(options: &PasswordOptions) -> Result<Generated, crate::VaultError> {
    let _ = options;
    Err(VaultError::Invalid(
        "the password generator is not available",
    ))
}

pub fn passphrase(options: &PassphraseOptions) -> Result<Generated, crate::VaultError> {
    let _ = options;
    Err(VaultError::Invalid(
        "the passphrase generator is not available",
    ))
}
