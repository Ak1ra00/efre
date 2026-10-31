//! End-to-end vault flows against the mock authenticator.

#![allow(clippy::unwrap_used)] // test crate: panicking on unexpected errors is the point

mod common;

use common::{Fixture, TempDir, copy_file, field, login, no_progress};
use efre_authn::AuthnError;
use efre_authn::mock::MockAuthenticator;
use efre_core::{
    DraftValue, FieldDraft, FieldKind, FieldRole, ItemDraft, ItemKind, KeyStep, Settings, Vault,
    VaultBuilder, VaultError,
};
use rusqlite::Connection;
use secrecy::ExposeSecret;

#[test]
fn wizard_creates_a_vault_both_keys_open() {
    let (fx, mut vault) = Fixture::new();
    // Two keys, two prompts each (create + confirm).
    assert_eq!(fx.mock.enrollments(), 2);
    assert_eq!(fx.mock.assertions(), 2);
    let id = vault.create_item(login("Mail", "alice", "s3cret")).unwrap();
    drop(vault);

    let mut locked = fx.reopen();
    assert!(!locked.is_unlocked());
    let names: Vec<_> = locked.slots().into_iter().map(|s| s.nickname).collect();
    assert_eq!(names, ["Primary", "Backup"]);
    assert!(matches!(locked.items(), Err(VaultError::Locked)));

    for key in [fx.primary, fx.backup] {
        fx.mock.insert(key);
        locked.unlock(&fx.mock).unwrap();
        let view = locked.item(id).unwrap();
        assert_eq!(view.meta.title.as_str(), "Mail");
        assert_eq!(view.meta.username.as_ref().unwrap().as_str(), "alice");
        locked.lock();
        assert!(matches!(locked.item(id), Err(VaultError::Locked)));
    }
}

#[test]
fn single_key_vault_add_backup_later() {
    let mock = MockAuthenticator::new();
    let key = mock.add_key("only");
    let dir = TempDir::new();
    let path = dir.file("vault.efre");
    let mut builder = VaultBuilder::new().unwrap();
    mock.insert(key);
    builder
        .enroll_key(&mock, "Only key", &mut no_progress())
        .unwrap();
    let vault = builder.create(&path).unwrap();
    assert_eq!(vault.slots().len(), 1);
    drop(vault);
    let mut vault = Vault::open(&path).unwrap();
    vault.unlock(&mock).unwrap();
}

#[test]
fn create_never_overwrites_and_needs_a_key() {
    let (fx, vault) = Fixture::new();
    drop(vault);
    let mut builder = VaultBuilder::new().unwrap();
    fx.mock.insert(fx.primary);
    builder
        .enroll_key(&fx.mock, "Other", &mut no_progress())
        .unwrap();
    assert!(matches!(
        builder.create(&fx.path),
        Err(VaultError::AlreadyExists)
    ));
    fx.unlocked(); // the original is untouched

    let empty = VaultBuilder::new().unwrap();
    assert!(matches!(
        empty.create(&fx.dir.file("x.efre")),
        Err(VaultError::NoKeys)
    ));
    assert!(!fx.dir.file("x.efre").exists());
}

#[test]
fn same_key_cannot_be_enrolled_twice() {
    let mock = MockAuthenticator::new();
    let key = mock.add_key("k");
    mock.insert(key);
    let mut builder = VaultBuilder::new().unwrap();
    builder
        .enroll_key(&mock, "One", &mut no_progress())
        .unwrap();
    assert!(matches!(
        builder.enroll_key(&mock, "Two", &mut no_progress()),
        Err(VaultError::Authn(AuthnError::AlreadyEnrolled))
    ));
    assert_eq!(builder.slots().len(), 1);
}

