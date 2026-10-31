//! SQLite storage (ARCHITECTURE §7): one file holding the header row and the
//! encrypted records. Tables hold only ids, nonces, ciphertext and the MACed header.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::config::DbConfig;
use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};

use crate::crypto::{ID_LEN, MAC_LEN, MIN_RECORD_CIPHERTEXT, NONCE_LEN};
use crate::error::{Result, VaultError};

/// `'efre'` as a big-endian u32, stored in the SQLite header.
const APPLICATION_ID: i64 = 0x6566_7265;
const STORAGE_VERSION: i64 = 1;

const SQL_HEADER: &str = "CREATE TABLE header (id INTEGER PRIMARY KEY CHECK (id = 1), \
body BLOB NOT NULL, mac BLOB NOT NULL CHECK (length(mac) = 32), \
manifest_mac BLOB NOT NULL CHECK (length(manifest_mac) = 32))";
const SQL_RECORDS: &str = "CREATE TABLE records (id BLOB PRIMARY KEY CHECK (length(id) = 16), \
nonce BLOB NOT NULL CHECK (length(nonce) = 24), \
ciphertext BLOB NOT NULL CHECK (length(ciphertext) >= 272)) WITHOUT ROWID";

/// One stored record.
#[derive(Clone)]
pub(crate) struct RawRecord {
    pub(crate) id: [u8; ID_LEN],
    pub(crate) nonce: [u8; NONCE_LEN],
    pub(crate) ciphertext: Vec<u8>,
}

/// The single header row.
pub(crate) struct HeaderRow {
    pub(crate) body: Vec<u8>,
    pub(crate) mac: [u8; MAC_LEN],
    pub(crate) manifest_mac: [u8; MAC_LEN],
}

pub(crate) struct Store {
    conn: Connection,
}

fn blob_array<const N: usize>(v: Vec<u8>, what: &'static str) -> Result<[u8; N]> {
    v.try_into().map_err(|_| VaultError::Corrupt(what))
}

/// Applies efre's connection settings. Runs before anything else touches the file.
fn configure(conn: &Connection) -> Result<()> {
    // Hardening: no triggers, views, schema writes or extension loading, ever.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_VIEW, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false)?;
    // Hold the file exclusively for the connection's lifetime (no -shm file, and no
    // other process can open or change the vault while efre has it).
    let mode: String = conn.query_row("PRAGMA locking_mode = EXCLUSIVE", [], |r| r.get(0))?;
    if !mode.eq_ignore_ascii_case("exclusive") {
        return Err(VaultError::Storage("could not lock the vault file".into()));
    }
    let journal: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
    if !journal.eq_ignore_ascii_case("wal") {
        return Err(VaultError::Storage("could not enable WAL".into()));
    }
    conn.execute_batch(
        "PRAGMA synchronous = FULL;
         PRAGMA secure_delete = ON;
         PRAGMA temp_store = MEMORY;
         PRAGMA trusted_schema = OFF;
         PRAGMA cell_size_check = ON;
         PRAGMA foreign_keys = ON;",
    )?;
    Ok(())
}

fn open_connection(path: &Path, create: bool) -> Result<Connection> {
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_NOFOLLOW
        | OpenFlags::SQLITE_OPEN_EXRESCODE;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let conn = Connection::open_with_flags(path, flags)?;
    configure(&conn)?;
    Ok(conn)
}

/// Path of the temporary file a new vault is built in before it is linked into place.
fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

impl Store {
    /// Creates a new vault file atomically and refuses to overwrite an existing one.
    ///
    /// The file is fully written as `<path>.tmp`, flushed, then hard-linked to `path`
    /// (which fails if `path` exists) and the temporary name removed.
    pub(crate) fn create(path: &Path, header: &HeaderRow, records: &[RawRecord]) -> Result<Self> {
        if path.exists() {
            return Err(VaultError::AlreadyExists);
        }
        let tmp = temp_path(path);
        // A leftover temporary file is never a valid vault (it was not linked into place).
        for leftover in [tmp.clone(), PathBuf::from(format!("{}-wal", tmp.display()))] {
            if leftover.exists() {
                fs::remove_file(&leftover)?;
            }
        }
        {
            let mut conn = open_connection(&tmp, true)?;
            conn.pragma_update(None, "application_id", APPLICATION_ID)?;
            conn.pragma_update(None, "user_version", STORAGE_VERSION)?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(&format!("{SQL_HEADER}; {SQL_RECORDS};"))?;
            tx.execute(
                "INSERT INTO header (id, body, mac, manifest_mac) VALUES (1, ?1, ?2, ?3)",
                params![header.body, header.mac, header.manifest_mac],
            )?;
            for record in records {
                put_record(&tx, record)?;
            }
            tx.commit()?;
            conn.close().map_err(|(_, e)| VaultError::from(e))?;
        }
        fs::File::open(&tmp)?.sync_all()?;
        if let Err(e) = fs::hard_link(&tmp, path) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        fs::remove_file(&tmp)?;
        Self::open(path)
    }

