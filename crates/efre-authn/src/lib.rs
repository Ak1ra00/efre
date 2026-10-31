//! Authenticator abstraction for efre.
//!
//! * `windows` (cfg(windows)): the Windows WebAuthn API (`webauthn.dll`), loaded from
//!   System32 only. Implemented in phase 3.
//! * `mock` (feature `mock`, tests/dev only): a deterministic HMAC-based authenticator.
//!
//! See `docs/ARCHITECTURE.md` §4 for the exact WebAuthn parameters.

#[cfg(feature = "mock")]
pub mod mock;

#[cfg(windows)]
pub mod windows;
