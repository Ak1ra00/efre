//! Record payloads, schema v1 (ARCHITECTURE §5.4 and §5.10).
//!
//! Payloads are CBOR maps with integer keys (`minicbor`), which keeps them compact,
//! avoids string escaping (no stray copies of secrets in scratch buffers), and lets
//! later schema versions add fields. Every string lives in a [`Text`], which is
//! zeroized on drop and redacted in `Debug`.

use core::fmt;

use minicbor::decode::{self, Decoder};
use minicbor::encode::{self, Encoder, Write};
use minicbor::{CborLen, Decode, Encode};
use zeroize::Zeroizing;

use crate::error::{Result, VaultError};

/// A string from the vault: zeroized on drop, never printed.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Text(Zeroizing<String>);

impl Text {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn chars(&self) -> usize {
        self.0.chars().count()
    }
}

impl From<String> for Text {
    /// Takes ownership of the string's allocation (no copy is left behind).
    fn from(s: String) -> Self {
        Self(Zeroizing::new(s))
    }
}

impl From<&str> for Text {
    fn from(s: &str) -> Self {
        Self(Zeroizing::new(s.to_owned()))
    }
}

impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Text([REDACTED])")
    }
}

impl<C> Encode<C> for Text {
    fn encode<W: Write>(
        &self,
        e: &mut Encoder<W>,
        _: &mut C,
    ) -> Result<(), encode::Error<W::Error>> {
        e.str(self.as_str())?;
        Ok(())
    }
}

impl<'b, C> Decode<'b, C> for Text {
    fn decode(d: &mut Decoder<'b>, _: &mut C) -> Result<Self, decode::Error> {
        // `str()` borrows from the (zeroized) plaintext buffer; this is the only copy.
        Ok(Self::from(d.str()?))
    }
}

impl<C> CborLen<C> for Text {
    fn cbor_len(&self, ctx: &mut C) -> usize {
        self.as_str().cbor_len(ctx)
    }
}

/// The item types of the brief (§6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Encode, Decode, CborLen)]
#[cbor(index_only)]
pub enum ItemKind {
    #[n(0)]
    Login,
    #[n(1)]
    SecureNote,
    #[n(2)]
    Card,
    #[n(3)]
    Identity,
    #[n(4)]
    Custom,
}

/// Field types of the brief (§6). `Hidden` fields are secret: they reach the UI only
/// through an explicit reveal, and are copied in Rust.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Encode, Decode, CborLen)]
#[cbor(index_only)]
pub enum FieldKind {
    #[n(0)]
    Text,
    #[n(1)]
    Hidden,
    #[n(2)]
    Url,
    #[n(3)]
    Email,
    #[n(4)]
    Phone,
    #[n(5)]
    Date,
    #[n(6)]
    Multiline,
}

impl FieldKind {
    pub fn is_secret(self) -> bool {
        self == Self::Hidden
    }
}

/// Well-known meaning of a field, used for list subtitles and copy shortcuts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Encode, Decode, CborLen)]
#[cbor(index_only)]
pub enum FieldRole {
    /// Shown as the list subtitle; Ctrl+B copies it.
    #[n(0)]
    Username,
    /// Ctrl+C copies it. Must be a `Hidden` field.
    #[n(1)]
    Password,
    #[n(2)]
    Url,
    /// The Markdown body of a secure note, or free-form notes.
    #[n(3)]
    Notes,
}

#[derive(Clone, PartialEq, Eq, Debug, Encode, Decode, CborLen)]
#[cbor(map)]
pub(crate) struct Field {
    #[n(0)]
    pub(crate) id: u32,
    #[n(1)]
    pub(crate) label: Text,
    #[n(2)]
    pub(crate) kind: FieldKind,
    #[n(3)]
    pub(crate) role: Option<FieldRole>,
    #[n(4)]
    pub(crate) value: Text,
}

#[derive(Clone, PartialEq, Eq, Debug, Encode, Decode, CborLen)]
#[cbor(map)]
pub(crate) struct Item {
    #[n(0)]
    pub(crate) kind: ItemKind,
    #[n(1)]
    pub(crate) title: Text,
    #[n(2)]
    pub(crate) favorite: bool,
    #[n(3)]
    pub(crate) tags: Vec<Text>,
    #[n(4)]
    pub(crate) created_at: i64,
    #[n(5)]
    pub(crate) updated_at: i64,
    #[n(6)]
    pub(crate) trashed_at: Option<i64>,
    #[n(7)]
    pub(crate) fields: Vec<Field>,
    #[n(8)]
    pub(crate) next_field_id: u32,
}

