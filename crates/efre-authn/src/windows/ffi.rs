//! Loading `webauthn.dll` and owning what it allocates.
//!
//! The DLL is loaded with `LoadLibraryExW(.., LOAD_LIBRARY_SEARCH_SYSTEM32)` and every
//! function is resolved with `GetProcAddress`; efre never links `webauthn.dll` at load
//! time (ARCHITECTURE §4.2). Only the struct *types* come from the `windows` crate.

use core::ffi::c_void;
use core::mem::transmute;

use windows::Win32::Foundation::{FARPROC, FreeLibrary, HMODULE, HWND};
use windows::Win32::Networking::WindowsWebServices::{
    WEBAUTHN_ASSERTION, WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS, WEBAUTHN_CLIENT_DATA,
    WEBAUTHN_COSE_CREDENTIAL_PARAMETERS, WEBAUTHN_CREDENTIAL_ATTESTATION,
    WEBAUTHN_RP_ENTITY_INFORMATION, WEBAUTHN_USER_ENTITY_INFORMATION,
};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows::core::{GUID, HRESULT, PCSTR, PCWSTR, s, w};
use zeroize::Zeroize;

use crate::AuthnError;

type GetApiVersionNumberFn = unsafe extern "system" fn() -> u32;
pub(super) type MakeCredentialFn = unsafe extern "system" fn(
    HWND,
    *const WEBAUTHN_RP_ENTITY_INFORMATION,
    *const WEBAUTHN_USER_ENTITY_INFORMATION,
    *const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    *mut *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
) -> HRESULT;
pub(super) type GetAssertionFn = unsafe extern "system" fn(
    HWND,
    PCWSTR,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    *mut *mut WEBAUTHN_ASSERTION,
) -> HRESULT;
type FreeCredentialAttestationFn = unsafe extern "system" fn(*mut WEBAUTHN_CREDENTIAL_ATTESTATION);
type FreeAssertionFn = unsafe extern "system" fn(*mut WEBAUTHN_ASSERTION);
type GetCancellationIdFn = unsafe extern "system" fn(*mut GUID) -> HRESULT;
type CancelCurrentOperationFn = unsafe extern "system" fn(*const GUID) -> HRESULT;

/// The loaded DLL. Stored as an address so the authenticator stays `Send + Sync`.
struct Module(usize);

impl Module {
    fn handle(&self) -> HMODULE {
        HMODULE(self.0 as *mut c_void)
    }

    fn proc(&self, name: PCSTR) -> Result<FARPROC, AuthnError> {
        // SAFETY: the module handle is live for `self`'s lifetime and `name` is a
        // NUL-terminated ASCII literal.
        let f = unsafe { GetProcAddress(self.handle(), name) };
        if f.is_none() {
            return Err(AuthnError::UnsupportedPlatform);
        }
        Ok(f)
    }
}

impl Drop for Module {
    fn drop(&mut self) {
        // SAFETY: the handle came from LoadLibraryExW and is released exactly once.
        let _ = unsafe { FreeLibrary(self.handle()) };
    }
}

/// `webauthn.dll`, version-checked, with every entry point efre uses.
pub(super) struct WebAuthnApi {
    _module: Module,
    pub(super) version: u32,
    pub(super) make_credential: MakeCredentialFn,
    pub(super) get_assertion: GetAssertionFn,
    free_attestation: FreeCredentialAttestationFn,
    free_assertion: FreeAssertionFn,
    get_cancellation_id: GetCancellationIdFn,
    cancel_current: CancelCurrentOperationFn,
}

/// Resolves `name` to a typed function pointer.
macro_rules! resolve {
    ($module:expr, $name:literal, $ty:ty) => {{
        let f = $module.proc(s!($name))?;
        // SAFETY: `f` is the non-null address of the documented `webauthn.h` export
        // `$name`, whose C signature matches `$ty` (stdcall/"system" ABI).
        unsafe { transmute::<FARPROC, Option<$ty>>(f) }.ok_or(AuthnError::UnsupportedPlatform)?
    }};
}

impl WebAuthnApi {
    /// Minimum API: `pHmacSecretSaltValues` in GetAssertion options v6 (ARCHITECTURE §4.4).
    pub(super) const MIN_VERSION: u32 = 4;

