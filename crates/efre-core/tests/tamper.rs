//! Every way of tampering with the vault file must fail closed (SPEC §8).
//!
//! Each test builds a vault, closes it, edits the SQLite file directly the way an
//! attacker with write access could, and checks that efre refuses to open it.

#![allow(clippy::unwrap_used)] // test crate: panicking on unexpected errors is the point

mod common;

use std::path::Path;

use common::{Fixture, TempDir, copy_file, login};
use efre_core::{Tamper, Vault, VaultError};
use proptest::prelude::*;
use rusqlite::{Connection, params};

/// A closed vault with two items, and the item ids.
fn vault_with_items() -> (Fixture, Vec<efre_core::ItemId>) {
    let (fx, mut vault) = Fixture::new();
    let a = vault.create_item(login("Alpha", "a", "pa")).unwrap();
    let b = vault.create_item(login("Beta", "b", "pb")).unwrap();
    drop(vault);
    (fx, vec![a, b])
}

fn sql(path: &Path, statement: &str) {
    Connection::open(path)
        .unwrap()
        .execute_batch(statement)
        .unwrap();
}

fn header_body(path: &Path) -> Vec<u8> {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT body FROM header", [], |r| r.get(0))
        .unwrap()
}

fn set_header_body(path: &Path, body: &[u8]) {
    Connection::open(path)
        .unwrap()
        .execute("UPDATE header SET body = ?1", params![body])
        .unwrap();
}

/// Opens and unlocks; returns the error (tampering must never yield an open vault).
fn open_err(fx: &Fixture) -> VaultError {
    match Vault::open(&fx.path) {
        Err(e) => e,
        Ok(mut vault) => match vault.unlock(&fx.mock) {
            Err(e) => e,
            Ok(()) => panic!("tampered vault was opened"),
        },
    }
}

fn assert_tampered(fx: &Fixture, what: Tamper) {
    match open_err(fx) {
        VaultError::Tampered(t) => assert_eq!(t, what),
        other => panic!("expected Tampered({what:?}), got {other:?}"),
    }
}

#[test]
fn untouched_vault_opens() {
    let (fx, ids) = vault_with_items();
    let vault = fx.unlocked();
    assert_eq!(vault.items().unwrap().len(), ids.len());
}

#[test]
fn every_header_byte_is_protected() {
    let (fx, _) = vault_with_items();
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);
    let body = header_body(&fx.path);
    for i in 0..body.len() {
        copy_file(&pristine, &fx.path);
        let mut changed = body.clone();
        changed[i] ^= 0x01;
        set_header_body(&fx.path, &changed);
        // Depending on the byte this is a parse error, a version error, an unknown
        // credential, a rejected key or a header MAC failure -- never an open vault.
        let _ = open_err(&fx);
    }
}

#[test]
fn header_mac_and_manifest_mac() {
    let (fx, _) = vault_with_items();
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);

    sql(&fx.path, "UPDATE header SET mac = zeroblob(32)");
    assert_tampered(&fx, Tamper::Header);

    copy_file(&pristine, &fx.path);
    sql(&fx.path, "UPDATE header SET manifest_mac = zeroblob(32)");
    assert_tampered(&fx, Tamper::Manifest);

    // A nickname edit is caught by the header MAC after the VMK is unwrapped.
    copy_file(&pristine, &fx.path);
    let mut body = header_body(&fx.path);
    let pos = body.windows(7).position(|w| w == b"Primary").unwrap();
    body[pos] = b'p';
    set_header_body(&fx.path, &body);
    assert_tampered(&fx, Tamper::Header);
}

#[test]
fn downgrade_and_future_versions_are_refused() {
    let (fx, _) = vault_with_items();
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);
    for (offset, value, expected) in [
        (5, 0u8, "UnsupportedVersion"), // format_version 0
        (5, 2, "TooNew"),               // format_version 2
        (7, 0, "UnsupportedVersion"),   // schema_version 0
        (7, 2, "TooNew"),               // schema_version 2
    ] {
        copy_file(&pristine, &fx.path);
        let mut body = header_body(&fx.path);
        body[offset] = value;
        set_header_body(&fx.path, &body);
        let asserts = fx.mock.assertions();
        let err = open_err(&fx);
        assert_eq!(format!("{err:?}"), expected);
        assert_eq!(
            fx.mock.assertions(),
            asserts,
            "refused before asking for the key"
        );
    }
    copy_file(&pristine, &fx.path);
    sql(&fx.path, "PRAGMA user_version = 2");
    assert!(matches!(open_err(&fx), VaultError::TooNew));
    copy_file(&pristine, &fx.path);
    sql(&fx.path, "PRAGMA user_version = 0");
    assert!(matches!(open_err(&fx), VaultError::UnsupportedVersion));
}