#[test]
fn unlock_outcomes_leave_the_vault_locked() {
    let (fx, vault) = Fixture::new();
    drop(vault);
    let mut vault = fx.reopen();
    let stranger = fx.mock.add_key("stranger");

    fx.mock.unplug();
    assert!(matches!(
        vault.unlock(&fx.mock),
        Err(VaultError::Authn(AuthnError::NoDevice))
    ));
    fx.mock.insert(stranger);
    assert!(matches!(
        vault.unlock(&fx.mock),
        Err(VaultError::Authn(AuthnError::UnknownKey))
    ));
    fx.mock.insert(fx.primary);
    for error in [
        AuthnError::Cancelled,
        AuthnError::Timeout,
        AuthnError::WrongPin,
        AuthnError::PinBlocked,
    ] {
        fx.mock.fail_next(error.clone());
        match vault.unlock(&fx.mock) {
            Err(VaultError::Authn(e)) => assert_eq!(e, error),
            other => panic!("expected {error:?}, got {:?}", other.err()),
        }
        assert!(!vault.is_unlocked());
    }
    fx.mock.block_pin(fx.primary);
    assert!(matches!(
        vault.unlock(&fx.mock),
        Err(VaultError::Authn(AuthnError::PinBlocked))
    ));
    // "Use your backup key".
    fx.mock.insert(fx.backup);
    vault.unlock(&fx.mock).unwrap();
}

#[test]
fn secrets_are_withheld_until_revealed() {
    let (fx, mut vault) = Fixture::new();
    let id = vault.create_item(login("Bank", "bob", "hunter2")).unwrap();
    let view = vault.item(id).unwrap();
    let password = view
        .fields
        .iter()
        .find(|f| f.role == Some(FieldRole::Password))
        .unwrap();
    assert!(
        password.value.is_none(),
        "hidden values never appear in the view"
    );
    let url = view
        .fields
        .iter()
        .find(|f| f.role == Some(FieldRole::Url))
        .unwrap();
    assert_eq!(url.value.as_ref().unwrap().as_str(), "https://example.com");
    assert_eq!(
        vault.reveal_field(id, password.id).unwrap().expose_secret(),
        "hunter2"
    );
    assert_eq!(
        vault
            .reveal_role(id, FieldRole::Password)
            .unwrap()
            .expose_secret(),
        "hunter2"
    );
    assert_eq!(
        vault
            .reveal_role(id, FieldRole::Username)
            .unwrap()
            .expose_secret(),
        "bob"
    );
    assert!(matches!(
        vault.reveal_field(id, 999),
        Err(VaultError::FieldNotFound)
    ));
    assert!(vault.items().unwrap()[0].has_password);
    drop(fx);
}

