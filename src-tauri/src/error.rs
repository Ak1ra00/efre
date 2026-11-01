//! IPC errors: `{ code, message }` (docs/IPC.md, "Error codes").
//!
//! Every `efre_core::VaultError` and `efre_authn::AuthnError` variant maps to a stable
//! code. Messages are user-facing English built from fixed text; they never contain
//! key material, item contents or other secrets.

use std::borrow::Cow;

use efre_authn::AuthnError;
use efre_core::VaultError;
use serde::Serialize;

use crate::clipboard::ClipboardError;

/// The error every command returns. Serializes as `{ "code": ..., "message": ... }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct IpcError {
    pub(crate) code: &'static str,
    pub(crate) message: Cow<'static, str>,
}

pub(crate) type IpcResult<T> = Result<T, IpcError>;

impl IpcError {
    fn new(code: &'static str, message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn locked() -> Self {
        Self::new("locked", "The vault is locked.")
    }

    pub(crate) fn invalid(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new("invalid", message)
    }

    pub(crate) fn not_found(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new("notFound", message)
    }

    pub(crate) fn internal(message: impl Into<Cow<'static, str>>) -> Self {
        Self::new("internal", message)
    }
}

impl From<AuthnError> for IpcError {
    fn from(error: AuthnError) -> Self {
        match error {
            AuthnError::Cancelled => Self::new(
                "authn.cancelled",
                "Cancelled. If Windows said it didn't recognise the key, that key isn't \
                 enrolled in this vault: try your other key.",
            ),
            AuthnError::Timeout => {
                Self::new("authn.timeout", "Timed out waiting for your YubiKey.")
            }
            AuthnError::NoDevice => Self::new(
                "authn.noDevice",
                "No YubiKey found. Plug it into a USB port.",
            ),
            AuthnError::UnknownKey => Self::new(
                "authn.unknownKey",
                "This YubiKey isn't enrolled in this vault. Try your other key.",
            ),
            AuthnError::AlreadyEnrolled => Self::new(
                "authn.alreadyEnrolled",
                "This YubiKey is already enrolled. Insert a different one.",
            ),
            AuthnError::WrongPin => Self::new("authn.wrongPin", "Incorrect PIN."),
            AuthnError::PinBlocked => Self::new(
                "authn.pinBlocked",
                "This key's PIN is blocked. Use your backup key, then remove this one in \
                 Settings.",
            ),
            AuthnError::PinNotSet => Self::new(
                "authn.pinNotSet",
                "This YubiKey has no FIDO2 PIN yet. Set one in Windows Settings > Accounts > \
                 Sign-in options > Security key > Manage, or with Yubico Authenticator, \
                 then try again.",
            ),
            AuthnError::UnsupportedPlatform => Self::new(
                "authn.unsupportedPlatform",
                "This version of Windows can't create the credential efre needs. Update \
                 Windows, then try again.",
            ),
            AuthnError::AttestationRejected(detail) => Self::new(
                "authn.attestationRejected",
                format!("This security key isn't a YubiKey that efre can use ({detail})."),
            ),
            AuthnError::NoSecret => {
                Self::new("authn.noSecret", "This YubiKey did not return a secret.")
            }
            AuthnError::InvalidResponse(detail) => Self::new(
                "authn.invalidResponse",
                format!("The security key gave an unexpected response ({detail})."),
            ),
            AuthnError::Platform(hr) => Self::new(
                "authn.platform",
                format!("Windows reported an error (0x{hr:08X})."),
            ),
        }
    }
}

impl From<VaultError> for IpcError {
    fn from(error: VaultError) -> Self {
        match error {
            VaultError::Authn(e) => e.into(),
            VaultError::KeyRejected => {
                Self::new("vault.keyRejected", "This key could not open the vault.")
            }
            VaultError::Tampered(_) => Self::new(
                "vault.tampered",
                "The vault file was modified outside efre, so efre refuses to open it.",
            ),
            VaultError::Corrupt(_) => Self::new("vault.corrupt", "The vault file is damaged."),
            VaultError::NotAVault => {
                Self::new("vault.notAVault", "This file is not an efre vault.")
            }
            VaultError::TooNew => Self::new(
                "vault.tooNew",
                "This vault was created by a newer version of efre. Update efre to open it.",
            ),
            VaultError::UnsupportedVersion => Self::new(
                "vault.unsupportedVersion",
                "This vault uses an older format that this version of efre can't open.",
            ),
            VaultError::NotFound => Self::new("vault.notFound", "There is no vault file."),
            VaultError::AlreadyExists => Self::new(
                "vault.alreadyExists",
                "A vault already exists. efre never overwrites a vault.",
            ),
            VaultError::InUse => Self::new(
                "vault.inUse",
                "The vault file is open in another program. Close it and try again.",
            ),
            VaultError::Locked => Self::locked(),
            VaultError::ItemNotFound => Self::not_found("This item no longer exists."),
            VaultError::FieldNotFound => Self::not_found("This item has no such field."),
            VaultError::KeyNotFound => Self::not_found("This key is not enrolled in this vault."),
            VaultError::NotInTrash => {
                Self::new("vault.notInTrash", "Move the item to the trash first.")
            }
            VaultError::NoKeys => Self::invalid("Enroll at least one YubiKey first."),
            VaultError::LastKey => {
                Self::new("vault.lastKey", "The last enrolled key can't be removed.")
            }
            VaultError::TooManyKeys => Self::new(
                "vault.tooManyKeys",
                "This vault already has the maximum number of keys.",
            ),
            // The detail is one of efre-core's fixed field names ("title", "tag", ...).
            VaultError::Invalid(detail) => Self::invalid(format!("Invalid {detail}.")),
            VaultError::Rng => Self::internal("Windows' random number generator failed."),
            VaultError::Storage(_) => {
                Self::internal("efre could not read or write the vault file.")
            }
            VaultError::Io(kind) => {
                Self::internal(format!("A file system error occurred ({kind})."))
            }
        }
    }
}

