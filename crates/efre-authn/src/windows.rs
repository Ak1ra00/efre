//! Windows WebAuthn API implementation (phase 3).
//!
//! `webauthn.dll` is loaded with `LoadLibraryExW(.., LOAD_LIBRARY_SEARCH_SYSTEM32)` and
//! resolved with `GetProcAddress`; it is never linked at load time.