#[test]
fn item_lifecycle_persists() {
    let (fx, mut vault) = Fixture::new();
    let id = vault
        .create_item(login("Mail", "alice", "old-pass"))
        .unwrap();
    let view = vault.item(id).unwrap();
    let ids: Vec<u32> = view.fields.iter().map(|f| f.id).collect();

    // Edit without ever seeing the password: keep it, change the username, drop the
    // URL field, add a note.
    vault
        .update_item(
            id,
            ItemDraft {
                kind: ItemKind::Login,
                title: "Mail (personal)".into(),
                favorite: true,
                tags: vec!["personal".into(), "email".into()],
                fields: vec![
                    FieldDraft {
                        id: Some(ids[0]),
                        label: "Username".into(),
                        kind: FieldKind::Text,
                        role: Some(FieldRole::Username),
                        value: DraftValue::Set("alice2".into()),
                    },
                    FieldDraft {
                        id: Some(ids[1]),
                        label: "Password".into(),
                        kind: FieldKind::Hidden,
                        role: Some(FieldRole::Password),
                        value: DraftValue::Keep,
                    },
                    field(
                        "Notes",
                        FieldKind::Multiline,
                        Some(FieldRole::Notes),
                        "**markdown**",
                    ),
                ],
            },
        )
        .unwrap();
    assert_eq!(
        vault
            .reveal_role(id, FieldRole::Password)
            .unwrap()
            .expose_secret(),
        "old-pass"
    );
    let view = vault.item(id).unwrap();
    assert_eq!(view.fields.len(), 3);
    assert_eq!(view.fields[2].id, 4, "new fields get fresh ids");
    assert!(view.meta.favorite);

    // Keep on a field that does not exist is rejected; so is Keep for a new field.
    let bad = |field_id| ItemDraft {
        kind: ItemKind::Login,
        title: "x".into(),
        favorite: false,
        tags: vec![],
        fields: vec![FieldDraft {
            id: field_id,
            label: "x".into(),
            kind: FieldKind::Text,
            role: None,
            value: DraftValue::Keep,
        }],
    };
    assert!(matches!(
        vault.update_item(id, bad(Some(77))),
        Err(VaultError::FieldNotFound)
    ));
    assert!(matches!(
        vault.update_item(id, bad(None)),
        Err(VaultError::Invalid(_))
    ));

    // Trash / restore / permanent delete.
    assert!(matches!(
        vault.delete_permanently(id),
        Err(VaultError::NotInTrash)
    ));
    vault.trash(id).unwrap();
    assert!(vault.item(id).unwrap().meta.trashed_at.is_some());
    vault.restore(id).unwrap();
    assert!(vault.item(id).unwrap().meta.trashed_at.is_none());
    vault.set_favorite(id, false).unwrap();

    let other = vault.create_item(login("Old", "x", "y")).unwrap();
    vault.trash(other).unwrap();
    drop(vault);

    let mut vault = fx.unlocked();
    assert_eq!(vault.items().unwrap().len(), 2);
    let view = vault.item(id).unwrap();
    assert_eq!(view.meta.title.as_str(), "Mail (personal)");
    assert!(!view.meta.favorite);
    assert_eq!(vault.empty_trash().unwrap(), 1);
    assert!(matches!(vault.item(other), Err(VaultError::ItemNotFound)));
    vault.trash(id).unwrap();
    vault.delete_permanently(id).unwrap();
    assert!(vault.items().unwrap().is_empty());
    drop(vault);
    assert!(fx.unlocked().items().unwrap().is_empty());
}

#[test]
fn item_validation() {
    let (_fx, mut vault) = Fixture::new();
    let mut draft = login("", "a", "b");
    assert!(matches!(
        vault.create_item(draft),
        Err(VaultError::Invalid(_))
    ));
    draft = login("ok", "a", "b");
    draft.fields[1].kind = FieldKind::Text; // a visible password
    assert!(matches!(
        vault.create_item(draft),
        Err(VaultError::Invalid(_))
    ));
    draft = login("ok", "a", "b");
    draft.tags = vec!["t".into(), "t".into()];
    assert!(matches!(
        vault.create_item(draft),
        Err(VaultError::Invalid(_))
    ));
    let mut huge = login("big", "a", "b");
    huge.fields.push(field(
        "blob",
        FieldKind::Multiline,
        None,
        &"x".repeat(300 * 1024),
    ));
    assert!(matches!(
        vault.create_item(huge),
        Err(VaultError::Invalid(_))
    ));
    assert!(vault.items().unwrap().is_empty());
}

#[test]
fn settings_persist_and_validate() {
    let (fx, mut vault) = Fixture::new();
    assert_eq!(vault.settings().unwrap(), Settings::default());
    assert_eq!(Settings::default().auto_lock_minutes, 5);
    assert_eq!(Settings::default().clipboard_clear_seconds, 30);
    let new = Settings {
        auto_lock_minutes: 15,
        clipboard_clear_seconds: 45,
    };
    vault.set_settings(new).unwrap();
    for bad in [
        Settings {
            auto_lock_minutes: 0,
            ..new
        },
        Settings {
            auto_lock_minutes: 121,
            ..new
        },
        Settings {
            clipboard_clear_seconds: 4,
            ..new
        },
        Settings {
            clipboard_clear_seconds: 301,
            ..new
        },
    ] {
        assert!(vault.set_settings(bad).is_err());
    }
    drop(vault);
    assert_eq!(fx.unlocked().settings().unwrap(), new);
}

