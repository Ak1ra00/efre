//! Vault operations (ARCHITECTURE §5.7 and §6).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use efre_authn::{
    AssertRequest, Assertion, Authenticator, AuthnError, CredentialId, EnrollRequest, PrfOutput,
    Salt, SaltRequest,
};
use secrecy::SecretString;

use crate::crypto::{
    ID_LEN, KEY_LEN, ManifestEntry, PayloadBuf, derive_kek, header_mac, manifest_mac, open_record,
    random, seal_record, unwrap_vmk, verify_header_mac, verify_manifest_mac, wrap_vmk,
};
use crate::error::{Result, Tamper, VaultError};
use crate::header::{FORMAT_VERSION, Header, MAX_SLOTS, SCHEMA_VERSION, Slot, validate_nickname};
use crate::item::{
    Field, FieldKind, FieldRole, Item, ItemKind, Settings, Text, decode_payload, encode_payload,
};
use crate::secret::VaultKeys;
use crate::store::{self, HeaderRow, RawRecord, Store};

/// Record id reserved for the encrypted settings record.
const SETTINGS_ID: [u8; ID_LEN] = [0; ID_LEN];

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

fn to_hex(bytes: &[u8; ID_LEN]) -> String {
    use core::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(2 * ID_LEN), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

fn from_hex(s: &str) -> Result<[u8; ID_LEN]> {
    let invalid = || VaultError::Invalid("id");
    if s.len() != 2 * ID_LEN || !s.is_ascii() {
        return Err(invalid());
    }
    let mut out = [0u8; ID_LEN];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).map_err(|_| invalid())?;
    }
    Ok(out)
}

/// Identifies an item. Public: random, stored in plaintext as the record id.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct ItemId([u8; ID_LEN]);

impl ItemId {
    pub fn to_hex(&self) -> String {
        to_hex(&self.0)
    }

    pub fn from_hex(s: &str) -> Result<Self> {
        let id = from_hex(s)?;
        if id == SETTINGS_ID {
            return Err(VaultError::Invalid("id"));
        }
        Ok(Self(id))
    }
}

/// Identifies an enrolled key's slot.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct SlotId([u8; ID_LEN]);

impl SlotId {
    pub fn to_hex(&self) -> String {
        to_hex(&self.0)
    }

    pub fn from_hex(s: &str) -> Result<Self> {
        from_hex(s).map(Self)
    }
}

/// An enrolled key, as shown in Settings and on the unlock screen. While the vault is
/// locked this comes from the not-yet-authenticated header (ARCHITECTURE §5.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotInfo {
    pub id: SlotId,
    pub nickname: String,
    pub enrolled_at: i64,
    pub aaguid: [u8; 16],
}

impl From<&Slot> for SlotInfo {
    fn from(slot: &Slot) -> Self {
        Self {
            id: SlotId(slot.slot_id),
            nickname: slot.nickname.clone(),
            enrolled_at: slot.enrolled_at,
            aaguid: slot.aaguid,
        }
    }
}

/// What the UI should tell the user before each Windows Security prompt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyStep<'a> {
    /// Confirm with any key that is already enrolled.
    UseEnrolledKey,
    /// Insert the new key and create its credential.
    CreateCredential,
    /// Touch the new key once more to confirm it works.
    ConfirmNewKey,
    /// Insert and touch this specific enrolled key (VMK rotation).
    UseKey { nickname: &'a str },
}

/// List metadata for one item (what the webview's list receives, §8.3).
#[derive(Clone, Debug)]
pub struct ItemMeta {
    pub id: ItemId,
    pub kind: ItemKind,
    pub title: Text,
    /// The non-secret username field, if any.
    pub username: Option<Text>,
    pub tags: Vec<Text>,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub trashed_at: Option<i64>,
    pub has_password: bool,
}

