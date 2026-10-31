use core::fmt;

use efre_authn::AuthnError;

/// Which integrity check failed. Every one of these means "refuse to open".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tamper {
    /// The header MAC does not verify.
    Header,
    /// The manifest MAC over all records does not verify.
    Manifest,
    /// A record failed to decrypt or decode although the manifest verified.
    Record,
    /// A key-management assertion unwrapped a VMK different from the open vault's.
    KeyMismatch,
}

impl fmt::Display for Tamper {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Header => "header",
            Self::Manifest => "item list",
            Self::Record => "item",
            Self::KeyMismatch => "key slot",
        })
    }
}

/// Errors from vault operations. They never contain key material or plaintext.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error(transparent)]
    Authn(#[from] AuthnError),
    #[error("this security key could not open the vault")]
    KeyRejected,
    #[error("the vault file was modified outside efre ({0})")]
    Tampered(Tamper),
    #[error("the vault file is damaged ({0})")]
    Corrupt(&'static str),
    #[error("this is not an efre vault")]
    NotAVault,
    #[error("this vault was created by a newer version of efre")]
    TooNew,
    #[error("this vault uses an unsupported (older) format")]
    UnsupportedVersion,
    #[error("no vault exists at this location")]
    NotFound,
    #[error("a vault already exists at this location")]
    AlreadyExists,
    #[error("the vault is open in another program")]
    InUse,
    #[error("the vault is locked")]
    Locked,
    #[error("item not found")]
    ItemNotFound,
    #[error("field not found")]
    FieldNotFound,
    #[error("key not found")]
    KeyNotFound,
    #[error("the item must be in the trash first")]
    NotInTrash,
    #[error("a vault needs at least one enrolled key")]
    NoKeys,
    #[error("the last enrolled key cannot be removed")]
    LastKey,
    #[error("too many enrolled keys")]
    TooManyKeys,
    #[error("invalid input: {0}")]
    Invalid(&'static str),
    #[error("the operating system's random number generator failed")]
    Rng,
    #[error("storage error: {0}")]
    Storage(String),
    #[error("file system error: {0}")]
    Io(std::io::ErrorKind),
}

impl From<rusqlite::Error> for VaultError {
    fn from(error: rusqlite::Error) -> Self {
        use rusqlite::ErrorCode;
        match error.sqlite_error_code() {
            Some(ErrorCode::DatabaseCorrupt) => Self::Corrupt("database structure"),
            Some(ErrorCode::NotADatabase) => Self::NotAVault,
            Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Self::InUse,
            Some(ErrorCode::CannotOpen) => Self::NotFound,
            // rusqlite's messages name SQL and columns, never bound parameter values.
            _ => Self::Storage(error.to_string()),
        }
    }
}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::NotFound,
            std::io::ErrorKind::AlreadyExists => Self::AlreadyExists,
            kind => Self::Io(kind),
        }
    }
}

pub type Result<T, E = VaultError> = core::result::Result<T, E>;