/// Vault settings, stored encrypted in the record with the reserved all-zero id.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Encode, Decode, CborLen)]
#[cbor(map)]
pub struct Settings {
    /// Lock after this many minutes without interaction (1..=120).
    #[n(0)]
    pub auto_lock_minutes: u16,
    /// Clear the clipboard this many seconds after a copy (5..=300).
    #[n(1)]
    pub clipboard_clear_seconds: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_lock_minutes: 5,
            clipboard_clear_seconds: 30,
        }
    }
}

impl Settings {
    pub(crate) fn validate(&self) -> Result<()> {
        if !(1..=120).contains(&self.auto_lock_minutes) {
            return Err(VaultError::Invalid("auto-lock minutes"));
        }
        if !(5..=300).contains(&self.clipboard_clear_seconds) {
            return Err(VaultError::Invalid("clipboard seconds"));
        }
        Ok(())
    }
}

// Limits keep payloads well under the 1 MiB record cap.
pub(crate) const MAX_TITLE_CHARS: usize = 256;
pub(crate) const MAX_TAGS: usize = 32;
pub(crate) const MAX_TAG_CHARS: usize = 48;
pub(crate) const MAX_FIELDS: usize = 128;
pub(crate) const MAX_LABEL_CHARS: usize = 64;
pub(crate) const MAX_VALUE_BYTES: usize = 256 * 1024;

fn single_line(t: &Text) -> bool {
    !t.as_str().chars().any(char::is_control)
}

impl Item {
    /// Checks the invariants every stored item satisfies.
    pub(crate) fn validate(&self) -> Result<()> {
        if self.title.chars() == 0
            || self.title.chars() > MAX_TITLE_CHARS
            || !single_line(&self.title)
        {
            return Err(VaultError::Invalid("title"));
        }
        if self.tags.len() > MAX_TAGS {
            return Err(VaultError::Invalid("too many tags"));
        }
        for (i, tag) in self.tags.iter().enumerate() {
            if tag.chars() == 0 || tag.chars() > MAX_TAG_CHARS || !single_line(tag) {
                return Err(VaultError::Invalid("tag"));
            }
            if self.tags[..i].contains(tag) {
                return Err(VaultError::Invalid("duplicate tag"));
            }
        }
        if self.fields.len() > MAX_FIELDS {
            return Err(VaultError::Invalid("too many fields"));
        }
        let mut total = 0usize;
        for (i, field) in self.fields.iter().enumerate() {
            if field.id == 0 || field.id >= self.next_field_id {
                return Err(VaultError::Invalid("field id"));
            }
            if self.fields[..i].iter().any(|f| f.id == field.id) {
                return Err(VaultError::Invalid("duplicate field id"));
            }
            if field.label.chars() > MAX_LABEL_CHARS || !single_line(&field.label) {
                return Err(VaultError::Invalid("field label"));
            }
            if field.value.as_str().len() > MAX_VALUE_BYTES {
                return Err(VaultError::Invalid("field value is too long"));
            }
            if field.role == Some(FieldRole::Password) && !field.kind.is_secret() {
                return Err(VaultError::Invalid("password fields must be hidden"));
            }
            if let Some(role) = field.role
                && self.fields[..i].iter().any(|f| f.role == Some(role))
            {
                return Err(VaultError::Invalid("duplicate field role"));
            }
            total += field.value.as_str().len();
        }
        if total > MAX_VALUE_BYTES * 3 {
            return Err(VaultError::Invalid("item is too large"));
        }
        if self.created_at > self.updated_at {
            return Err(VaultError::Invalid("timestamps"));
        }
        Ok(())
    }

    pub(crate) fn field(&self, id: u32) -> Option<&Field> {
        self.fields.iter().find(|f| f.id == id)
    }

    pub(crate) fn field_by_role(&self, role: FieldRole) -> Option<&Field> {
        self.fields.iter().find(|f| f.role == Some(role))
    }
}

/// Encodes `value` straight into a padded record buffer (exact size, no reallocation).
pub(crate) fn encode_payload<T: Encode<()> + CborLen<()>>(
    value: &T,
) -> Result<crate::crypto::PayloadBuf> {
    let len = minicbor::len(value);
    let mut buf = crate::crypto::PayloadBuf::new(len)?;
    let mut cursor = encode::write::Cursor::new(buf.payload_mut());
    minicbor::encode(value, &mut cursor).map_err(|_| VaultError::Invalid("encoding failed"))?;
    if cursor.position() != len {
        return Err(VaultError::Invalid("encoding length mismatch"));
    }
    Ok(buf)
}

