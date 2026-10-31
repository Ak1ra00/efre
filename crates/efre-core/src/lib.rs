//! efre vault format, key hierarchy and encrypted storage.
//!
//! This crate is platform-independent. The normative design lives in
//! `docs/ARCHITECTURE.md` §5–§7; nothing here may deviate from it.
//!
//! Phase 1 scaffold: the format and crypto are implemented in phase 2, after the
//! design review.

#![forbid(unsafe_code)]

/// On-disk format version written by this build (ARCHITECTURE §5.2).
pub const FORMAT_VERSION: u16 = 1;

#[cfg(test)]
mod tests {
    #[test]
    fn format_version_is_one() {
        assert_eq!(super::FORMAT_VERSION, 1);
    }
}