/// One field of an opened item. `value` is `None` for secret (hidden) fields: those
/// are only available through [`Vault::reveal_field`].
#[derive(Clone, Debug)]
pub struct FieldView {
    pub id: u32,
    pub label: Text,
    pub kind: FieldKind,
    pub role: Option<FieldRole>,
    pub value: Option<Text>,
}

/// An opened item without its secret values.
#[derive(Clone, Debug)]
pub struct ItemView {
    pub meta: ItemMeta,
    pub fields: Vec<FieldView>,
}

/// A field value in a draft. `Keep` leaves an existing (possibly secret) value
/// untouched, so editing an item never requires sending its secrets to the UI.
pub enum DraftValue {
    Keep,
    Set(String),
}

pub struct FieldDraft {
    /// `None` for a new field; `Some` for an existing one.
    pub id: Option<u32>,
    pub label: String,
    pub kind: FieldKind,
    pub role: Option<FieldRole>,
    pub value: DraftValue,
}

pub struct ItemDraft {
    pub kind: ItemKind,
    pub title: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub fields: Vec<FieldDraft>,
}

struct Session {
    keys: VaultKeys,
    index: BTreeMap<ItemId, ItemMeta>,
    settings: Settings,
}

fn meta(id: ItemId, item: &Item) -> ItemMeta {
    ItemMeta {
        id,
        kind: item.kind,
        title: item.title.clone(),
        username: item
            .field_by_role(FieldRole::Username)
            .filter(|f| !f.kind.is_secret() && !f.value.is_empty())
            .map(|f| f.value.clone()),
        tags: item.tags.clone(),
        favorite: item.favorite,
        created_at: item.created_at,
        updated_at: item.updated_at,
        trashed_at: item.trashed_at,
        has_password: item.field_by_role(FieldRole::Password).is_some(),
    }
}

fn entries(records: &[RawRecord]) -> Vec<ManifestEntry<'_>> {
    records
        .iter()
        .map(|r| ManifestEntry {
            id: &r.id,
            nonce: &r.nonce,
            ciphertext: &r.ciphertext,
        })
        .collect()
}

fn seal(
    keys: &VaultKeys,
    header: &Header,
    id: &[u8; ID_LEN],
    payload: PayloadBuf,
) -> Result<RawRecord> {
    let (nonce, ciphertext) = seal_record(
        keys.data_key(),
        &header.vault_id,
        id,
        header.schema_version,
        payload,
    )?;
    Ok(RawRecord {
        id: *id,
        nonce,
        ciphertext,
    })
}

/// Opens a slot with an assertion's first PRF output.
fn unwrap_slot(
    header: &Header,
    slot: &Slot,
    prf: &PrfOutput,
) -> Result<zeroize::Zeroizing<[u8; KEY_LEN]>> {
    let kek = derive_kek(prf, &Salt(slot.salt), &header.vault_id, &slot.slot_id);
    unwrap_vmk(
        &kek,
        &header.vault_id,
        &slot.slot_id,
        header.format_version,
        &slot.wrap_nonce,
        &slot.wrapped_vmk,
    )
}

/// Asks for one assertion over `slots` (first salts only) and returns the slot that
/// answered with its output.
fn assert_any<'h>(authn: &dyn Authenticator, slots: &'h [Slot]) -> Result<(&'h Slot, Assertion)> {
    let requests: Vec<SaltRequest<'_>> = slots
        .iter()
        .map(|s| SaltRequest {
            credential_id: &s.credential_id,
            first: Salt(s.salt),
            second: None,
        })
        .collect();
    let assertion = authn.assert(&AssertRequest { allow: &requests })?;
    let slot = slots
        .iter()
        .find(|s| s.credential_id == assertion.credential_id)
        .ok_or(AuthnError::InvalidResponse("unexpected credential"))?;
    if assertion.second.is_some() {
        return Err(AuthnError::InvalidResponse("unexpected second output").into());
    }
    Ok((slot, assertion))
}

