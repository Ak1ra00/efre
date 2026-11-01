//! efre vault format, key hierarchy and encrypted storage.
//!
//! This crate is platform-independent. The normative design lives in
//! `docs/ARCHITECTURE.md` §5–§7; nothing here may deviate from it.
//!
//! Entry points: [`VaultBuilder`] (first run) and [`Vault::open`] (every later run).
//! Every operation that needs a YubiKey takes an [`efre_authn::Authenticator`].

#![deny(unsafe_code)]

mod crypto;
mod error;
pub mod generator;
mod header;
mod item;
mod secret;
mod store;
mod vault;

pub use error::{Result, Tamper, VaultError};
pub use item::{FieldKind, FieldRole, ItemKind, Settings, Text};
pub use vault::{
    DraftValue, FieldDraft, FieldView, ItemDraft, ItemId, ItemMeta, ItemView, KeyStep, SlotId,
    SlotInfo, Vault, VaultBuilder,
};

/// On-disk format version written by this build (ARCHITECTURE §5.2).
pub const FORMAT_VERSION: u16 = header::FORMAT_VERSION;