#[test]
fn locked_vault_refuses_everything() {
    let (fx, vault) = Fixture::new();
    drop(vault);
    let mut vault = fx.reopen();
    assert!(matches!(
        vault.create_item(login("a", "b", "c")),
        Err(VaultError::Locked)
    ));
    assert!(matches!(vault.settings(), Err(VaultError::Locked)));
    assert!(matches!(
        vault.add_key(&fx.mock, "New", &mut no_progress()),
        Err(VaultError::Locked)
    ));
    assert_eq!(fx.mock.assertions(), 2, "no prompt was shown");
}

#[test]
fn add_key_needs_an_enrolled_key_first() {
    let (fx, mut vault) = Fixture::new();
    let third = fx.mock.add_key("third");
    let (enrolls, asserts) = (fx.mock.enrollments(), fx.mock.assertions());

    // A walk-up attacker with their own key and no enrolled key gets nowhere.
    fx.mock.insert(third);
    assert!(matches!(
        vault.add_key(&fx.mock, "Mine", &mut no_progress()),
        Err(VaultError::Authn(AuthnError::UnknownKey))
    ));
    assert_eq!(fx.mock.enrollments(), enrolls, "no credential was created");

    // Cancelling the confirmation also stops before enrollment.
    fx.mock.insert(fx.primary);
    fx.mock.fail_next(AuthnError::Cancelled);
    assert!(vault.add_key(&fx.mock, "Mine", &mut no_progress()).is_err());
    assert_eq!(fx.mock.enrollments(), enrolls);

    // The real flow: confirm with an enrolled key, then the new key twice.
    let mut steps = Vec::new();
    let progress = &mut |step: KeyStep<'_>| {
        steps.push(format!("{step:?}"));
        // Simulate the user swapping keys when told to.
        if step == KeyStep::CreateCredential {
            fx.mock.insert(third);
        }
    };
    fx.mock.insert(fx.primary);
    let info = vault.add_key(&fx.mock, "Third", progress).unwrap();
    assert_eq!(
        steps,
        ["UseEnrolledKey", "CreateCredential", "ConfirmNewKey"]
    );
    assert_eq!(info.nickname, "Third");
    // Attacker's try + cancelled try + (enrolled-key confirmation + new-key confirmation).
    assert_eq!(fx.mock.assertions() - asserts, 4);
    assert_eq!(fx.mock.enrollments() - enrolls, 1);
    drop(vault);

    // The new key opens the vault.
    fx.mock.insert(third);
    let vault = fx.unlocked();
    assert_eq!(vault.slots().len(), 3);
}

#[test]
fn rename_key_needs_a_touch_and_persists() {
    let (fx, mut vault) = Fixture::new();
    let backup = vault.slots()[1].id;
    let asserts = fx.mock.assertions();
    assert!(
        vault
            .rename_key(&fx.mock, backup, " bad", &mut no_progress())
            .is_err()
    );
    assert_eq!(
        fx.mock.assertions(),
        asserts,
        "invalid input is rejected before prompting"
    );
    vault
        .rename_key(&fx.mock, backup, "Blue keychain", &mut no_progress())
        .unwrap();
    assert_eq!(fx.mock.assertions(), asserts + 1);
    drop(vault);
    assert_eq!(fx.reopen().slots()[1].nickname, "Blue keychain");
}

