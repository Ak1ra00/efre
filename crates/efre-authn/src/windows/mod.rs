//! Windows WebAuthn API implementation (ARCHITECTURE §4).
//!
//! * MakeCredential: cross-platform, USB only, non-discoverable, user verification
//!   required, `credProtect = userVerificationRequired` (required), `hmac-secret`
//!   (plus `bEnablePrf` where the options struct has it), direct attestation. The
//!   authenticator-signed data and the attestation chain are verified before the
//!   credential is accepted; a credential without hmac-secret is refused (D1).
//! * GetAssertion: allow list of the enrolled credentials (USB only), per-credential
//!   raw salts (`WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG`), user verification
//!   required, Windows Security dialog parented to efre's window.

mod ffi;

use core::ffi::c_void;
use core::mem::size_of;
use core::ptr::null_mut;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::TryRng;
use rand::rngs::SysRng;
use sha2::{Digest, Sha256};
use windows::Win32::Foundation::HWND;
use windows::Win32::Networking::WindowsWebServices::{
    WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_DIRECT,
    WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM, WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG, WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    WEBAUTHN_CLIENT_DATA, WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
    WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256, WEBAUTHN_COSE_CREDENTIAL_PARAMETER,
    WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION, WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
    WEBAUTHN_CRED_PROTECT_EXTENSION_IN, WEBAUTHN_CRED_WITH_HMAC_SECRET_SALT,
    WEBAUTHN_CREDENTIAL_EX, WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION, WEBAUTHN_CREDENTIAL_LIST,
    WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY, WEBAUTHN_CTAP_TRANSPORT_USB, WEBAUTHN_EXTENSION,
    WEBAUTHN_EXTENSIONS, WEBAUTHN_EXTENSIONS_IDENTIFIER_CRED_PROTECT,
    WEBAUTHN_EXTENSIONS_IDENTIFIER_HMAC_SECRET, WEBAUTHN_HASH_ALGORITHM_SHA_256,
    WEBAUTHN_HMAC_SECRET_SALT, WEBAUTHN_HMAC_SECRET_SALT_VALUES, WEBAUTHN_RP_ENTITY_INFORMATION,
    WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION, WEBAUTHN_USER_ENTITY_INFORMATION,
    WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION, WEBAUTHN_USER_VERIFICATION_REQUIRED,
    WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
};
use windows::core::{BOOL, GUID, PCWSTR};
use zeroize::Zeroizing;

use self::ffi::{
    ASSERTION_HMAC_SECRET_VERSION, AssertionGuard, AttestationGuard, WebAuthnApi, bytes,
};
use crate::clientdata::{ClientDataType, client_data_json};
use crate::hresult::map_hresult;
use crate::{
    Aaguid, AssertRequest, Assertion, Authenticator, AuthnError, CredentialId, EnrollRequest,
    Enrollment, PRF_LEN, PrfOutput, RP_ID, SALT_LEN, attestation, authdata,
};

/// Guidance for Windows; the platform may override it (ARCHITECTURE §4.3).
const TIMEOUT_MS: u32 = 120_000;
/// `NTE_FAIL`, reported if the OS random number generator fails.
const NTE_FAIL: u32 = 0x8009_0020;

/// `WEBAUTHN_CREDENTIAL_ATTESTATION` gained `dwUsedTransport` in v3, `bResidentKey` in v4.
const ATTESTATION_TRANSPORT_VERSION: u32 = 3;
const ATTESTATION_RESIDENT_KEY_VERSION: u32 = 4;
/// `WEBAUTHN_ASSERTION` gained `dwUsedTransport` in v4.
const ASSERTION_TRANSPORT_VERSION: u32 = 4;
/// `MAKE_CREDENTIAL_OPTIONS` gained `bEnablePrf` in v6.
const MAKE_CREDENTIAL_PRF_VERSION: u32 = 6;

/// The `MAKE_CREDENTIAL_OPTIONS` version to send for a given API version. The
/// `windows` crate's struct has the v7 layout; Windows reads only up to `dwVersion`.
fn make_credential_options_version(api: u32) -> u32 {
    match api {
        0..=2 => 3,
        3 => 4,
        4..=5 => 5,
        6 => 6,
        _ => 7,
    }
}