#[test]
fn record_tampering_is_caught_by_the_manifest() {
    let (fx, ids) = vault_with_items();
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);
    let id = hex_blob(&ids[0]);

    // Byte-level edits of one record, done in Rust and written back as blobs.
    let edits: [(&str, RecordEdit); 5] = [
        ("first ciphertext byte", |_, ct| ct[0] ^= 1),
        ("last tag byte", |_, ct| *ct.last_mut().unwrap() ^= 1),
        ("nonce byte", |nonce, _| nonce[7] ^= 1),
        ("extra padding bucket", |_, ct| {
            ct.extend_from_slice(&[0; 256])
        }),
        ("ciphertext replaced by zeros", |_, ct| {
            ct.iter_mut().for_each(|b| *b = 0)
        }),
    ];
    for (what, edit) in edits {
        copy_file(&pristine, &fx.path);
        edit_record(&fx.path, &id, edit);
        match open_err(&fx) {
            VaultError::Tampered(Tamper::Manifest) => {}
            other => panic!("{what}: {other:?}"),
        }
    }

    for edit in [
        // Delete an item.
        format!("DELETE FROM records WHERE id = {id}"),
        // Swap two items' ciphertexts.
        format!(
            "UPDATE records SET ciphertext = (SELECT ciphertext FROM records WHERE id = {other}), \
             nonce = (SELECT nonce FROM records WHERE id = {other}) WHERE id = {id}",
            other = hex_blob(&ids[1])
        ),
    ] {
        copy_file(&pristine, &fx.path);
        sql(&fx.path, &edit);
        assert_tampered(&fx, Tamper::Manifest);
    }

    // Shorter than one padded bucket: the schema's CHECK blocks it, and an attacker who
    // disables CHECK constraints is stopped by the reader's own length check.
    copy_file(&pristine, &fx.path);
    let conn = Connection::open(&fx.path).unwrap();
    conn.execute_batch("PRAGMA ignore_check_constraints = ON")
        .unwrap();
    conn.execute(
        &format!("UPDATE records SET ciphertext = ?1 WHERE id = {id}"),
        params![vec![0u8; 16]],
    )
    .unwrap();
    drop(conn);
    assert!(matches!(open_err(&fx), VaultError::Corrupt(_)));
}

/// Edits a record's (nonce, ciphertext) in place.
type RecordEdit = fn(&mut Vec<u8>, &mut Vec<u8>);