/// Creates a credential on a new key and wraps `vmk` for it (§6.1, §6.3).
fn enroll_slot(
    authn: &dyn Authenticator,
    vault_id: &[u8; ID_LEN],
    existing: &[Slot],
    vmk: &[u8; KEY_LEN],
    nickname: &str,
    progress: &mut dyn FnMut(KeyStep<'_>),
) -> Result<Slot> {
    validate_nickname(nickname)?;
    if existing.len() >= MAX_SLOTS {
        return Err(VaultError::TooManyKeys);
    }
    let exclude: Vec<CredentialId> = existing.iter().map(|s| s.credential_id.clone()).collect();
    progress(KeyStep::CreateCredential);
    let enrollment = authn.enroll(&EnrollRequest {
        user_id: vault_id,
        exclude: &exclude,
    })?;
    if exclude.contains(&enrollment.credential_id) {
        return Err(AuthnError::AlreadyEnrolled.into());
    }
    let salt = Salt(random()?);
    let slot_id = loop {
        let id: [u8; ID_LEN] = random()?;
        if existing.iter().all(|s| s.slot_id != id) {
            break id;
        }
    };
    progress(KeyStep::ConfirmNewKey);
    let assertion = authn.assert(&AssertRequest {
        allow: &[SaltRequest {
            credential_id: &enrollment.credential_id,
            first: salt,
            second: None,
        }],
    })?;
    if assertion.credential_id != enrollment.credential_id || assertion.second.is_some() {
        return Err(AuthnError::InvalidResponse("unexpected credential").into());
    }
    let kek = derive_kek(&assertion.first, &salt, vault_id, &slot_id);
    let (wrap_nonce, wrapped_vmk) = wrap_vmk(&kek, vault_id, &slot_id, FORMAT_VERSION, vmk)?;
    Ok(Slot {
        slot_id,
        aaguid: enrollment.aaguid.0,
        salt: salt.0,
        enrolled_at: now(),
        credential_id: enrollment.credential_id,
        nickname: nickname.to_owned(),
        wrap_nonce,
        wrapped_vmk,
    })
}

/// Builds a new vault during the first-run wizard (§6.1). Nothing touches the disk
/// until [`VaultBuilder::create`].
pub struct VaultBuilder {
    vault_id: [u8; ID_LEN],
    keys: VaultKeys,
    slots: Vec<Slot>,
}

impl VaultBuilder {
    pub fn new() -> Result<Self> {
        Ok(Self {
            vault_id: random()?,
            keys: VaultKeys::generate()?,
            slots: Vec::new(),
        })
    }

    /// Enrolls one key: two Windows prompts (create, then confirm).
    pub fn enroll_key(
        &mut self,
        authn: &dyn Authenticator,
        nickname: &str,
        progress: &mut dyn FnMut(KeyStep<'_>),
    ) -> Result<SlotInfo> {
        let slot = enroll_slot(
            authn,
            &self.vault_id,
            &self.slots,
            self.keys.vmk(),
            nickname,
            progress,
        )?;
        let info = SlotInfo::from(&slot);
        self.slots.push(slot);
        Ok(info)
    }

    pub fn slots(&self) -> Vec<SlotInfo> {
        self.slots.iter().map(SlotInfo::from).collect()
    }

    /// Writes the vault atomically (refusing to overwrite an existing file) and
    /// returns it unlocked.
    pub fn create(self, path: &Path) -> Result<Vault> {
        if self.slots.is_empty() {
            return Err(VaultError::NoKeys);
        }
        let header = Header {
            format_version: FORMAT_VERSION,
            schema_version: SCHEMA_VERSION,
            vault_id: self.vault_id,
            slots: self.slots,
        };
        let body = header.encode()?;
        let mac = header_mac(self.keys.header_mac_key(), &body);
        let settings = Settings::default();
        let records = vec![seal(
            &self.keys,
            &header,
            &SETTINGS_ID,
            encode_payload(&settings)?,
        )?];
        let manifest_mac = manifest_mac(
            self.keys.manifest_key(),
            header.format_version,
            &header.vault_id,
            &entries(&records),
        )?;
        let row = HeaderRow {
            body,
            mac,
            manifest_mac,
        };
        let store = Store::create(path, &row, &records)?;
        Ok(Vault {
            path: path.to_owned(),
            store,
            header,
            row,
            session: Some(Session {
                keys: self.keys,
                index: BTreeMap::new(),
                settings,
            }),
        })
    }
}

/// An efre vault file, locked or unlocked.
pub struct Vault {
    path: PathBuf,
    store: Store,
    header: Header,
    row: HeaderRow,
    session: Option<Session>,
}

impl Vault {
    /// Opens a vault file (locked). Runs the storage integrity checks and parses the
    /// header strictly; nothing is authenticated until [`Vault::unlock`].
    pub fn open(path: &Path) -> Result<Self> {
        let store = Store::open(path)?;
        let row = store.read_header()?;
        let header = Header::decode(&row.body)?;
        Ok(Self {
            path: path.to_owned(),
            store,
            header,
            row,
            session: None,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn is_unlocked(&self) -> bool {
        self.session.is_some()
    }

    /// Enrolled keys. While locked, these are unauthenticated (§5.6).
    pub fn slots(&self) -> Vec<SlotInfo> {
        self.header.slots.iter().map(SlotInfo::from).collect()
    }

    /// Unlocks with one assertion from any enrolled key, in the order of §5.7.
    pub fn unlock(&mut self, authn: &dyn Authenticator) -> Result<()> {
        if self.session.is_some() {
            return Ok(());
        }
        let (slot, assertion) = assert_any(authn, &self.header.slots)?;
        let keys = {
            let vmk = unwrap_slot(&self.header, slot, &assertion.first)?;
            drop(assertion);
            VaultKeys::from_vmk(&vmk)
        };
        verify_header_mac(keys.header_mac_key(), &self.row.body, &self.row.mac)?;
        let records = self.store.read_records()?;
        verify_manifest_mac(
            keys.manifest_key(),
            self.header.format_version,
            &self.header.vault_id,
            &entries(&records),
            &self.row.manifest_mac,
        )?;
        let mut index = BTreeMap::new();
        let mut settings = None;
        for raw in &records {
            let plaintext = open_record(
                keys.data_key(),
                &self.header.vault_id,
                &raw.id,
                self.header.schema_version,
                &raw.nonce,
                &raw.ciphertext,
            )?;
            if raw.id == SETTINGS_ID {
                let s: Settings = decode_payload(plaintext.payload())?;
                s.validate()
                    .map_err(|_| VaultError::Tampered(Tamper::Record))?;
                settings = Some(s);
            } else {
                let item: Item = decode_payload(plaintext.payload())?;
                item.validate()
                    .map_err(|_| VaultError::Tampered(Tamper::Record))?;
                let id = ItemId(raw.id);
                index.insert(id, meta(id, &item));
            }
        }
        let settings = settings.ok_or(VaultError::Corrupt("settings record missing"))?;
        self.session = Some(Session {
            keys,
            index,
            settings,
        });
        Ok(())
    }

    /// Wipes every key and all decrypted data from memory.
    pub fn lock(&mut self) {
        self.session = None;
    }

    fn session(&self) -> Result<&Session> {
        self.session.as_ref().ok_or(VaultError::Locked)
    }

    // ------------------------------------------------------------------ items

    /// List metadata for every item, including trashed ones.
    pub fn items(&self) -> Result<Vec<&ItemMeta>> {
        Ok(self.session()?.index.values().collect())
    }

    fn load(&self, id: ItemId) -> Result<Item> {
        let session = self.session()?;
        if !session.index.contains_key(&id) {
            return Err(VaultError::ItemNotFound);
        }
        let raw = self
            .store
            .read_record(&id.0)?
            .ok_or(VaultError::ItemNotFound)?;
        let plaintext = open_record(
            session.keys.data_key(),
            &self.header.vault_id,
            &raw.id,
            self.header.schema_version,
            &raw.nonce,
            &raw.ciphertext,
        )?;
        decode_payload(plaintext.payload())
    }

    /// An item with its secret values withheld.
    pub fn item(&self, id: ItemId) -> Result<ItemView> {
        let item = self.load(id)?;
        Ok(ItemView {
            meta: meta(id, &item),
            fields: item
                .fields
                .iter()
                .map(|f| FieldView {
                    id: f.id,
                    label: f.label.clone(),
                    kind: f.kind,
                    role: f.role,
                    value: (!f.kind.is_secret()).then(|| f.value.clone()),
                })
                .collect(),
        })
    }

    /// One field's value, including secret ones (explicit reveal, or copy in Rust).
    pub fn reveal_field(&self, id: ItemId, field_id: u32) -> Result<SecretString> {
        let item = self.load(id)?;
        let field = item.field(field_id).ok_or(VaultError::FieldNotFound)?;
        Ok(SecretString::from(field.value.as_str()))
    }

    /// The value of the field with `role` (Ctrl+C / Ctrl+B shortcuts).
    pub fn reveal_role(&self, id: ItemId, role: FieldRole) -> Result<SecretString> {
        let item = self.load(id)?;
        let field = item.field_by_role(role).ok_or(VaultError::FieldNotFound)?;
        Ok(SecretString::from(field.value.as_str()))
    }

    /// Re-encrypts `upserts`, deletes `deletes`, and refreshes the manifest, all in
    /// one transaction.
    fn write_records(&mut self, upserts: &[RawRecord], deletes: &[[u8; ID_LEN]]) -> Result<()> {
        let Self {
            store,
            header,
            row,
            session,
            ..
        } = self;
        let keys = &session.as_ref().ok_or(VaultError::Locked)?.keys;
        let manifest = store.write(|tx| {
            for id in deletes {
                if !store::delete_record(tx, id)? {
                    return Err(VaultError::ItemNotFound);
                }
            }
            for record in upserts {
                store::put_record(tx, record)?;
            }
            let records = store::read_records(tx)?;
            let manifest = manifest_mac(
                keys.manifest_key(),
                header.format_version,
                &header.vault_id,
                &entries(&records),
            )?;
            store::put_header(
                tx,
                &HeaderRow {
                    body: row.body.clone(),
                    mac: row.mac,
                    manifest_mac: manifest,
                },
            )?;
            Ok(manifest)
        })?;
        row.manifest_mac = manifest;
        Ok(())
    }

    fn save_item(&mut self, id: ItemId, item: &Item) -> Result<()> {
        item.validate()?;
        let session = self.session()?;
        let record = seal(&session.keys, &self.header, &id.0, encode_payload(item)?)?;
        self.write_records(&[record], &[])?;
        let meta = meta(id, item);
        if let Some(session) = self.session.as_mut() {
            session.index.insert(id, meta);
        }
        Ok(())
    }

    fn apply_fields(item: &mut Item, drafts: Vec<FieldDraft>, old: Option<&Item>) -> Result<()> {
        let mut fields = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let existing = |id: u32| {
                old.and_then(|o| o.field(id))
                    .ok_or(VaultError::FieldNotFound)
            };
            let (id, value) = match (draft.id, draft.value) {
                (Some(id), DraftValue::Keep) => (id, existing(id)?.value.clone()),
                (Some(id), DraftValue::Set(v)) => {
                    existing(id)?;
                    (id, Text::from(v))
                }
                (None, DraftValue::Set(v)) => {
                    let id = item.next_field_id;
                    item.next_field_id =
                        id.checked_add(1).ok_or(VaultError::Invalid("field id"))?;
                    (id, Text::from(v))
                }
                (None, DraftValue::Keep) => {
                    return Err(VaultError::Invalid("new field without a value"));
                }
            };
            fields.push(Field {
                id,
                label: Text::from(draft.label),
                kind: draft.kind,
                role: draft.role,
                value,
            });
        }
        item.fields = fields;
        Ok(())
    }

    pub fn create_item(&mut self, draft: ItemDraft) -> Result<ItemId> {
        let session = self.session()?;
        let at = now();
        let mut item = Item {
            kind: draft.kind,
            title: Text::from(draft.title),
            favorite: draft.favorite,
            tags: draft.tags.into_iter().map(Text::from).collect(),
            created_at: at,
            updated_at: at,
            trashed_at: None,
            fields: Vec::new(),
            next_field_id: 1,
        };
        Self::apply_fields(&mut item, draft.fields, None)?;
        let id = loop {
            let id = ItemId(random()?);
            if id.0 != SETTINGS_ID && !session.index.contains_key(&id) {
                break id;
            }
        };
        self.save_item(id, &item)?;
        Ok(id)
    }

    pub fn update_item(&mut self, id: ItemId, draft: ItemDraft) -> Result<()> {
        let old = self.load(id)?;
        let mut item = Item {
            kind: draft.kind,
            title: Text::from(draft.title),
            favorite: draft.favorite,
            tags: draft.tags.into_iter().map(Text::from).collect(),
            created_at: old.created_at,
            updated_at: now().max(old.created_at),
            trashed_at: old.trashed_at,
            fields: Vec::new(),
            next_field_id: old.next_field_id,
        };
        Self::apply_fields(&mut item, draft.fields, Some(&old))?;
        self.save_item(id, &item)
    }

    fn modify(&mut self, id: ItemId, f: impl FnOnce(&mut Item) -> Result<()>) -> Result<()> {
        let mut item = self.load(id)?;
        f(&mut item)?;
        self.save_item(id, &item)
    }

    pub fn set_favorite(&mut self, id: ItemId, favorite: bool) -> Result<()> {
        self.modify(id, |item| {
            item.favorite = favorite;
            Ok(())
        })
    }

    pub fn trash(&mut self, id: ItemId) -> Result<()> {
        self.modify(id, |item| {
            item.trashed_at.get_or_insert(now());
            Ok(())
        })
    }

    pub fn restore(&mut self, id: ItemId) -> Result<()> {
        self.modify(id, |item| {
            item.trashed_at = None;
            Ok(())
        })
    }

    /// Deletes a trashed item for good (secure_delete overwrites its pages).
    pub fn delete_permanently(&mut self, id: ItemId) -> Result<()> {
        let session = self.session()?;
        let meta = session.index.get(&id).ok_or(VaultError::ItemNotFound)?;
        if meta.trashed_at.is_none() {
            return Err(VaultError::NotInTrash);
        }
        self.write_records(&[], &[id.0])?;
        if let Some(session) = self.session.as_mut() {
            session.index.remove(&id);
        }
        Ok(())
    }

    /// Deletes every trashed item. Returns how many were deleted.
    pub fn empty_trash(&mut self) -> Result<usize> {
        let ids: Vec<[u8; ID_LEN]> = self
            .session()?
            .index
            .values()
            .filter(|m| m.trashed_at.is_some())
            .map(|m| m.id.0)
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        self.write_records(&[], &ids)?;
        if let Some(session) = self.session.as_mut() {
            session.index.retain(|_, m| m.trashed_at.is_none());
        }
        Ok(ids.len())
    }

    // --------------------------------------------------------------- settings

    pub fn settings(&self) -> Result<Settings> {
        Ok(self.session()?.settings)
    }

    pub fn set_settings(&mut self, settings: Settings) -> Result<()> {
        settings.validate()?;
        let session = self.session()?;
        let record = seal(
            &session.keys,
            &self.header,
            &SETTINGS_ID,
            encode_payload(&settings)?,
        )?;
        self.write_records(&[record], &[])?;
        if let Some(session) = self.session.as_mut() {
            session.settings = settings;
        }
        Ok(())
    }

    // --------------------------------------------------------- key management

    /// A fresh PIN+touch on any enrolled key that unwraps this vault's VMK (§6.3, D2).
    fn confirm_with_enrolled_key(&self, authn: &dyn Authenticator) -> Result<()> {
        let session = self.session()?;
        let (slot, assertion) = assert_any(authn, &self.header.slots)?;
        let vmk = unwrap_slot(&self.header, slot, &assertion.first)?;
        if !session.keys.same_vmk(&vmk) {
            return Err(VaultError::Tampered(Tamper::KeyMismatch));
        }
        Ok(())
    }

    /// Writes a new header (same VMK) and makes it current.
    fn commit_header(&mut self, header: Header) -> Result<()> {
        let session = self.session()?;
        let body = header.encode()?;
        let row = HeaderRow {
            mac: header_mac(session.keys.header_mac_key(), &body),
            body,
            manifest_mac: self.row.manifest_mac,
        };
        self.store.write(|tx| store::put_header(tx, &row))?;
        self.header = header;
        self.row = row;
        Ok(())
    }

    /// Adds a key: confirm with an enrolled key, then create and confirm the new one
    /// (three prompts).
    pub fn add_key(
        &mut self,
        authn: &dyn Authenticator,
        nickname: &str,
        progress: &mut dyn FnMut(KeyStep<'_>),
    ) -> Result<SlotInfo> {
        validate_nickname(nickname)?;
        if self.header.slots.len() >= MAX_SLOTS {
            return Err(VaultError::TooManyKeys);
        }
        progress(KeyStep::UseEnrolledKey);
        self.confirm_with_enrolled_key(authn)?;
        let session = self.session()?;
        let slot = enroll_slot(
            authn,
            &self.header.vault_id,
            &self.header.slots,
            session.keys.vmk(),
            nickname,
            progress,
        )?;
        let info = SlotInfo::from(&slot);
        let mut header = self.header.clone();
        header.slots.push(slot);
        self.commit_header(header)?;
        Ok(info)
    }

    /// Renames a key after a fresh PIN+touch on any enrolled key.
    pub fn rename_key(
        &mut self,
        authn: &dyn Authenticator,
        slot: SlotId,
        nickname: &str,
        progress: &mut dyn FnMut(KeyStep<'_>),
    ) -> Result<()> {
        validate_nickname(nickname)?;
        self.session()?;
        let index = self
            .header
            .slots
            .iter()
            .position(|s| s.slot_id == slot.0)
            .ok_or(VaultError::KeyNotFound)?;
        progress(KeyStep::UseEnrolledKey);
        self.confirm_with_enrolled_key(authn)?;
        let mut header = self.header.clone();
        header.slots[index].nickname = nickname.to_owned();
        self.commit_header(header)
    }

    /// Removes a (lost) key and rotates the VMK (§6.5): every remaining key is touched
    /// once, proving it still opens the vault (first salt) and deriving its new KEK
    /// (second, fresh salt) in the same touch. All records are re-encrypted under the
    /// new keys in one transaction. Cancelling at any point changes nothing.
    pub fn remove_key(
        &mut self,
        authn: &dyn Authenticator,
        slot: SlotId,
        progress: &mut dyn FnMut(KeyStep<'_>),
    ) -> Result<()> {
        let session = self.session()?;
        if !self.header.slots.iter().any(|s| s.slot_id == slot.0) {
            return Err(VaultError::KeyNotFound);
        }
        if self.header.slots.len() < 2 {
            return Err(VaultError::LastKey);
        }
        let header = &self.header;
        let new_keys = VaultKeys::generate()?;
        let mut new_slots = Vec::with_capacity(header.slots.len() - 1);
        for old in header.slots.iter().filter(|s| s.slot_id != slot.0) {
            progress(KeyStep::UseKey {
                nickname: &old.nickname,
            });
            let new_salt = Salt(random()?);
            let assertion = authn.assert(&AssertRequest {
                allow: &[SaltRequest {
                    credential_id: &old.credential_id,
                    first: Salt(old.salt),
                    second: Some(new_salt),
                }],
            })?;
            if assertion.credential_id != old.credential_id {
                return Err(AuthnError::InvalidResponse("unexpected credential").into());
            }
            let second = assertion
                .second
                .as_ref()
                .ok_or(AuthnError::InvalidResponse("missing second output"))?;
            let old_vmk = unwrap_slot(header, old, &assertion.first)?;
            if !session.keys.same_vmk(&old_vmk) {
                return Err(VaultError::Tampered(Tamper::KeyMismatch));
            }
            let kek = derive_kek(second, &new_salt, &header.vault_id, &old.slot_id);
            let (wrap_nonce, wrapped_vmk) = wrap_vmk(
                &kek,
                &header.vault_id,
                &old.slot_id,
                FORMAT_VERSION,
                new_keys.vmk(),
            )?;
            new_slots.push(Slot {
                salt: new_salt.0,
                wrap_nonce,
                wrapped_vmk,
                ..old.clone()
            });
        }
        let new_header = Header {
            format_version: FORMAT_VERSION,
            schema_version: SCHEMA_VERSION,
            vault_id: header.vault_id,
            slots: new_slots,
        };
        let body = new_header.encode()?;
        let mac = header_mac(new_keys.header_mac_key(), &body);

        // Re-encrypt every record under the new data key with fresh nonces.
        let records = self.store.read_records()?;
        let mut rewritten = Vec::with_capacity(records.len());
        for raw in &records {
            let plaintext = open_record(
                session.keys.data_key(),
                &header.vault_id,
                &raw.id,
                header.schema_version,
                &raw.nonce,
                &raw.ciphertext,
            )?;
            let mut buf = PayloadBuf::new(plaintext.payload().len())?;
            buf.payload_mut().copy_from_slice(plaintext.payload());
            rewritten.push(seal(&new_keys, &new_header, &raw.id, buf)?);
        }
        let manifest = manifest_mac(
            new_keys.manifest_key(),
            new_header.format_version,
            &new_header.vault_id,
            &entries(&rewritten),
        )?;
        let row = HeaderRow {
            body,
            mac,
            manifest_mac: manifest,
        };
        self.store.write(|tx| {
            for record in &rewritten {
                store::put_record(tx, record)?;
            }
            store::put_header(tx, &row)
        })?;
        self.header = new_header;
        self.row = row;
        if let Some(session) = self.session.as_mut() {
            session.keys = new_keys; // the old keys are zeroized here
        }
        // Drop freed pages holding old ciphertext and slots. secure_delete has already
        // zeroed them and the WAL was truncated on commit, so this is defence in depth
        // and its failure does not undo the (committed) rotation.
        let _ = self.store.compact();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_ids_round_trip_and_reject_garbage() {
        let id = ItemId([0xAB; ID_LEN]);
        assert_eq!(ItemId::from_hex(&id.to_hex()).unwrap(), id);
        for bad in [
            "",
            "zz",
            &"0".repeat(31),
            &"0".repeat(33),
            &"g".repeat(32),
            &"é".repeat(16),
        ] {
            assert!(ItemId::from_hex(bad).is_err(), "{bad:?}");
        }
        // The settings record id can never be addressed as an item.
        assert!(ItemId::from_hex(&"0".repeat(32)).is_err());
        assert!(SlotId::from_hex(&"0".repeat(32)).is_ok());
    }
}