/// The `GET_ASSERTION_OPTIONS` version to send (v6 adds `pHmacSecretSaltValues`).
fn get_assertion_options_version(api: u32) -> u32 {
    if api >= 7 { 7 } else { 6 }
}

fn bool32(value: bool) -> BOOL {
    BOOL::from(value)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(core::iter::once(0)).collect()
}

fn len32(len: usize) -> Result<u32, AuthnError> {
    u32::try_from(len).map_err(|_| AuthnError::InvalidResponse("length"))
}

fn random_challenge() -> Result<[u8; 32], AuthnError> {
    let mut challenge = [0u8; 32];
    SysRng
        .try_fill_bytes(&mut challenge)
        .map_err(|_| AuthnError::Platform(NTE_FAIL))?;
    Ok(challenge)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Copies a 32-byte hmac-secret output out of Windows' buffer.
///
/// # Safety
/// `ptr` must be null or valid for reads of `len` bytes.
unsafe fn copy_output(ptr: *const u8, len: u32) -> Result<PrfOutput, AuthnError> {
    // SAFETY: guaranteed by the caller.
    let src = unsafe { bytes(ptr, len) };
    if src.len() != PRF_LEN {
        return Err(AuthnError::NoSecret);
    }
    let mut out = Zeroizing::new([0u8; PRF_LEN]);
    out.copy_from_slice(src);
    Ok(PrfOutput::new(out))
}

/// A credential id list in the shape `webauthn.dll` wants. Owns all the memory the
/// raw pointers refer to, so it must outlive the call it is passed to.
struct CredentialList {
    _ids: Vec<Vec<u8>>,
    _creds: Vec<WEBAUTHN_CREDENTIAL_EX>,
    _ptrs: Vec<*mut WEBAUTHN_CREDENTIAL_EX>,
    list: WEBAUTHN_CREDENTIAL_LIST,
}

impl CredentialList {
    fn new<'a>(ids: impl Iterator<Item = &'a CredentialId>) -> Result<Box<Self>, AuthnError> {
        let mut ids: Vec<Vec<u8>> = ids.map(|c| c.as_bytes().to_vec()).collect();
        let mut creds = ids
            .iter_mut()
            .map(|id| {
                Ok(WEBAUTHN_CREDENTIAL_EX {
                    dwVersion: WEBAUTHN_CREDENTIAL_EX_CURRENT_VERSION,
                    cbId: len32(id.len())?,
                    pbId: id.as_mut_ptr(),
                    pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
                    dwTransports: WEBAUTHN_CTAP_TRANSPORT_USB,
                })
            })
            .collect::<Result<Vec<_>, AuthnError>>()?;
        let mut ptrs: Vec<*mut WEBAUTHN_CREDENTIAL_EX> = creds
            .iter_mut()
            .map(|c| c as *mut WEBAUTHN_CREDENTIAL_EX)
            .collect();
        let list = WEBAUTHN_CREDENTIAL_LIST {
            cCredentials: len32(ptrs.len())?,
            ppCredentials: if ptrs.is_empty() {
                null_mut()
            } else {
                ptrs.as_mut_ptr()
            },
        };
        // Moving the Vecs into the box does not move their heap buffers, so the
        // pointers above stay valid.
        Ok(Box::new(Self {
            _ids: ids,
            _creds: creds,
            _ptrs: ptrs,
            list,
        }))
    }
}

/// efre's authenticator on Windows: the Windows WebAuthn API (`webauthn.dll`).
pub struct WindowsAuthenticator {
    api: WebAuthnApi,
    parent: isize,
    pending: Mutex<Option<GUID>>,
}

impl WindowsAuthenticator {
    /// Loads `webauthn.dll` from System32 and checks that it supports per-credential
    /// hmac-secret salts (API >= 4); otherwise [`AuthnError::UnsupportedPlatform`].
    /// `parent_hwnd` is efre's main window, which parents the Windows Security dialog.
    pub fn new(parent_hwnd: isize) -> Result<Self, AuthnError> {
        Ok(Self {
            api: WebAuthnApi::load()?,
            parent: parent_hwnd,
            pending: Mutex::new(None),
        })
    }

    /// `WebAuthNGetApiVersionNumber()`.
    pub fn api_version(&self) -> u32 {
        self.api.version
    }