    pub(super) fn load() -> Result<Self, AuthnError> {
        // SAFETY: loading a System32 DLL by name; LOAD_LIBRARY_SEARCH_SYSTEM32 restricts
        // the search to System32, so no planted copy elsewhere can be picked up.
        let handle =
            unsafe { LoadLibraryExW(w!("webauthn.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
                .map_err(|_| AuthnError::UnsupportedPlatform)?;
        let module = Module(handle.0 as usize);
        let get_version = resolve!(module, "WebAuthNGetApiVersionNumber", GetApiVersionNumberFn);
        // SAFETY: documented export taking no arguments.
        let version = unsafe { get_version() };
        if version < Self::MIN_VERSION {
            return Err(AuthnError::UnsupportedPlatform);
        }
        Ok(Self {
            make_credential: resolve!(
                module,
                "WebAuthNAuthenticatorMakeCredential",
                MakeCredentialFn
            ),
            get_assertion: resolve!(module, "WebAuthNAuthenticatorGetAssertion", GetAssertionFn),
            free_attestation: resolve!(
                module,
                "WebAuthNFreeCredentialAttestation",
                FreeCredentialAttestationFn
            ),
            free_assertion: resolve!(module, "WebAuthNFreeAssertion", FreeAssertionFn),
            get_cancellation_id: resolve!(module, "WebAuthNGetCancellationId", GetCancellationIdFn),
            cancel_current: resolve!(
                module,
                "WebAuthNCancelCurrentOperation",
                CancelCurrentOperationFn
            ),
            version,
            _module: module,
        })
    }

    /// A fresh cancellation id, or `None` if Windows cannot provide one.
    pub(super) fn cancellation_id(&self) -> Option<GUID> {
        let mut id = GUID::zeroed();
        // SAFETY: `id` is a valid, writable GUID.
        let hr = unsafe { (self.get_cancellation_id)(&mut id) };
        hr.is_ok().then_some(id)
    }

    /// Cancels the operation started with `id` (closes the Windows Security dialog).
    pub(super) fn cancel(&self, id: &GUID) {
        // SAFETY: `id` points to a valid GUID for the duration of the call.
        let _ = unsafe { (self.cancel_current)(id) };
    }
}

/// Borrows `len` bytes at `ptr` (empty if null).
///
/// # Safety
/// `ptr` must be null or valid for reads of `len` bytes for the lifetime `'a`.
pub(super) unsafe fn bytes<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if ptr.is_null() || len == 0 {
        return &[];
    }
    // SAFETY: guaranteed by the caller.
    unsafe { core::slice::from_raw_parts(ptr, len as usize) }
}

/// Zeroes `len` bytes at `ptr` (no-op if null).
///
/// # Safety
/// `ptr` must be null or valid for writes of `len` bytes.
unsafe fn wipe(ptr: *mut u8, len: u32) {
    if ptr.is_null() || len == 0 {
        return;
    }
    // SAFETY: guaranteed by the caller.
    let buf = unsafe { core::slice::from_raw_parts_mut(ptr, len as usize) };
    buf.zeroize();
}

/// Owns a `WEBAUTHN_CREDENTIAL_ATTESTATION` and frees it on drop.
pub(super) struct AttestationGuard<'a> {
    pub(super) ptr: *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
    api: &'a WebAuthnApi,
}

impl<'a> AttestationGuard<'a> {
    pub(super) fn new(api: &'a WebAuthnApi) -> Self {
        Self {
            ptr: core::ptr::null_mut(),
            api,
        }
    }

    /// The attestation, if Windows returned one.
    pub(super) fn get(&self) -> Option<&WEBAUTHN_CREDENTIAL_ATTESTATION> {
        // SAFETY: when non-null, `ptr` was produced by MakeCredential and stays valid
        // until this guard frees it.
        unsafe { self.ptr.as_ref() }
    }
}

impl Drop for AttestationGuard<'_> {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            // SAFETY: `ptr` came from MakeCredential and is freed exactly once.
            unsafe { (self.api.free_attestation)(self.ptr) };
        }
    }
}

/// Owns a `WEBAUTHN_ASSERTION`. On drop it zeroes the hmac-secret outputs in Windows'
/// buffer, then frees the assertion, on every path.
pub(super) struct AssertionGuard<'a> {
    pub(super) ptr: *mut WEBAUTHN_ASSERTION,
    api: &'a WebAuthnApi,
}

impl<'a> AssertionGuard<'a> {
    pub(super) fn new(api: &'a WebAuthnApi) -> Self {
        Self {
            ptr: core::ptr::null_mut(),
            api,
        }
    }

    /// The assertion, if Windows returned one.
    pub(super) fn get(&self) -> Option<&WEBAUTHN_ASSERTION> {
        // SAFETY: when non-null, `ptr` was produced by GetAssertion and stays valid
        // until this guard frees it.
        unsafe { self.ptr.as_ref() }
    }
}

/// `WEBAUTHN_ASSERTION` gained `pHmacSecret` in struct version 3.
pub(super) const ASSERTION_HMAC_SECRET_VERSION: u32 = 3;

impl Drop for AssertionGuard<'_> {
    fn drop(&mut self) {
        if self.ptr.is_null() {
            return;
        }
        // SAFETY: `ptr` came from GetAssertion and is still owned by this guard.
        let assertion = unsafe { &*self.ptr };
        if assertion.dwVersion >= ASSERTION_HMAC_SECRET_VERSION && !assertion.pHmacSecret.is_null()
        {
            // SAFETY: `pHmacSecret` points into the assertion allocation (version >= 3).
            let secret = unsafe { &*assertion.pHmacSecret };
            // SAFETY: Windows describes each output buffer by pointer and length.
            unsafe { wipe(secret.pbFirst, secret.cbFirst) };
            // SAFETY: as above.
            unsafe { wipe(secret.pbSecond, secret.cbSecond) };
        }
        // SAFETY: `ptr` came from GetAssertion and is freed exactly once.
        unsafe { (self.api.free_assertion)(self.ptr) };
    }
}
