//! Shared fixtures for efre-core integration tests.

#![allow(dead_code, unreachable_pub, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use efre_authn::mock::{MockAuthenticator, MockKeyId};
use efre_core::{
    DraftValue, FieldDraft, FieldKind, FieldRole, ItemDraft, ItemKind, KeyStep, Vault, VaultBuilder,
};

/// A unique temporary directory, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new() -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "efre-test-{}-{nanos}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    pub fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn no_progress() -> impl FnMut(KeyStep<'_>) {
    |_| {}
}

/// A mock with two keys and a vault enrolled with both (the first-run wizard).
pub struct Fixture {
    pub mock: MockAuthenticator,
    pub primary: MockKeyId,
    pub backup: MockKeyId,
    pub dir: TempDir,
    pub path: PathBuf,
}

impl Fixture {
    pub fn new() -> (Self, Vault) {
        let mock = MockAuthenticator::new();
        let primary = mock.add_key("primary");
        let backup = mock.add_key("backup");
        let dir = TempDir::new();
        let path = dir.file("vault.efre");
        let mut builder = VaultBuilder::new().unwrap();
        mock.insert(primary);
        builder
            .enroll_key(&mock, "Primary", &mut no_progress())
            .unwrap();
        mock.insert(backup);
        builder
            .enroll_key(&mock, "Backup", &mut no_progress())
            .unwrap();
        let vault = builder.create(&path).unwrap();
        mock.insert(primary);
        (
            Self {
                mock,
                primary,
                backup,
                dir,
                path,
            },
            vault,
        )
    }

    /// Opens the file again (locked).
    pub fn reopen(&self) -> Vault {
        Vault::open(&self.path).unwrap()
    }

    /// Opens and unlocks with the currently inserted key.
    pub fn unlocked(&self) -> Vault {
        let mut vault = self.reopen();
        vault.unlock(&self.mock).unwrap();
        vault
    }
}

pub fn field(label: &str, kind: FieldKind, role: Option<FieldRole>, value: &str) -> FieldDraft {
    FieldDraft {
        id: None,
        label: label.into(),
        kind,
        role,
        value: DraftValue::Set(value.into()),
    }
}

pub fn login(title: &str, username: &str, password: &str) -> ItemDraft {
    ItemDraft {
        kind: ItemKind::Login,
        title: title.into(),
        favorite: false,
        tags: vec!["work".into()],
        fields: vec![
            field(
                "Username",
                FieldKind::Text,
                Some(FieldRole::Username),
                username,
            ),
            field(
                "Password",
                FieldKind::Hidden,
                Some(FieldRole::Password),
                password,
            ),
            field(
                "Website",
                FieldKind::Url,
                Some(FieldRole::Url),
                "https://example.com",
            ),
        ],
    }
}

/// Copies a vault file (the vault must be closed, i.e. dropped).
pub fn copy_file(from: &Path, to: &Path) {
    std::fs::copy(from, to).unwrap();
}