    fn hwnd(&self) -> HWND {
        HWND(self.parent as *mut c_void)
    }

    /// Registers a cancellation id for the next operation.
    fn begin(&self) -> Option<GUID> {
        let id = self.api.cancellation_id();
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = id;
        id
    }

    fn end(&self) {
        *self.pending.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

impl Authenticator for WindowsAuthenticator {
    fn enroll(&self, request: &EnrollRequest<'_>) -> Result<Enrollment, AuthnError> {
        let challenge = random_challenge()?;
        let mut client_json = client_data_json(ClientDataType::Create, &challenge);
        let client_data_hash: [u8; 32] = Sha256::digest(&client_json).into();

        let rp_id = wide(RP_ID);
        let rp_name = wide("efre");
        let user_name = wide("efre vault");
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: PCWSTR(rp_id.as_ptr()),
            pwszName: PCWSTR(rp_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
        };
        let mut user_id = request.user_id.to_vec();
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: len32(user_id.len())?,
            pbId: user_id.as_mut_ptr(),
            pwszName: PCWSTR(user_name.as_ptr()),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: PCWSTR(user_name.as_ptr()),
        };
        let mut algorithms = [WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            lAlg: WEBAUTHN_COSE_ALGORITHM_ECDSA_P256_WITH_SHA256,
        }];
        let params = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: 1,
            pCredentialParameters: algorithms.as_mut_ptr(),
        };
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: len32(client_json.len())?,
            pbClientDataJSON: client_json.as_mut_ptr(),
            pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
        };

        let mut hmac_secret = bool32(true);
        let mut cred_protect = WEBAUTHN_CRED_PROTECT_EXTENSION_IN {
            dwCredProtect: WEBAUTHN_USER_VERIFICATION_REQUIRED,
            bRequireCredProtect: bool32(true),
        };
        let mut extensions = [
            WEBAUTHN_EXTENSION {
                pwszExtensionIdentifier: WEBAUTHN_EXTENSIONS_IDENTIFIER_HMAC_SECRET,
                cbExtension: len32(size_of::<BOOL>())?,
                pvExtension: (&raw mut hmac_secret).cast::<c_void>(),
            },
            WEBAUTHN_EXTENSION {
                pwszExtensionIdentifier: WEBAUTHN_EXTENSIONS_IDENTIFIER_CRED_PROTECT,
                cbExtension: len32(size_of::<WEBAUTHN_CRED_PROTECT_EXTENSION_IN>())?,
                pvExtension: (&raw mut cred_protect).cast::<c_void>(),
            },
        ];
        let mut exclude = CredentialList::new(request.exclude.iter())?;

        let version = make_credential_options_version(self.api.version);
        let mut cancel = self.begin();
        let options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
            dwVersion: version,
            dwTimeoutMilliseconds: TIMEOUT_MS,
            Extensions: WEBAUTHN_EXTENSIONS {
                cExtensions: len32(extensions.len())?,
                pExtensions: extensions.as_mut_ptr(),
            },
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
            bRequireResidentKey: bool32(false),
            dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
            dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_DIRECT,
            pCancellationId: cancel.as_mut().map_or(null_mut(), |id| id as *mut GUID),
            pExcludeCredentialList: &raw mut exclude.list,
            bPreferResidentKey: bool32(false),
            bEnablePrf: bool32(version >= MAKE_CREDENTIAL_PRF_VERSION),
            // Zero: no enterprise attestation, no large blob, not in-private, no JSON ext.
            ..Default::default()
        };

        let mut result = AttestationGuard::new(&self.api);
        // SAFETY: every pointer in the arguments refers to memory owned by this stack
        // frame (or `exclude`), all alive until the call returns; `result.ptr` receives
        // an allocation that `AttestationGuard` frees.
        let hr = unsafe {
            (self.api.make_credential)(
                self.hwnd(),
                &rp,
                &user,
                &params,
                &client,
                &options,
                &mut result.ptr,
            )
        };
        self.end();
        if hr.is_err() {
            return Err(map_hresult(hr.0 as u32));
        }
        let made = result
            .get()
            .ok_or(AuthnError::InvalidResponse("no attestation"))?;

        if made.dwVersion >= ATTESTATION_RESIDENT_KEY_VERSION && made.bResidentKey.as_bool() {
            return Err(AuthnError::InvalidResponse(
                "a discoverable credential was created",
            ));
        }
        if made.dwVersion >= ATTESTATION_TRANSPORT_VERSION
            && made.dwUsedTransport != WEBAUTHN_CTAP_TRANSPORT_USB
        {
            return Err(AuthnError::InvalidResponse(
                "the security key is not connected by USB",
            ));
        }
        // SAFETY: Windows describes the credential id buffer by pointer and length; it
        // lives until `result` is dropped.
        let credential_id = unsafe { bytes(made.pbCredentialId, made.cbCredentialId) };
        let credential_id = CredentialId::new(credential_id.to_vec())?;
        // SAFETY: as above, for the raw CBOR attestation object.
        let object = unsafe { bytes(made.pbAttestationObject, made.cbAttestationObject) };

        let parsed = attestation::parse_attestation_object(object)?;
        if parsed.fmt != "packed" {
            return Err(AuthnError::AttestationRejected(
                "unsupported attestation format",
            ));
        }
        let statement = parsed.stmt.as_ref().ok_or(AuthnError::AttestationRejected(
            "missing attestation statement",
        ))?;
        let auth = authdata::parse(parsed.auth_data)?;
        let attested = auth.attested.as_ref().ok_or(AuthnError::InvalidResponse(
            "missing attested credential data",
        ))?;
        // First prove it is a genuine YubiKey, then check what Windows asked it to
        // create: a non-YubiKey must be reported as such, not as "update Windows".
        attestation::verify_packed(
            statement,
            parsed.auth_data,
            &client_data_hash,
            &attested.aaguid,
            now_unix(),
        )?;
        authdata::check_registration(&auth, credential_id.as_bytes())?;
        Ok(Enrollment {
            credential_id,
            aaguid: Aaguid(attested.aaguid),
        })
    }

    fn assert(&self, request: &AssertRequest<'_>) -> Result<Assertion, AuthnError> {
        if request.allow.is_empty() {
            return Err(AuthnError::InvalidResponse("no credentials to ask for"));
        }
        let challenge = random_challenge()?;
        let mut client_json = client_data_json(ClientDataType::Get, &challenge);
        let rp_id = wide(RP_ID);
        let client = WEBAUTHN_CLIENT_DATA {
            dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
            cbClientDataJSON: len32(client_json.len())?,
            pbClientDataJSON: client_json.as_mut_ptr(),
            pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
        };

        let mut allow = CredentialList::new(request.allow.iter().map(|a| a.credential_id))?;

        // Per-credential raw salts (pbFirst = current salt, pbSecond = optional second).
        let mut salt_bytes: Vec<([u8; SALT_LEN], Option<[u8; SALT_LEN]>)> = request
            .allow
            .iter()
            .map(|a| (a.first.0, a.second.map(|s| s.0)))
            .collect();
        let mut cred_ids: Vec<Vec<u8>> = request
            .allow
            .iter()
            .map(|a| a.credential_id.as_bytes().to_vec())
            .collect();
        let mut salts = salt_bytes
            .iter_mut()
            .map(|(first, second)| {
                Ok(WEBAUTHN_HMAC_SECRET_SALT {
                    cbFirst: len32(SALT_LEN)?,
                    pbFirst: first.as_mut_ptr(),
                    cbSecond: if second.is_some() {
                        len32(SALT_LEN)?
                    } else {
                        0
                    },
                    pbSecond: second.as_mut().map_or(null_mut(), |s| s.as_mut_ptr()),
                })
            })
            .collect::<Result<Vec<_>, AuthnError>>()?;
        let mut per_credential = cred_ids
            .iter_mut()
            .zip(salts.iter_mut())
            .map(|(id, salt)| {
                Ok(WEBAUTHN_CRED_WITH_HMAC_SECRET_SALT {
                    cbCredID: len32(id.len())?,
                    pbCredID: id.as_mut_ptr(),
                    pHmacSecretSalt: salt as *mut WEBAUTHN_HMAC_SECRET_SALT,
                })
            })
            .collect::<Result<Vec<_>, AuthnError>>()?;
        let mut salt_values = WEBAUTHN_HMAC_SECRET_SALT_VALUES {
            pGlobalHmacSalt: null_mut(),
            cCredWithHmacSecretSaltList: len32(per_credential.len())?,
            pCredWithHmacSecretSaltList: per_credential.as_mut_ptr(),
        };

        let mut cancel = self.begin();
        let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
            dwVersion: get_assertion_options_version(self.api.version),
            dwTimeoutMilliseconds: TIMEOUT_MS,
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
            dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
            // Salts are passed to the authenticator unchanged (ARCHITECTURE §4.6, D4).
            dwFlags: WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG,
            pCancellationId: cancel.as_mut().map_or(null_mut(), |id| id as *mut GUID),
            pAllowCredentialList: &raw mut allow.list,
            pHmacSecretSaltValues: &raw mut salt_values,
            bBrowserInPrivateMode: bool32(false),
            bAutoFill: bool32(false),
            // Zero: no U2F app id, no large blob, no linked device, no JSON ext.
            ..Default::default()
        };

        let mut result = AssertionGuard::new(&self.api);
        // SAFETY: every pointer in the arguments refers to memory owned by this stack
        // frame (or `allow`), all alive until the call returns; `result.ptr` receives an
        // allocation that `AssertionGuard` wipes and frees.
        let hr = unsafe {
            (self.api.get_assertion)(
                self.hwnd(),
                PCWSTR(rp_id.as_ptr()),
                &client,
                &options,
                &mut result.ptr,
            )
        };
        self.end();
        if hr.is_err() {
            return Err(map_hresult(hr.0 as u32));
        }
        let assertion = result
            .get()
            .ok_or(AuthnError::InvalidResponse("no assertion"))?;

        // SAFETY: Windows describes the credential id by pointer and length; it lives
        // until `result` is dropped.
        let used = unsafe { bytes(assertion.Credential.pbId, assertion.Credential.cbId) };
        let requested = request
            .allow
            .iter()
            .find(|a| a.credential_id.as_bytes() == used)
            .ok_or(AuthnError::InvalidResponse("unexpected credential"))?;
        if assertion.dwVersion >= ASSERTION_TRANSPORT_VERSION
            && assertion.dwUsedTransport != WEBAUTHN_CTAP_TRANSPORT_USB
        {
            return Err(AuthnError::InvalidResponse(
                "the security key is not connected by USB",
            ));
        }
        // SAFETY: as above, for the authenticator data.
        let auth_bytes =
            unsafe { bytes(assertion.pbAuthenticatorData, assertion.cbAuthenticatorData) };
        let auth = authdata::parse(auth_bytes)?;
        authdata::check_assertion(&auth)?;

        if assertion.dwVersion < ASSERTION_HMAC_SECRET_VERSION || assertion.pHmacSecret.is_null() {
            return Err(AuthnError::NoSecret);
        }
        // SAFETY: non-null and present since struct version 3 (checked above).
        let secret = unsafe { &*assertion.pHmacSecret };
        // SAFETY: Windows describes each output by pointer and length.
        let first = unsafe { copy_output(secret.pbFirst, secret.cbFirst) }?;
        let has_second = !secret.pbSecond.is_null() && secret.cbSecond != 0;
        let second = match (requested.second.is_some(), has_second) {
            (true, true) => {
                // SAFETY: as above.
                Some(unsafe { copy_output(secret.pbSecond, secret.cbSecond) }?)
            }
            (false, false) => None,
            _ => return Err(AuthnError::InvalidResponse("unexpected number of outputs")),
        };
        Ok(Assertion {
            credential_id: requested.credential_id.clone(),
            first,
            second,
        })
        // `result` drops here: Windows' copy of the outputs is zeroed, then freed.
    }

    fn cancel(&self) {
        let pending = *self.pending.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(id) = pending {
            self.api.cancel(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_versions_follow_the_api_version() {
        assert_eq!(make_credential_options_version(4), 5);
        assert_eq!(make_credential_options_version(5), 5);
        assert_eq!(make_credential_options_version(6), 6);
        assert_eq!(make_credential_options_version(9), 7);
        assert_eq!(get_assertion_options_version(4), 6);
        assert_eq!(get_assertion_options_version(6), 6);
        assert_eq!(get_assertion_options_version(9), 7);
    }
}