    /// Opens an existing vault and checks that it is an intact efre vault.
    pub(crate) fn open(path: &Path) -> Result<Self> {
        if !path.is_file() {
            return Err(VaultError::NotFound);
        }
        let conn = open_connection(path, false)?;
        let store = Self { conn };
        store.check()?;
        Ok(store)
    }

    fn check(&self) -> Result<()> {
        let app_id: i64 = self
            .conn
            .query_row("PRAGMA application_id", [], |r| r.get(0))?;
        if app_id != APPLICATION_ID {
            return Err(VaultError::NotAVault);
        }
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > STORAGE_VERSION {
            return Err(VaultError::TooNew);
        }
        if version != STORAGE_VERSION {
            return Err(VaultError::UnsupportedVersion);
        }
        let mut stmt = self.conn.prepare("PRAGMA integrity_check")?;
        let results: Vec<String> = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        if results != ["ok"] {
            return Err(VaultError::Corrupt("database integrity check"));
        }
        let mut stmt = self
            .conn
            .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")?;
        let schema: Vec<(String, String, String, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let expected = [
            ("table", "header", "header", SQL_HEADER),
            ("table", "records", "records", SQL_RECORDS),
        ];
        let matches = schema.len() == expected.len()
            && schema.iter().zip(expected).all(|((t, n, tb, sql), e)| {
                (t.as_str(), n.as_str(), tb.as_str(), sql.as_deref()) == (e.0, e.1, e.2, Some(e.3))
            });
        if !matches {
            return Err(VaultError::Corrupt("unexpected database schema"));
        }
        let rows: i64 = self
            .conn
            .query_row("SELECT count(*) FROM header", [], |r| r.get(0))?;
        if rows != 1 {
            return Err(VaultError::Corrupt("header row"));
        }
        Ok(())
    }

    pub(crate) fn read_header(&self) -> Result<HeaderRow> {
        let (body, mac, manifest_mac): (Vec<u8>, Vec<u8>, Vec<u8>) = self.conn.query_row(
            "SELECT body, mac, manifest_mac FROM header WHERE id = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        Ok(HeaderRow {
            body,
            mac: blob_array(mac, "header MAC")?,
            manifest_mac: blob_array(manifest_mac, "manifest MAC")?,
        })
    }

    pub(crate) fn read_records(&self) -> Result<Vec<RawRecord>> {
        read_records(&self.conn)
    }

    pub(crate) fn read_record(&self, id: &[u8; ID_LEN]) -> Result<Option<RawRecord>> {
        self.conn
            .query_row(
                "SELECT id, nonce, ciphertext FROM records WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .map(to_record)
            .transpose()
    }

    /// Runs `f` in one `BEGIN IMMEDIATE … COMMIT` transaction, then checkpoints the
    /// WAL so `vault.efre` alone is a complete copy (§7).
    pub(crate) fn write<T>(&mut self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        self.checkpoint()?;
        Ok(out)
    }

    fn checkpoint(&self) -> Result<()> {
        let busy: i64 = self
            .conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
        if busy != 0 {
            return Err(VaultError::InUse);
        }
        Ok(())
    }

    /// Rewrites the file so freed pages (old ciphertext, old key slots) are dropped (§6.5).
    pub(crate) fn compact(&mut self) -> Result<()> {
        self.checkpoint()?;
        self.conn.execute_batch("VACUUM")?;
        self.checkpoint()
    }
}

fn to_record((id, nonce, ciphertext): (Vec<u8>, Vec<u8>, Vec<u8>)) -> Result<RawRecord> {
    if ciphertext.len() < MIN_RECORD_CIPHERTEXT {
        return Err(VaultError::Corrupt("record length"));
    }
    Ok(RawRecord {
        id: blob_array(id, "record id")?,
        nonce: blob_array(nonce, "record nonce")?,
        ciphertext,
    })
}

/// All records, strictly ascending by id (the manifest order).
pub(crate) fn read_records(conn: &Connection) -> Result<Vec<RawRecord>> {
    let mut stmt = conn.prepare("SELECT id, nonce, ciphertext FROM records ORDER BY id")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.map(|row| to_record(row?)).collect()
}

pub(crate) fn put_record(tx: &Transaction<'_>, record: &RawRecord) -> Result<()> {
    tx.execute(
        "INSERT OR REPLACE INTO records (id, nonce, ciphertext) VALUES (?1, ?2, ?3)",
        params![record.id, record.nonce, record.ciphertext],
    )?;
    Ok(())
}

pub(crate) fn delete_record(tx: &Transaction<'_>, id: &[u8; ID_LEN]) -> Result<bool> {
    Ok(tx.execute("DELETE FROM records WHERE id = ?1", params![id])? == 1)
}

pub(crate) fn put_header(tx: &Transaction<'_>, header: &HeaderRow) -> Result<()> {
    let n = tx.execute(
        "UPDATE header SET body = ?1, mac = ?2, manifest_mac = ?3 WHERE id = 1",
        params![header.body, header.mac, header.manifest_mac],
    )?;
    if n != 1 {
        return Err(VaultError::Corrupt("header row"));
    }
    Ok(())
}