fn edit_record(path: &Path, id: &str, edit: RecordEdit) {
    let conn = Connection::open(path).unwrap();
    let (mut nonce, mut ct): (Vec<u8>, Vec<u8>) = conn
        .query_row(
            &format!("SELECT nonce, ciphertext FROM records WHERE id = {id}"),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    edit(&mut nonce, &mut ct);
    conn.execute(
        &format!("UPDATE records SET nonce = ?1, ciphertext = ?2 WHERE id = {id}"),
        params![nonce, ct],
    )
    .unwrap();
}

#[test]
fn single_record_rollback_is_detected() {
    let (fx, ids) = vault_with_items();
    let old = fx.dir.file("old.efre");
    copy_file(&fx.path, &old);
    {
        let mut vault = fx.unlocked();
        vault.set_favorite(ids[0], true).unwrap(); // re-encrypts that record
    }
    // Put the item's old ciphertext back (e.g. to restore an old password).
    let (nonce, ct): (Vec<u8>, Vec<u8>) = Connection::open(&old)
        .unwrap()
        .query_row(
            &format!(
                "SELECT nonce, ciphertext FROM records WHERE id = {}",
                hex_blob(&ids[0])
            ),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    Connection::open(&fx.path)
        .unwrap()
        .execute(
            &format!(
                "UPDATE records SET nonce = ?1, ciphertext = ?2 WHERE id = {}",
                hex_blob(&ids[0])
            ),
            params![nonce, ct],
        )
        .unwrap();
    assert_tampered(&fx, Tamper::Manifest);
}

#[test]
fn records_and_slots_from_another_vault_are_refused() {
    let (fx, _) = vault_with_items();
    // A second vault enrolled with the same physical keys.
    let other_dir = TempDir::new();
    let other_path = other_dir.file("other.efre");
    {
        let mut builder = efre_core::VaultBuilder::new().unwrap();
        builder
            .enroll_key(&fx.mock, "Other", &mut common::no_progress())
            .unwrap();
        let mut vault = builder.create(&other_path).unwrap();
        vault.create_item(login("Foreign", "f", "pf")).unwrap();
    }
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);

    // 1. Insert the other vault's record.
    let foreign: (Vec<u8>, Vec<u8>, Vec<u8>) = Connection::open(&other_path)
        .unwrap()
        .query_row(
            "SELECT id, nonce, ciphertext FROM records WHERE id != zeroblob(16)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    Connection::open(&fx.path)
        .unwrap()
        .execute(
            "INSERT INTO records (id, nonce, ciphertext) VALUES (?1, ?2, ?3)",
            params![foreign.0, foreign.1, foreign.2],
        )
        .unwrap();
    assert_tampered(&fx, Tamper::Manifest);

    // 2. Replace this vault's header with the other vault's (whose slot the inserted
    //    key opens): the header MAC verifies, but the records do not belong to it.
    copy_file(&pristine, &fx.path);
    let other_header: (Vec<u8>, Vec<u8>, Vec<u8>) = Connection::open(&other_path)
        .unwrap()
        .query_row("SELECT body, mac, manifest_mac FROM header", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    Connection::open(&fx.path)
        .unwrap()
        .execute(
            "UPDATE header SET body = ?1, mac = ?2, manifest_mac = ?3",
            params![other_header.0, other_header.1, other_header.2],
        )
        .unwrap();
    assert_tampered(&fx, Tamper::Manifest);

    // 3. Graft the other vault's key slot into this header: its AAD binds a different
    //    vault id, so it cannot be unwrapped here.
    copy_file(&pristine, &fx.path);
    let ours = header_body(&fx.path);
    let theirs = other_header.0;
    let mut grafted = ours[..25].to_vec();
    grafted.extend_from_slice(&theirs[25..]); // their single slot
    grafted[24] = 1;
    set_header_body(&fx.path, &grafted);
    assert!(matches!(open_err(&fx), VaultError::KeyRejected));
}

#[test]
fn storage_level_tampering() {
    let (fx, _) = vault_with_items();
    let pristine = fx.dir.file("pristine.efre");
    copy_file(&fx.path, &pristine);

    for (edit, expect) in [
        ("CREATE TABLE extra (x)", "Corrupt"),
        ("CREATE INDEX extra_idx ON records (nonce)", "Corrupt"),
        ("CREATE VIEW v AS SELECT * FROM records", "Corrupt"),
        ("PRAGMA application_id = 1", "NotAVault"),
        (
            "INSERT INTO records VALUES (randomblob(16), zeroblob(24), zeroblob(272))",
            "Tampered",
        ),
    ] {
        copy_file(&pristine, &fx.path);
        sql(&fx.path, edit);
        let err = open_err(&fx);
        assert!(format!("{err:?}").starts_with(expect), "{edit}: {err:?}");
    }

    // A file that is not SQLite at all, and a missing file.
    std::fs::write(&fx.path, b"definitely not a vault").unwrap();
    assert!(matches!(open_err(&fx), VaultError::NotAVault));
    std::fs::remove_file(&fx.path).unwrap();
    assert!(matches!(Vault::open(&fx.path), Err(VaultError::NotFound)));
}

#[cfg(unix)]
#[test]
fn symlinked_vault_path_is_refused() {
    let (fx, _) = vault_with_items();
    let link = fx.dir.file("link.efre");
    std::os::unix::fs::symlink(&fx.path, &link).unwrap();
    assert!(matches!(Vault::open(&link), Err(VaultError::Invalid(_))));
}

#[test]
fn damaged_database_pages_are_refused() {
    let (fx, _) = vault_with_items();
    let mut bytes = std::fs::read(&fx.path).unwrap();
    // Overwrite the second page (the first table's root) with garbage.
    for b in &mut bytes[4096 + 8..4096 + 64] {
        *b = 0xA5;
    }
    std::fs::write(&fx.path, &bytes).unwrap();
    let err = open_err(&fx);
    assert!(
        matches!(
            err,
            VaultError::Corrupt(_) | VaultError::NotAVault | VaultError::Storage(_)
        ),
        "{err:?}"
    );
}

fn hex_blob(id: &efre_core::ItemId) -> String {
    format!("X'{}'", id.to_hex())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Flipping any bit anywhere in the file either makes efre refuse the vault or
    /// leaves the contents exactly as they were (the bit was in unused space).
    #[test]
    fn random_file_corruption_never_alters_contents(
        offset in any::<prop::sample::Index>(),
        bit in 0u8..8,
    ) {
        let (fx, ids) = vault_with_items();
        let mut bytes = std::fs::read(&fx.path).unwrap();
        let i = offset.index(bytes.len());
        bytes[i] ^= 1 << bit;
        std::fs::write(&fx.path, &bytes).unwrap();
        if let Ok(mut vault) = Vault::open(&fx.path)
            && vault.unlock(&fx.mock).is_ok()
        {
            let titles: Vec<String> = ids
                .iter()
                .map(|id| vault.item(*id).unwrap().meta.title.as_str().to_owned())
                .collect();
            prop_assert_eq!(titles, vec!["Alpha".to_owned(), "Beta".to_owned()]);
            prop_assert_eq!(vault.items().unwrap().len(), 2);
        }
    }
}
