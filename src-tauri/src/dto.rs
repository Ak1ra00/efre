//! IPC payloads, exactly as in docs/IPC.md ("Types").
//!
//! Outgoing text that comes from vault contents is a [`WebText`], which is wiped once
//! it has been serialized. Incoming drafts are moved straight into efre-core's
//! zeroizing types. Keys, PRF outputs and KEKs have no representation here at all.

use core::fmt;

use efre_core::{self as vault, KeyStep, SlotInfo};
use serde::{Deserialize, Serialize, Serializer};
use zeroize::Zeroizing;

/// Vault text on its way to the webview (titles, tags, field values, revealed or
/// generated secrets). This is the explicit path to the webview, so it serializes;
/// it is zeroized on drop and never printed.
pub(crate) struct WebText(Zeroizing<String>);

impl WebText {
    pub(crate) fn new(text: &str) -> Self {
        Self(Zeroizing::new(text.to_owned()))
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for WebText {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl fmt::Debug for WebText {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("WebText([REDACTED])")
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AppPhase {
    Unsupported,
    Setup,
    Locked,
    Unlocked,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LockReason {
    Manual,
    Idle,
    Suspend,
    Session,
    Unplug,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyInfo {
    pub(crate) id: String,
    pub(crate) nickname: String,
    pub(crate) enrolled_at: i64,
    pub(crate) aaguid: String,
}

/// An AAGUID in its usual UUID form, e.g. `fa2b99dc-9e39-4257-8f92-4a30d23c4118`.
fn uuid(bytes: &[u8; 16]) -> String {
    use fmt::Write as _;
    let mut out = String::with_capacity(36);
    for (i, byte) in bytes.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

impl From<&SlotInfo> for KeyInfo {
    fn from(slot: &SlotInfo) -> Self {
        Self {
            id: slot.id.to_hex(),
            nickname: slot.nickname.clone(),
            enrolled_at: slot.enrolled_at,
            aaguid: uuid(&slot.aaguid),
        }
    }
}

pub(crate) fn key_infos(slots: &[SlotInfo]) -> Vec<KeyInfo> {
    slots.iter().map(KeyInfo::from).collect()
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppStatus {
    pub(crate) phase: AppPhase,
    pub(crate) api_version: Option<u32>,
    pub(crate) unsupported_reason: Option<String>,
    pub(crate) keys: Vec<KeyInfo>,
    pub(crate) setup_keys: Vec<KeyInfo>,
    pub(crate) single_key_warning: bool,
    pub(crate) last_lock_reason: Option<LockReason>,
    pub(crate) vault_path: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ItemKind {
    Login,
    SecureNote,
    Card,
    Identity,
    Custom,
}

impl From<vault::ItemKind> for ItemKind {
    fn from(kind: vault::ItemKind) -> Self {
        match kind {
            vault::ItemKind::Login => Self::Login,
            vault::ItemKind::SecureNote => Self::SecureNote,
            vault::ItemKind::Card => Self::Card,
            vault::ItemKind::Identity => Self::Identity,
            vault::ItemKind::Custom => Self::Custom,
        }
    }
}

impl From<ItemKind> for vault::ItemKind {
    fn from(kind: ItemKind) -> Self {
        match kind {
            ItemKind::Login => Self::Login,
            ItemKind::SecureNote => Self::SecureNote,
            ItemKind::Card => Self::Card,
            ItemKind::Identity => Self::Identity,
            ItemKind::Custom => Self::Custom,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FieldKind {
    Text,
    Hidden,
    Url,
    Email,
    Phone,
    Date,
    Multiline,
}

impl From<vault::FieldKind> for FieldKind {
    fn from(kind: vault::FieldKind) -> Self {
        match kind {
            vault::FieldKind::Text => Self::Text,
            vault::FieldKind::Hidden => Self::Hidden,
            vault::FieldKind::Url => Self::Url,
            vault::FieldKind::Email => Self::Email,
            vault::FieldKind::Phone => Self::Phone,
            vault::FieldKind::Date => Self::Date,
            vault::FieldKind::Multiline => Self::Multiline,
        }
    }
}

impl From<FieldKind> for vault::FieldKind {
    fn from(kind: FieldKind) -> Self {
        match kind {
            FieldKind::Text => Self::Text,
            FieldKind::Hidden => Self::Hidden,
            FieldKind::Url => Self::Url,
            FieldKind::Email => Self::Email,
            FieldKind::Phone => Self::Phone,
            FieldKind::Date => Self::Date,
            FieldKind::Multiline => Self::Multiline,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FieldRole {
    Username,
    Password,
    Url,
    Notes,
}

impl From<vault::FieldRole> for FieldRole {
    fn from(role: vault::FieldRole) -> Self {
        match role {
            vault::FieldRole::Username => Self::Username,
            vault::FieldRole::Password => Self::Password,
            vault::FieldRole::Url => Self::Url,
            vault::FieldRole::Notes => Self::Notes,
        }
    }
}

impl From<FieldRole> for vault::FieldRole {
    fn from(role: FieldRole) -> Self {
        match role {
            FieldRole::Username => Self::Username,
            FieldRole::Password => Self::Password,
            FieldRole::Url => Self::Url,
            FieldRole::Notes => Self::Notes,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemMeta {
    pub(crate) id: String,
    pub(crate) kind: ItemKind,
    pub(crate) title: WebText,
    pub(crate) username: Option<WebText>,
    pub(crate) tags: Vec<WebText>,
    pub(crate) favorite: bool,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
    pub(crate) trashed_at: Option<i64>,
    pub(crate) has_password: bool,
}

impl From<&vault::ItemMeta> for ItemMeta {
    fn from(meta: &vault::ItemMeta) -> Self {
        Self {
            id: meta.id.to_hex(),
            kind: meta.kind.into(),
            title: WebText::new(meta.title.as_str()),
            username: meta.username.as_ref().map(|u| WebText::new(u.as_str())),
            tags: meta.tags.iter().map(|t| WebText::new(t.as_str())).collect(),
            favorite: meta.favorite,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            trashed_at: meta.trashed_at,
            has_password: meta.has_password,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FieldView {
    pub(crate) id: u32,
    pub(crate) label: WebText,
    pub(crate) kind: FieldKind,
    pub(crate) role: Option<FieldRole>,
    /// `None` for hidden (secret) fields: those need `reveal_field`.
    pub(crate) value: Option<WebText>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ItemView {
    pub(crate) meta: ItemMeta,
    pub(crate) fields: Vec<FieldView>,
}

impl From<&vault::ItemView> for ItemView {
    fn from(view: &vault::ItemView) -> Self {
        Self {
            meta: ItemMeta::from(&view.meta),
            fields: view
                .fields
                .iter()
                .map(|f| FieldView {
                    id: f.id,
                    label: WebText::new(f.label.as_str()),
                    kind: f.kind.into(),
                    role: f.role.map(Into::into),
                    // efre-core already withholds secret values; never send one here.
                    value: if f.kind.is_secret() {
                        None
                    } else {
                        f.value.as_ref().map(|v| WebText::new(v.as_str()))
                    },
                })
                .collect(),
        }
    }
}

/// `"keep"` or `{ "set": string }`. No `Debug`: a set value may be a secret.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum DraftValue {
    Keep,
    Set(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FieldDraft {
    pub(crate) id: Option<u32>,
    pub(crate) label: String,
    pub(crate) kind: FieldKind,
    pub(crate) role: Option<FieldRole>,
    pub(crate) value: DraftValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ItemDraft {
    pub(crate) kind: ItemKind,
    pub(crate) title: String,
    pub(crate) favorite: bool,
    pub(crate) tags: Vec<String>,
    pub(crate) fields: Vec<FieldDraft>,
}

impl From<ItemDraft> for vault::ItemDraft {
    /// Moves every string into efre-core, which wraps it in a zeroizing `Text`.
    fn from(draft: ItemDraft) -> Self {
        Self {
            kind: draft.kind.into(),
            title: draft.title,
            favorite: draft.favorite,
            tags: draft.tags,
            fields: draft
                .fields
                .into_iter()
                .map(|f| vault::FieldDraft {
                    id: f.id,
                    label: f.label,
                    kind: f.kind.into(),
                    role: f.role.map(Into::into),
                    value: match f.value {
                        DraftValue::Keep => vault::DraftValue::Keep,
                        DraftValue::Set(value) => vault::DraftValue::Set(value),
                    },
                })
                .collect(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub(crate) auto_lock_minutes: u16,
    pub(crate) clipboard_clear_seconds: u16,
}

impl From<vault::Settings> for Settings {
    fn from(s: vault::Settings) -> Self {
        Self {
            auto_lock_minutes: s.auto_lock_minutes,
            clipboard_clear_seconds: s.clipboard_clear_seconds,
        }
    }
}

impl From<Settings> for vault::Settings {
    fn from(s: Settings) -> Self {
        Self {
            auto_lock_minutes: s.auto_lock_minutes,
            clipboard_clear_seconds: s.clipboard_clear_seconds,
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyResult {
    pub(crate) clears_in_seconds: u16,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PasswordOptions {
    pub(crate) length: usize,
    pub(crate) lowercase: bool,
    pub(crate) uppercase: bool,
    pub(crate) digits: bool,
    pub(crate) symbols: bool,
    pub(crate) avoid_ambiguous: bool,
}

impl From<PasswordOptions> for vault::generator::PasswordOptions {
    fn from(o: PasswordOptions) -> Self {
        Self {
            length: o.length,
            lowercase: o.lowercase,
            uppercase: o.uppercase,
            digits: o.digits,
            symbols: o.symbols,
            avoid_ambiguous: o.avoid_ambiguous,
        }
    }
}

#[derive(Deserialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PassphraseOptions {
    pub(crate) words: usize,
    pub(crate) separator: String,
    pub(crate) capitalize: bool,
    pub(crate) include_number: bool,
}

impl From<PassphraseOptions> for vault::generator::PassphraseOptions {
    fn from(o: PassphraseOptions) -> Self {
        Self {
            words: o.words,
            separator: o.separator,
            capitalize: o.capitalize,
            include_number: o.include_number,
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Generated {
    pub(crate) value: WebText,
    pub(crate) entropy_bits: f64,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SecurityInfo {
    pub(crate) app_version: String,
    pub(crate) format_version: u16,
    pub(crate) webauthn_api_version: Option<u32>,
    pub(crate) vault_path: String,
    pub(crate) key_count: usize,
    pub(crate) protections: Vec<String>,
    pub(crate) limits: Vec<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum KeyStepKind {
    UseEnrolledKey,
    CreateCredential,
    ConfirmNewKey,
    UseKey,
}

/// Payload of the `key-step` event. `nickname` is set only for `useKey`.
#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyStepEvent {
    pub(crate) step: KeyStepKind,
    pub(crate) nickname: Option<String>,
}

impl From<KeyStep<'_>> for KeyStepEvent {
    fn from(step: KeyStep<'_>) -> Self {
        let (step, nickname) = match step {
            KeyStep::UseEnrolledKey => (KeyStepKind::UseEnrolledKey, None),
            KeyStep::CreateCredential => (KeyStepKind::CreateCredential, None),
            KeyStep::ConfirmNewKey => (KeyStepKind::ConfirmNewKey, None),
            KeyStep::UseKey { nickname } => (KeyStepKind::UseKey, Some(nickname.to_owned())),
        };
        Self { step, nickname }
    }
}

/// Payload of the `locked` event.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LockedEvent {
    pub(crate) reason: LockReason,
}

/// Ids in IPC are exactly 32 lowercase hex digits (docs/IPC.md, "Conventions").
/// efre-core's parser is more lenient, so the boundary checks the exact form first.
fn is_ipc_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn item_id(id: &str) -> Result<vault::ItemId, crate::error::IpcError> {
    if !is_ipc_id(id) {
        return Err(crate::error::IpcError::invalid("Invalid item id."));
    }
    vault::ItemId::from_hex(id).map_err(|_| crate::error::IpcError::invalid("Invalid item id."))
}

pub(crate) fn slot_id(id: &str) -> Result<vault::SlotId, crate::error::IpcError> {
    if !is_ipc_id(id) {
        return Err(crate::error::IpcError::invalid("Invalid key id."));
    }
    vault::SlotId::from_hex(id).map_err(|_| crate::error::IpcError::invalid("Invalid key id."))
}

#[cfg(test)]
mod tests {
    use efre_core::SlotId;
    use serde_json::json;

    use super::*;

    fn to_json(value: &impl Serialize) -> serde_json::Value {
        serde_json::to_value(value).expect("serializes")
    }

    #[test]
    fn enums_use_the_contract_strings() {
        assert_eq!(
            to_json(&[
                AppPhase::Unsupported,
                AppPhase::Setup,
                AppPhase::Locked,
                AppPhase::Unlocked
            ]),
            json!(["unsupported", "setup", "locked", "unlocked"])
        );
        assert_eq!(
            to_json(&[
                LockReason::Manual,
                LockReason::Idle,
                LockReason::Suspend,
                LockReason::Session,
                LockReason::Unplug
            ]),
            json!(["manual", "idle", "suspend", "session", "unplug"])
        );
        assert_eq!(
            to_json(&[
                ItemKind::Login,
                ItemKind::SecureNote,
                ItemKind::Card,
                ItemKind::Identity,
                ItemKind::Custom
            ]),
            json!(["login", "secureNote", "card", "identity", "custom"])
        );
        assert_eq!(
            to_json(&[
                FieldKind::Text,
                FieldKind::Hidden,
                FieldKind::Url,
                FieldKind::Email,
                FieldKind::Phone,
                FieldKind::Date,
                FieldKind::Multiline
            ]),
            json!([
                "text",
                "hidden",
                "url",
                "email",
                "phone",
                "date",
                "multiline"
            ])
        );
        assert_eq!(
            to_json(&[
                FieldRole::Username,
                FieldRole::Password,
                FieldRole::Url,
                FieldRole::Notes
            ]),
            json!(["username", "password", "url", "notes"])
        );
    }

    #[test]
    fn app_status_shape() {
        let status = AppStatus {
            phase: AppPhase::Locked,
            api_version: Some(9),
            unsupported_reason: None,
            keys: vec![KeyInfo {
                id: "ab".repeat(16),
                nickname: "Primary".into(),
                enrolled_at: 1_761_900_000,
                aaguid: "fa2b99dc-9e39-4257-8f92-4a30d23c4118".into(),
            }],
            setup_keys: vec![],
            single_key_warning: true,
            last_lock_reason: Some(LockReason::Idle),
            vault_path: r"C:\Users\me\AppData\Local\efre\vault.efre".into(),
        };
        assert_eq!(
            to_json(&status),
            json!({
                "phase": "locked",
                "apiVersion": 9,
                "unsupportedReason": null,
                "keys": [{
                    "id": "ab".repeat(16),
                    "nickname": "Primary",
                    "enrolledAt": 1_761_900_000,
                    "aaguid": "fa2b99dc-9e39-4257-8f92-4a30d23c4118",
                }],
                "setupKeys": [],
                "singleKeyWarning": true,
                "lastLockReason": "idle",
                "vaultPath": r"C:\Users\me\AppData\Local\efre\vault.efre",
            })
        );
    }

    #[test]
    fn key_info_from_slot() {
        let mut aaguid = [0u8; 16];
        for (i, b) in aaguid.iter_mut().enumerate() {
            *b = u8::try_from(i).expect("small") * 17;
        }
        let slot = SlotInfo {
            id: SlotId::from_hex(&"0f".repeat(16)).expect("valid id"),
            nickname: "Backup".into(),
            enrolled_at: 42,
            aaguid,
        };
        assert_eq!(
            to_json(&KeyInfo::from(&slot)),
            json!({
                "id": "0f".repeat(16),
                "nickname": "Backup",
                "enrolledAt": 42,
                "aaguid": "00112233-4455-6677-8899-aabbccddeeff",
            })
        );
    }

    #[test]
    fn item_meta_and_view_shapes() {
        let meta = ItemMeta {
            id: "01".repeat(16),
            kind: ItemKind::SecureNote,
            title: WebText::new("Mail"),
            username: None,
            tags: vec![WebText::new("work")],
            favorite: true,
            created_at: 1,
            updated_at: 2,
            trashed_at: None,
            has_password: false,
        };
        let view = ItemView {
            meta,
            fields: vec![
                FieldView {
                    id: 1,
                    label: WebText::new("Password"),
                    kind: FieldKind::Hidden,
                    role: Some(FieldRole::Password),
                    value: None,
                },
                FieldView {
                    id: 2,
                    label: WebText::new("Notes"),
                    kind: FieldKind::Multiline,
                    role: None,
                    value: Some(WebText::new("# hi")),
                },
            ],
        };
        assert_eq!(
            to_json(&view),
            json!({
                "meta": {
                    "id": "01".repeat(16),
                    "kind": "secureNote",
                    "title": "Mail",
                    "username": null,
                    "tags": ["work"],
                    "favorite": true,
                    "createdAt": 1,
                    "updatedAt": 2,
                    "trashedAt": null,
                    "hasPassword": false,
                },
                "fields": [
                    { "id": 1, "label": "Password", "kind": "hidden", "role": "password", "value": null },
                    { "id": 2, "label": "Notes", "kind": "multiline", "role": null, "value": "# hi" },
                ],
            })
        );
    }

    #[test]
    fn small_payload_shapes() {
        assert_eq!(
            to_json(&CopyResult {
                clears_in_seconds: 30
            }),
            json!({ "clearsInSeconds": 30 })
        );
        assert_eq!(
            to_json(&Settings {
                auto_lock_minutes: 5,
                clipboard_clear_seconds: 30
            }),
            json!({ "autoLockMinutes": 5, "clipboardClearSeconds": 30 })
        );
        assert_eq!(
            to_json(&Generated {
                value: WebText::new("pw"),
                entropy_bits: 128.5
            }),
            json!({ "value": "pw", "entropyBits": 128.5 })
        );
        assert_eq!(
            to_json(&LockedEvent {
                reason: LockReason::Unplug
            }),
            json!({ "reason": "unplug" })
        );
        let info = SecurityInfo {
            app_version: "0.1.0".into(),
            format_version: 1,
            webauthn_api_version: None,
            vault_path: "v".into(),
            key_count: 2,
            protections: vec!["p".into()],
            limits: vec!["l".into()],
        };
        assert_eq!(
            to_json(&info),
            json!({
                "appVersion": "0.1.0",
                "formatVersion": 1,
                "webauthnApiVersion": null,
                "vaultPath": "v",
                "keyCount": 2,
                "protections": ["p"],
                "limits": ["l"],
            })
        );
    }

    #[test]
    fn key_step_events() {
        let steps = [
            KeyStep::UseEnrolledKey,
            KeyStep::CreateCredential,
            KeyStep::ConfirmNewKey,
            KeyStep::UseKey { nickname: "Backup" },
        ];
        let json: Vec<_> = steps
            .into_iter()
            .map(|s| to_json(&KeyStepEvent::from(s)))
            .collect();
        assert_eq!(
            json,
            [
                json!({ "step": "useEnrolledKey", "nickname": null }),
                json!({ "step": "createCredential", "nickname": null }),
                json!({ "step": "confirmNewKey", "nickname": null }),
                json!({ "step": "useKey", "nickname": "Backup" }),
            ]
        );
    }

    #[test]
    fn drafts_parse_keep_and_set() {
        let draft: ItemDraft = serde_json::from_value(json!({
            "kind": "login",
            "title": "Mail",
            "favorite": false,
            "tags": ["work"],
            "fields": [
                { "id": 1, "label": "Password", "kind": "hidden", "role": "password", "value": "keep" },
                { "id": null, "label": "User", "kind": "text", "role": "username", "value": { "set": "alice" } },
            ],
        }))
        .expect("valid draft");
        let draft = vault::ItemDraft::from(draft);
        assert_eq!(draft.kind, vault::ItemKind::Login);
        assert_eq!(draft.title, "Mail");
        assert_eq!(draft.tags, ["work"]);
        assert!(matches!(draft.fields[0].value, vault::DraftValue::Keep));
        assert_eq!(draft.fields[0].id, Some(1));
        assert_eq!(draft.fields[0].role, Some(vault::FieldRole::Password));
        assert!(matches!(&draft.fields[1].value, vault::DraftValue::Set(v) if v == "alice"));
        assert_eq!(draft.fields[1].id, None);
        assert_eq!(draft.fields[1].kind, vault::FieldKind::Text);
    }

    #[test]
    fn inputs_are_strict() {
        let field = |value: serde_json::Value| json!({ "id": null, "label": "x", "kind": "text", "role": null, "value": value });
        // Unknown draft values, enum strings and fields are rejected.
        for bad in [
            field(json!("set")),
            field(json!({ "keep": null, "set": "x" })),
            field(json!({ "replace": "x" })),
            json!({ "id": null, "label": "x", "kind": "secret", "role": null, "value": "keep" }),
            json!({ "id": null, "label": "x", "kind": "text", "role": null, "value": "keep", "extra": 1 }),
            json!({ "id": -1, "label": "x", "kind": "text", "role": null, "value": "keep" }),
        ] {
            assert!(
                serde_json::from_value::<FieldDraft>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        assert!(
            serde_json::from_value::<Settings>(
                json!({ "autoLockMinutes": 5, "clipboardClearSeconds": 30, "x": 1 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<Settings>(
                json!({ "autoLockMinutes": 5.5, "clipboardClearSeconds": 30 })
            )
            .is_err()
        );
        let options: PasswordOptions = serde_json::from_value(json!({
            "length": 20, "lowercase": true, "uppercase": true, "digits": true,
            "symbols": false, "avoidAmbiguous": true,
        }))
        .expect("valid options");
        assert!(options.avoid_ambiguous && !options.symbols);
        let options: PassphraseOptions = serde_json::from_value(json!({
            "words": 6, "separator": "-", "capitalize": false, "includeNumber": true,
        }))
        .expect("valid options");
        assert!(options.include_number);
        assert_eq!(
            serde_json::from_value::<FieldRole>(json!("notes")).expect("role"),
            FieldRole::Notes
        );
    }

    #[test]
    fn ids_must_be_lowercase_hex() {
        assert!(item_id(&"ab".repeat(16)).is_ok());
        assert!(slot_id(&"00".repeat(16)).is_ok());
        for bad in [
            String::new(),
            "AB".repeat(16),
            "+a".repeat(16),
            "ab".repeat(15),
            "ab".repeat(17),
            "zz".repeat(16),
            " a".repeat(16),
        ] {
            assert_eq!(
                item_id(&bad).map(|_| ()).unwrap_err().code,
                "invalid",
                "{bad:?}"
            );
            assert_eq!(
                slot_id(&bad).map(|_| ()).unwrap_err().code,
                "invalid",
                "{bad:?}"
            );
        }
        // The reserved settings record id is never an item.
        assert_eq!(
            item_id(&"00".repeat(16)).map(|_| ()).unwrap_err().code,
            "invalid"
        );
    }

    #[test]
    fn web_text_is_redacted_in_debug() {
        let text = WebText::new("hunter2");
        assert_eq!(format!("{text:?}"), "WebText([REDACTED])");
        assert_eq!(text.as_str(), "hunter2");
    }
}
