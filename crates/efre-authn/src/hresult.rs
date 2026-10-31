//! Mapping of `webauthn.dll` HRESULTs to [`AuthnError`] (ARCHITECTURE §4.7).
//!
//! Wrong PINs are retried inside the Windows Security dialog, so efre only sees the
//! final result of an operation. The HRESULT Windows returns for a *blocked* PIN is
//! not documented; until it is observed on hardware (phase 3 checklist) it maps to
//! [`AuthnError::Platform`] with the raw code.

use crate::AuthnError;

/// `NTE_USER_CANCELLED`: the user closed the Windows Security dialog.
pub const NTE_USER_CANCELLED: u32 = 0x8009_0036;
/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the operation was cancelled.
pub const HR_ERROR_CANCELLED: u32 = 0x8007_04C7;
/// `HRESULT_FROM_WIN32(ERROR_TIMEOUT)`.
pub const HR_ERROR_TIMEOUT: u32 = 0x8007_05B4;
/// `NTE_DEVICE_NOT_FOUND`: no security key.
pub const NTE_DEVICE_NOT_FOUND: u32 = 0x8009_0035;
/// `NTE_NOT_FOUND`: the key holds none of the allowed credentials.
pub const NTE_NOT_FOUND: u32 = 0x8009_0011;
/// `NTE_EXISTS`: the key holds a credential from the exclude list.
pub const NTE_EXISTS: u32 = 0x8009_000F;
/// `NTE_NOT_SUPPORTED`: e.g. user verification is impossible (no PIN set).
pub const NTE_NOT_SUPPORTED: u32 = 0x8009_0029;
/// `HRESULT_FROM_WIN32(ERROR_NOT_SUPPORTED)`.
pub const HR_ERROR_NOT_SUPPORTED: u32 = 0x8007_0032;

/// Maps a failing HRESULT from `webauthn.dll` to the outcome the UI shows.
pub fn map_hresult(hr: u32) -> AuthnError {
    match hr {
        NTE_USER_CANCELLED | HR_ERROR_CANCELLED => AuthnError::Cancelled,
        HR_ERROR_TIMEOUT => AuthnError::Timeout,
        NTE_DEVICE_NOT_FOUND => AuthnError::NoDevice,
        NTE_NOT_FOUND => AuthnError::UnknownKey,
        NTE_EXISTS => AuthnError::AlreadyEnrolled,
        NTE_NOT_SUPPORTED | HR_ERROR_NOT_SUPPORTED => AuthnError::PinNotSet,
        other => AuthnError::Platform(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_codes() {
        for (hr, expected) in [
            (0x8009_0036, AuthnError::Cancelled),
            (0x8007_04C7, AuthnError::Cancelled),
            (0x8007_05B4, AuthnError::Timeout),
            (0x8009_0035, AuthnError::NoDevice),
            (0x8009_0011, AuthnError::UnknownKey),
            (0x8009_000F, AuthnError::AlreadyEnrolled),
            (0x8009_0029, AuthnError::PinNotSet),
            (0x8007_0032, AuthnError::PinNotSet),
        ] {
            assert_eq!(map_hresult(hr), expected, "0x{hr:08X}");
        }
    }

    #[test]
    fn unknown_codes_keep_the_raw_value() {
        // NTE_INVALID_PARAMETER and E_FAIL are not user outcomes.
        assert_eq!(map_hresult(0x8009_0027), AuthnError::Platform(0x8009_0027));
        assert_eq!(map_hresult(0x8000_4005), AuthnError::Platform(0x8000_4005));
        assert_eq!(
            map_hresult(0x8000_4005).to_string(),
            "Windows reported error 0x80004005"
        );
    }
}
