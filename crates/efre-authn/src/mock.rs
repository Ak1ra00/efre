//! Deterministic test authenticator (phase 2).
//!
//! Compiled only with the `mock` feature, which only tests and dev builds enable.

#[cfg(not(debug_assertions))]
compile_error!(
    "efre-authn's `mock` feature must never be enabled in a release build (see ARCHITECTURE §11)"
);

/// Unique marker that CI searches for in release binaries. If it is ever found,
/// the mock leaked into a release build and CI fails.
pub const MOCK_MARKER: &str = "EFRE-MOCK-AUTHENTICATOR-MUST-NOT-SHIP";