impl From<ClipboardError> for IpcError {
    fn from(error: ClipboardError) -> Self {
        match error {
            ClipboardError::Unavailable => {
                Self::new("clipboard", "The clipboard is unavailable. Try again.")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use efre_core::Tamper;

    use super::*;

    fn code(error: impl Into<IpcError>) -> &'static str {
        error.into().code
    }

    /// Every `AuthnError` variant and its code (docs/IPC.md).
    pub(crate) fn authn_cases() -> Vec<(AuthnError, &'static str)> {
        vec![
            (AuthnError::Cancelled, "authn.cancelled"),
            (AuthnError::Timeout, "authn.timeout"),
            (AuthnError::NoDevice, "authn.noDevice"),
            (AuthnError::UnknownKey, "authn.unknownKey"),
            (AuthnError::AlreadyEnrolled, "authn.alreadyEnrolled"),
            (AuthnError::WrongPin, "authn.wrongPin"),
            (AuthnError::PinBlocked, "authn.pinBlocked"),
            (AuthnError::PinNotSet, "authn.pinNotSet"),
            (AuthnError::UnsupportedPlatform, "authn.unsupportedPlatform"),
            (
                AuthnError::AttestationRejected("x"),
                "authn.attestationRejected",
            ),
            (AuthnError::NoSecret, "authn.noSecret"),
            (AuthnError::InvalidResponse("x"), "authn.invalidResponse"),
            (AuthnError::Platform(0x8000_4005), "authn.platform"),
        ]
    }

    /// Every `VaultError` variant (except `Authn`) and its code.
    fn vault_cases() -> Vec<(VaultError, &'static str)> {
        vec![
            (VaultError::KeyRejected, "vault.keyRejected"),
            (VaultError::Tampered(Tamper::Header), "vault.tampered"),
            (VaultError::Tampered(Tamper::KeyMismatch), "vault.tampered"),
            (VaultError::Corrupt("x"), "vault.corrupt"),
            (VaultError::NotAVault, "vault.notAVault"),
            (VaultError::TooNew, "vault.tooNew"),
            (VaultError::UnsupportedVersion, "vault.unsupportedVersion"),
            (VaultError::NotFound, "vault.notFound"),
            (VaultError::AlreadyExists, "vault.alreadyExists"),
            (VaultError::InUse, "vault.inUse"),
            (VaultError::Locked, "locked"),
            (VaultError::ItemNotFound, "notFound"),
            (VaultError::FieldNotFound, "notFound"),
            (VaultError::KeyNotFound, "notFound"),
            (VaultError::NotInTrash, "vault.notInTrash"),
            (VaultError::NoKeys, "invalid"),
            (VaultError::LastKey, "vault.lastKey"),
            (VaultError::TooManyKeys, "vault.tooManyKeys"),
            (VaultError::Invalid("title"), "invalid"),
            (VaultError::Rng, "internal"),
            (
                VaultError::Storage("SELECT body FROM header".into()),
                "internal",
            ),
            (
                VaultError::Io(std::io::ErrorKind::PermissionDenied),
                "internal",
            ),
        ]
    }

    #[test]
    fn authenticator_errors_map_to_their_codes() {
        for (error, expected) in authn_cases() {
            assert_eq!(code(error.clone()), expected, "{error:?}");
            // Wrapped in a vault error, the code is the same.
            assert_eq!(
                code(VaultError::Authn(error.clone())),
                expected,
                "{error:?}"
            );
        }
    }

    #[test]
    fn vault_errors_map_to_their_codes() {
        for (error, expected) in vault_cases() {
            let debug = format!("{error:?}");
            assert_eq!(code(error), expected, "{debug}");
        }
    }

    #[test]
    fn clipboard_error_code() {
        assert_eq!(code(ClipboardError::Unavailable), "clipboard");
    }

    #[test]
    fn serializes_as_code_and_message() {
        let json = serde_json::to_value(IpcError::from(AuthnError::Platform(0x8009_0027)))
            .expect("serializes");
        assert_eq!(
            json,
            serde_json::json!({
                "code": "authn.platform",
                "message": "Windows reported an error (0x80090027).",
            })
        );
    }

    #[test]
    fn messages_never_echo_storage_details() {
        // rusqlite messages name SQL and columns; they are not user-facing.
        let error = IpcError::from(VaultError::Storage("no such table: records".into()));
        assert!(!error.message.contains("records"), "{}", error.message);
    }

    #[test]
    fn every_code_in_the_contract_is_produced_and_nothing_else() {
        let mut produced: std::collections::BTreeSet<&str> = authn_cases()
            .into_iter()
            .map(|(_, c)| c)
            .chain(vault_cases().into_iter().map(|(_, c)| c))
            .collect();
        produced.insert(code(ClipboardError::Unavailable));
        produced.insert(IpcError::internal("x").code);
        let documented = crate::contract::documented_error_codes();
        assert_eq!(produced, documented);
    }
}