fn record_rows(path: &std::path::Path) -> Vec<(Vec<u8>, Vec<u8>, Vec<u8>)> {
    let conn = Connection::open(path).unwrap();
    let mut stmt = conn
        .prepare("SELECT id, nonce, ciphertext FROM records ORDER BY id")
        .unwrap();
    stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

#[test]
fn remove_lost_key_rotates_everything() {
    let (fx, mut vault) = Fixture::new();
    let id = vault.create_item(login("Mail", "alice", "pw")).unwrap();
    let backup_slot = vault.slots()[1].id;
    drop(vault);
    let before_copy = fx.dir.file("before.efre");
    copy_file(&fx.path, &before_copy);
    let rows_before = record_rows(&fx.path);

    let mut vault = fx.unlocked();
    let asserts = fx.mock.assertions();
    let mut steps = Vec::new();
    vault
        .remove_key(&fx.mock, backup_slot, &mut |s| steps.push(format!("{s:?}")))
        .unwrap();
    assert_eq!(steps, [r#"UseKey { nickname: "Primary" }"#]);
    assert_eq!(
        fx.mock.assertions(),
        asserts + 1,
        "each remaining key is touched once"
    );
    assert_eq!(vault.slots().len(), 1);
    assert_eq!(
        vault
            .reveal_role(id, FieldRole::Password)
            .unwrap()
            .expose_secret(),
        "pw"
    );
    drop(vault);

    // Every record was re-encrypted: new nonces and new ciphertext, same ids.
    let rows_after = record_rows(&fx.path);
    assert_eq!(rows_before.len(), rows_after.len());
    for (b, a) in rows_before.iter().zip(&rows_after) {
        assert_eq!(b.0, a.0);
        assert_ne!(b.1, a.1);
        assert_ne!(b.2, a.2);
    }

    // The removed key no longer opens the vault; the remaining one does.
    fx.mock.insert(fx.backup);
    assert!(matches!(
        fx.reopen().unlock(&fx.mock),
        Err(VaultError::Authn(AuthnError::UnknownKey))
    ));
    fx.mock.insert(fx.primary);
    assert_eq!(fx.unlocked().items().unwrap().len(), 1);

    // Documented limit: a copy made before the removal still opens with the removed key.
    fx.mock.insert(fx.backup);
    let mut old = Vault::open(&before_copy).unwrap();
    old.unlock(&fx.mock).unwrap();

    // Mixing the old header (with the removed key's slot) into the new file fails closed.
    drop(old);
    let old_header: (Vec<u8>, Vec<u8>, Vec<u8>) = Connection::open(&before_copy)
        .unwrap()
        .query_row("SELECT body, mac, manifest_mac FROM header", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    let conn = Connection::open(&fx.path).unwrap();
    conn.execute(
        "UPDATE header SET body = ?1, mac = ?2, manifest_mac = ?3",
        rusqlite::params![old_header.0, old_header.1, old_header.2],
    )
    .unwrap();
    drop(conn);
    let mut mixed = fx.reopen();
    assert!(matches!(
        mixed.unlock(&fx.mock),
        Err(VaultError::Tampered(efre_core::Tamper::Manifest))
    ));
}

#[test]
fn cancelled_rotation_changes_nothing() {
    let (fx, mut vault) = Fixture::new();
    let third = fx.mock.add_key("third");
    vault
        .add_key(&fx.mock, "Third", &mut |s| {
            if s == KeyStep::CreateCredential {
                fx.mock.insert(third);
            }
        })
        .unwrap();
    vault.create_item(login("Mail", "alice", "pw")).unwrap();
    let to_remove = vault.slots()[0].id;
    drop(vault);
    let bytes_before = std::fs::read(&fx.path).unwrap();

    let mut vault = fx.unlocked(); // third key is inserted
    // The first remaining key (Backup) succeeds, the second (Third) is cancelled.
    let mut n = 0;
    let result = vault.remove_key(&fx.mock, to_remove, &mut |_| {
        n += 1;
        if n == 1 {
            fx.mock.insert(fx.backup);
        } else {
            fx.mock.insert(third);
            fx.mock.fail_next(AuthnError::Cancelled);
        }
    });
    assert!(matches!(
        result,
        Err(VaultError::Authn(AuthnError::Cancelled))
    ));
    assert_eq!(vault.slots().len(), 3);
    drop(vault);
    assert_eq!(
        std::fs::read(&fx.path).unwrap(),
        bytes_before,
        "file untouched"
    );
    for key in [fx.primary, fx.backup, third] {
        fx.mock.insert(key);
        fx.unlocked();
    }
}

#[test]
fn last_key_cannot_be_removed() {
    let (fx, mut vault) = Fixture::new();
    let backup = vault.slots()[1].id;
    vault
        .remove_key(&fx.mock, backup, &mut no_progress())
        .unwrap();
    let primary = vault.slots()[0].id;
    assert!(matches!(
        vault.remove_key(&fx.mock, primary, &mut no_progress()),
        Err(VaultError::LastKey)
    ));
}