/// Decodes a payload, rejecting trailing bytes.
pub(crate) fn decode_payload<'b, T: Decode<'b, ()>>(bytes: &'b [u8]) -> Result<T> {
    let mut d = Decoder::new(bytes);
    let value = d
        .decode()
        .map_err(|_| VaultError::Corrupt("item encoding"))?;
    if d.position() != bytes.len() {
        return Err(VaultError::Corrupt("item encoding"));
    }
    Ok(value)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use proptest::prelude::*;

    pub(crate) fn sample_item() -> Item {
        Item {
            kind: ItemKind::Login,
            title: "Example".into(),
            favorite: true,
            tags: vec!["work".into(), "email".into()],
            created_at: 10,
            updated_at: 20,
            trashed_at: None,
            fields: vec![
                Field {
                    id: 1,
                    label: "Username".into(),
                    kind: FieldKind::Text,
                    role: Some(FieldRole::Username),
                    value: "alice".into(),
                },
                Field {
                    id: 2,
                    label: "Password".into(),
                    kind: FieldKind::Hidden,
                    role: Some(FieldRole::Password),
                    value: "correct horse".into(),
                },
            ],
            next_field_id: 3,
        }
    }

    fn round_trip<T>(value: &T) -> T
    where
        T: Encode<()> + CborLen<()> + for<'b> Decode<'b, ()>,
    {
        let buf = encode_payload(value).unwrap();
        // The in-place encoding matches minicbor's own.
        assert_eq!(buf.payload(), minicbor::to_vec(value).unwrap().as_slice());
        decode_payload(buf.payload()).unwrap()
    }

    #[test]
    fn item_round_trip_and_validation() {
        let item = sample_item();
        item.validate().unwrap();
        assert_eq!(round_trip(&item), item);
        assert_eq!(round_trip(&Settings::default()), Settings::default());
    }

    #[test]
    fn debug_never_shows_values() {
        let s = format!("{:?}", sample_item());
        assert!(
            !s.contains("alice") && !s.contains("correct horse") && !s.contains("Example"),
            "{s}"
        );
    }

    #[test]
    fn decode_rejects_trailing_bytes_and_garbage() {
        let mut bytes = minicbor::to_vec(sample_item()).unwrap();
        bytes.push(0);
        assert!(decode_payload::<Item>(&bytes).is_err());
        assert!(decode_payload::<Item>(&[0xFF, 0x00]).is_err());
    }

    #[test]
    fn validation_rules() {
        let mut item = sample_item();
        item.fields[1].kind = FieldKind::Text;
        assert!(item.validate().is_err(), "password must be hidden");
        let mut item = sample_item();
        item.fields[1].id = 1;
        assert!(item.validate().is_err(), "duplicate field id");
        let mut item = sample_item();
        item.fields[1].id = 3;
        assert!(item.validate().is_err(), "field id >= next_field_id");
        let mut item = sample_item();
        item.title = "".into();
        assert!(item.validate().is_err());
        let mut item = sample_item();
        item.tags.push("work".into());
        assert!(item.validate().is_err(), "duplicate tag");
        let mut item = sample_item();
        item.fields[1].role = Some(FieldRole::Username);
        assert!(item.validate().is_err(), "duplicate role");
    }

    fn arb_text(max: usize) -> impl Strategy<Value = Text> {
        proptest::string::string_regex(&format!("[^\\p{{Cc}}]{{1,{max}}}"))
            .unwrap()
            .prop_map(Text::from)
    }

    fn arb_kind() -> impl Strategy<Value = FieldKind> {
        prop_oneof![
            Just(FieldKind::Text),
            Just(FieldKind::Hidden),
            Just(FieldKind::Url),
            Just(FieldKind::Email),
            Just(FieldKind::Phone),
            Just(FieldKind::Date),
            Just(FieldKind::Multiline),
        ]
    }

    fn arb_item() -> impl Strategy<Value = Item> {
        (
            prop_oneof![
                Just(ItemKind::Login),
                Just(ItemKind::SecureNote),
                Just(ItemKind::Card),
                Just(ItemKind::Identity),
                Just(ItemKind::Custom),
            ],
            arb_text(40),
            any::<bool>(),
            proptest::collection::vec(arb_text(12), 0..5),
            any::<i64>(),
            proptest::option::of(any::<i64>()),
            proptest::collection::vec((arb_text(20), arb_kind(), ".{0,200}"), 0..8),
        )
            .prop_map(
                |(kind, title, favorite, tags, at, trashed_at, fields)| Item {
                    kind,
                    title,
                    favorite,
                    tags,
                    created_at: at,
                    updated_at: at,
                    trashed_at,
                    next_field_id: u32::try_from(fields.len()).unwrap() + 1,
                    fields: fields
                        .into_iter()
                        .enumerate()
                        .map(|(i, (label, kind, value))| Field {
                            id: u32::try_from(i).unwrap() + 1,
                            label,
                            kind,
                            role: None,
                            value: Text::from(value),
                        })
                        .collect(),
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(128))]

        #[test]
        fn payload_round_trip(item in arb_item()) {
            prop_assert_eq!(round_trip(&item), item);
        }

        #[test]
        fn decode_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..512)) {
            let _ = decode_payload::<Item>(&bytes);
            let _ = decode_payload::<Settings>(&bytes);
        }
    }
}
