//! Password and passphrase generator (SPEC §6; `generate_password` and
//! `generate_passphrase` in docs/IPC.md).
//!
//! # Randomness
//! Every random choice comes from the OS CSPRNG (`rand::rngs::SysRng`) and is drawn with
//! [`rand::distr::Uniform`]. It samples with Lemire's widening-multiply method and rejects
//! the few draws that would favour some values, so every index is exactly equally likely:
//! there is no modulo bias.
//!
//! rand's `SliceRandom::shuffle` and `IndexedRandom::choose` are deliberately not used.
//! They draw through `random_range`, which rand 0.10 documents as slightly biased unless
//! its `unbiased` feature is enabled. The shuffle here is a Fisher–Yates shuffle whose
//! every index is drawn with `Uniform` as well.
//!
//! If the OS RNG fails, the result is [`VaultError::Rng`]. There is no panic and no
//! fallback to another source.
//!
//! # Memory
//! Each result is written into a zeroed buffer of exactly its final size. The buffer is
//! allocated before any secret byte is written and becomes the [`SecretString`] without
//! being copied or reallocated. The random choices behind a passphrase are wiped on drop.
//! Nothing here is logged.
//!
//! # Character sets
//! - lowercase: `a`–`z` (26 characters);
//! - uppercase: `A`–`Z` (26);
//! - digits: `0`–`9` (10);
//! - symbols: all 32 printable ASCII punctuation characters,
//!   ``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~``.
//!
//! `avoid_ambiguous` leaves out these 14 look-alikes:
//! - `I` `l` `1` `|`: capital i, small L, one and the vertical bar;
//! - `O` `0` `o`: capital o, zero and small o;
//! - `` ` `` `'` `"`: backtick, apostrophe and double quote (which also looks like two
//!   apostrophes);
//! - `,` `.` and `;` `:`, which are hard to tell apart in small fonts.
//!
//! That leaves 24 lowercase letters, 24 uppercase letters, 8 digits and 24 symbols. All
//! four classes give 94 characters, or 80 without look-alikes.
//!
//! # Word list
//! Passphrases use the EFF long word list (7776 = 6⁵ words), embedded verbatim. Its
//! source, licence and SHA-256 are in `wordlist/README.md`. It is parsed and validated
//! once: exactly 7776 unique words, with dice keys 11111 to 66666 in order, each word made
//! of lowercase ASCII letters and hyphens and starting with a letter.

use core::convert::Infallible;
use core::ops::RangeInclusive;
use std::collections::HashSet;
use std::sync::OnceLock;

use rand::distr::{Distribution, Uniform};
use rand::rngs::SysRng;
use rand::{Rng, TryRng};
use secrecy::SecretString;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::error::VaultError;

/// Options for [`password`]. The defaults are the UI defaults in docs/IPC.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PasswordOptions {
    /// Number of characters, 8 to 128.
    pub length: usize,
    /// Include `a`–`z`.
    pub lowercase: bool,
    /// Include `A`–`Z`.
    pub uppercase: bool,
    /// Include `0`–`9`.
    pub digits: bool,
    /// Include ASCII punctuation.
    pub symbols: bool,
    /// Leave out look-alike characters (the exact set is in the module docs).
    pub avoid_ambiguous: bool,
}

impl Default for PasswordOptions {
    fn default() -> Self {
        Self {
            length: 20,
            lowercase: true,
            uppercase: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: false,
        }
    }
}

/// Options for [`passphrase`]. The defaults are the UI defaults in docs/IPC.md.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassphraseOptions {
    /// Number of words, 3 to 12.
    pub words: usize,
    /// Placed between words: 0 to 3 characters, none of them a control character.
    pub separator: String,
    /// Uppercase the first letter of every word.
    pub capitalize: bool,
    /// Append one random digit to one randomly chosen word.
    pub include_number: bool,
}

impl Default for PassphraseOptions {
    fn default() -> Self {
        Self {
            words: 6,
            separator: "-".to_owned(),
            capitalize: false,
            include_number: false,
        }
    }
}

/// A generated password or passphrase.
#[derive(Debug)]
pub struct Generated {
    /// The secret. Its `Debug` output is redacted.
    pub value: SecretString,
    /// Approximate strength in bits; [`password`] and [`passphrase`] say how it is computed.
    pub entropy_bits: f64,
}

const PASSWORD_LENGTH: RangeInclusive<usize> = 8..=128;
const PASSPHRASE_WORDS: RangeInclusive<usize> = 3..=12;
const MAX_WORDS: usize = 12;
const MAX_SEPARATOR_CHARS: usize = 3;

const LOWERCASE: &[u8] = b"abcdefghijklmnopqrstuvwxyz";
const UPPERCASE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &[u8] = b"0123456789";
/// Every printable ASCII character that is not a letter, a digit or the space.
const SYMBOLS: &[u8] = b"!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
/// Removed by `avoid_ambiguous` (see the module docs).
const AMBIGUOUS: &[u8] = b"Il1|O0o`'\",.;:";

/// The EFF long word list, byte for byte (`wordlist/README.md`).
const WORDLIST: &str = include_str!("wordlist/eff_large_wordlist.txt");
/// 6⁵: one word per roll of five dice.
const WORD_COUNT: usize = 7776;
const DICE: usize = 5;

/// Generates a random password.
///
/// One character is drawn from every selected class, the remaining positions are drawn
/// from the union of the selected classes, and then all positions are shuffled. Every draw
/// is uniform.
///
/// `entropy_bits` is `length × log2(alphabet size)`. This is an approximation that
/// slightly overstates the strength, because "at least one of each class" rules some
/// strings out. With all four classes the true entropy of this procedure is about
/// 1.2 bits lower at the minimum length of 8, and 0.3 bits lower at the default length of 20.
///
/// # Errors
/// - [`VaultError::Invalid`] if `length` is outside 8 to 128, or no class is selected.
/// - [`VaultError::Rng`] if the OS random number generator fails.
pub fn password(options: &PasswordOptions) -> Result<Generated, VaultError> {
    password_with(SysRng, options)
}

/// Generates a random passphrase from the EFF long word list.
///
/// Each word is drawn uniformly and independently, and words are joined with
/// `separator`. `capitalize` uppercases each word's first letter. `include_number`
/// appends one uniformly drawn digit (0–9) to the end of one uniformly chosen word, for
/// example `abacus-abdomen7-zoom`.
///
/// `entropy_bits` is `words × log2(7776)`, plus `log2(10) + log2(words)` with
/// `include_number` (which digit, and which word carries it). Capitalisation and the
/// separator are fixed choices and add nothing. The list is prefix-free (no word starts
/// another), so the words stay recoverable even with an empty separator. A hyphen
/// separator can blur the list's four hyphenated words (for example `felt-tip`), which
/// costs a negligible fraction of a bit.
///
/// # Errors
/// - [`VaultError::Invalid`] if `words` is outside 3 to 12, or `separator` has more than
///   3 characters or contains a control character.
/// - [`VaultError::Rng`] if the OS random number generator fails.
pub fn passphrase(options: &PassphraseOptions) -> Result<Generated, VaultError> {
    passphrase_with(SysRng, options)
}

fn password_with<R: TryRng>(rng: R, options: &PasswordOptions) -> Result<Generated, VaultError> {
    if !PASSWORD_LENGTH.contains(&options.length) {
        return Err(VaultError::Invalid(
            "a password must have 8 to 128 characters",
        ));
    }
    let classes: Vec<Vec<u8>> = [
        (options.lowercase, LOWERCASE),
        (options.uppercase, UPPERCASE),
        (options.digits, DIGITS),
        (options.symbols, SYMBOLS),
    ]
    .into_iter()
    .filter(|&(selected, _)| selected)
    .map(|(_, set)| character_class(set, options.avoid_ambiguous))
    .collect();
    if classes.is_empty() {
        return Err(VaultError::Invalid("choose at least one character type"));
    }
    let alphabet = classes.concat();

    let mut rng = LatchingRng::new(rng);
    let mut out = SecretBuf::new(options.length);
    for class in &classes {
        out.push(pick(class, &mut rng)?)?;
    }
    while out.len() < options.length {
        out.push(pick(&alphabet, &mut rng)?)?;
    }
    shuffle(out.as_mut_slice(), &mut rng)?;
    // Nothing drawn after an RNG failure may be used.
    rng.check()?;

    let entropy_bits = options.length as f64 * (alphabet.len() as f64).log2();
    Ok(Generated {
        value: out.into_secret()?,
        entropy_bits,
    })
}

fn passphrase_with<R: TryRng>(
    rng: R,
    options: &PassphraseOptions,
) -> Result<Generated, VaultError> {
    if !PASSPHRASE_WORDS.contains(&options.words) {
        return Err(VaultError::Invalid("a passphrase must have 3 to 12 words"));
    }
    let separator = options.separator.as_str();
    if separator.chars().count() > MAX_SEPARATOR_CHARS || separator.chars().any(char::is_control) {
        return Err(VaultError::Invalid(
            "the separator must be at most 3 characters, with no control characters",
        ));
    }
    let list = wordlist()?;

    let mut rng = LatchingRng::new(rng);
    let mut choices = Choices::default();
    let any_word = uniform(list.len())?;
    let picked = choices.words.get_mut(..options.words).ok_or(INTERNAL)?;
    for word in picked.iter_mut() {
        *word = any_word.sample(&mut rng);
    }
    if options.include_number {
        choices.number_after = Some(uniform(options.words)?.sample(&mut rng));
        choices.digit = pick(DIGITS, &mut rng)?;
    }
    rng.check()?;

    let picked = choices.words.get(..options.words).ok_or(INTERNAL)?;
    let mut len = separator.len() * (options.words - 1) + usize::from(options.include_number);
    for &index in picked {
        len += list.get(index).ok_or(INTERNAL)?.len();
    }
    let mut out = SecretBuf::new(len);
    for (position, &index) in picked.iter().enumerate() {
        if position > 0 {
            out.extend(separator.as_bytes())?;
        }
        let word = list.get(index).ok_or(INTERNAL)?.as_bytes();
        let (&first, rest) = word.split_first().ok_or(INTERNAL)?;
        out.push(if options.capitalize {
            first.to_ascii_uppercase()
        } else {
            first
        })?;
        out.extend(rest)?;
        if choices.number_after == Some(position) {
            out.push(choices.digit)?;
        }
    }

    let words = options.words as f64;
    let mut entropy_bits = words * (WORD_COUNT as f64).log2();
    if options.include_number {
        entropy_bits += (DIGITS.len() as f64).log2() + words.log2();
    }
    Ok(Generated {
        value: out.into_secret()?,
        entropy_bits,
    })
}

/// A broken internal invariant. Never expected; reported instead of panicking.
const INTERNAL: VaultError = VaultError::Invalid("internal generator error");

fn character_class(set: &[u8], avoid_ambiguous: bool) -> Vec<u8> {
    set.iter()
        .copied()
        .filter(|c| !(avoid_ambiguous && AMBIGUOUS.contains(c)))
        .collect()
}

/// `Uniform` over `0..n`.
fn uniform(n: usize) -> Result<Uniform<usize>, VaultError> {
    Uniform::new(0, n).map_err(|_| INTERNAL)
}

/// One uniformly chosen element of `set`.
fn pick<R: Rng>(set: &[u8], rng: &mut R) -> Result<u8, VaultError> {
    let index = uniform(set.len())?.sample(rng);
    set.get(index).copied().ok_or(INTERNAL)
}

/// Durstenfeld's Fisher–Yates shuffle. Every swap partner is drawn uniformly from `0..=i`,
/// so all `n!` orders are equally likely.
fn shuffle<T, R: Rng>(items: &mut [T], rng: &mut R) -> Result<(), VaultError> {
    for i in (1..items.len()).rev() {
        let j = Uniform::new_inclusive(0, i)
            .map_err(|_| INTERNAL)?
            .sample(rng);
        if j > i {
            return Err(INTERNAL);
        }
        items.swap(i, j);
    }
    Ok(())
}

/// Lets rand's samplers, which need an infallible [`Rng`], draw from a fallible RNG
/// without panicking.
///
/// rand's own adapter, `rand_core::UnwrapErr`, panics when the RNG fails. This one
/// remembers the failure and returns all-one bits from then on. Callers must call
/// [`Self::check`] before using anything drawn.
///
/// All-ones also keeps rand's rejection loop finite. Lemire's sampler accepts a 32-bit
/// draw `x` when the low word of `x × range` is at least `2³² mod range`. For
/// `x = 2³² − 1` that low word is `2³² − range`, which is far above the threshold for
/// every range used here (all under 2³¹). So after a failure, each sample costs exactly one
/// draw.
struct LatchingRng<R> {
    inner: R,
    failed: bool,
}

impl<R: TryRng> LatchingRng<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            failed: false,
        }
    }

    /// [`VaultError::Rng`] if any draw failed.
    fn check(&self) -> Result<(), VaultError> {
        if self.failed {
            Err(VaultError::Rng)
        } else {
            Ok(())
        }
    }
}

impl<R: TryRng> TryRng for LatchingRng<R> {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        if !self.failed {
            match self.inner.try_next_u32() {
                Ok(value) => return Ok(value),
                Err(_) => self.failed = true,
            }
        }
        Ok(u32::MAX)
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        if !self.failed {
            match self.inner.try_next_u64() {
                Ok(value) => return Ok(value),
                Err(_) => self.failed = true,
            }
        }
        Ok(u64::MAX)
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        if !self.failed && self.inner.try_fill_bytes(dst).is_ok() {
            return Ok(());
        }
        self.failed = true;
        dst.fill(0xFF);
        Ok(())
    }
}

/// The random choices behind one passphrase. Wiped on drop.
#[derive(Default, Zeroize, ZeroizeOnDrop)]
struct Choices {
    /// Indices into the word list.
    words: [usize; MAX_WORDS],
    /// Which word the digit follows.
    number_after: Option<usize>,
    /// The digit, as ASCII.
    digit: u8,
}

/// A zeroizing output buffer of a fixed size.
///
/// It is allocated, zero-filled, before any secret byte is written and never grows, so no
/// reallocation can leave an unwiped copy behind. [`Self::into_secret`] turns it into the
/// `SecretString` in place.
struct SecretBuf {
    buf: Zeroizing<Box<[u8]>>,
    len: usize,
}

impl SecretBuf {
    fn new(size: usize) -> Self {
        // If `vec!` over-allocates, `into_boxed_slice` reallocates here, while the buffer
        // still holds only zeros.
        Self {
            buf: Zeroizing::new(vec![0u8; size].into_boxed_slice()),
            len: 0,
        }
    }

    fn len(&self) -> usize {
        self.len
    }

    fn push(&mut self, byte: u8) -> Result<(), VaultError> {
        self.extend(&[byte])
    }

    fn extend(&mut self, bytes: &[u8]) -> Result<(), VaultError> {
        let end = self.len.checked_add(bytes.len()).ok_or(INTERNAL)?;
        self.buf
            .get_mut(self.len..end)
            .ok_or(INTERNAL)?
            .copy_from_slice(bytes);
        self.len = end;
        Ok(())
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        // `len <= buf.len()` always holds (see `extend`).
        self.buf.get_mut(..self.len).unwrap_or_default()
    }

    /// The finished buffer as a `SecretString`, without copying it.
    fn into_secret(mut self) -> Result<SecretString, VaultError> {
        if self.len != self.buf.len() {
            return Err(INTERNAL);
        }
        // `Box<[u8]>` -> `Vec` -> `String` -> `Box<str>` reuses the allocation: its
        // capacity equals its length, so the final `into_boxed_str` inside
        // `SecretString::from` does not reallocate.
        let bytes = core::mem::take(&mut *self.buf).into_vec();
        match String::from_utf8(bytes) {
            Ok(text) => Ok(SecretString::from(text)),
            Err(error) => {
                drop(Zeroizing::new(error.into_bytes()));
                Err(INTERNAL)
            }
        }
    }
}

/// The parsed word list, or `None` if the embedded file fails validation.
static WORDS: OnceLock<Option<Vec<&'static str>>> = OnceLock::new();

fn wordlist() -> Result<&'static [&'static str], VaultError> {
    WORDS
        .get_or_init(|| parse_wordlist(WORDLIST))
        .as_deref()
        .ok_or(VaultError::Invalid("the built-in word list is damaged"))
}

/// Parses EFF's dice format, `11111<TAB>abacus<LF>` up to `66666<TAB>zoom<LF>`, and
/// refuses anything else. It requires exactly 7776 lines with their dice keys in order,
/// words of lowercase ASCII letters and hyphens that start with a letter, no duplicates,
/// and a final line feed.
fn parse_wordlist(text: &str) -> Option<Vec<&str>> {
    let body = text.strip_suffix('\n')?;
    let mut words = Vec::with_capacity(WORD_COUNT);
    let mut seen = HashSet::with_capacity(WORD_COUNT);
    for (index, line) in body.split('\n').enumerate() {
        let (key, word) = line.split_once('\t')?;
        let well_formed = key.as_bytes() == dice_key(index)?
            && word.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
            && word.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
        if !well_formed || !seen.insert(word) {
            return None;
        }
        words.push(word);
    }
    (words.len() == WORD_COUNT).then_some(words)
}

/// The dice roll that selects word number `index`: its base-6 digits, plus one.
fn dice_key(index: usize) -> Option<[u8; DICE]> {
    if index >= WORD_COUNT {
        return None;
    }
    let mut key = [0u8; DICE];
    let mut rest = index;
    for digit in key.iter_mut().rev() {
        *digit = b'1' + u8::try_from(rest % 6).ok()?;
        rest /= 6;
    }
    Some(key)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use secrecy::ExposeSecret;
    use sha2::{Digest, Sha256};

    use super::*;

    /// SHA-256 of EFF's `eff_large_wordlist.txt` (see `wordlist/README.md`).
    const WORDLIST_SHA256: &str =
        "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e";

    fn options(length: usize) -> PasswordOptions {
        PasswordOptions {
            length,
            ..PasswordOptions::default()
        }
    }

    fn phrase(words: usize, separator: &str) -> PassphraseOptions {
        PassphraseOptions {
            words,
            separator: separator.to_owned(),
            capitalize: false,
            include_number: false,
        }
    }

    fn generate(options: &PasswordOptions) -> String {
        password(options).unwrap().value.expose_secret().to_owned()
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "{actual} is not {expected}"
        );
    }

    /// Asserts that `count` is within 8 standard deviations of a binomial `(n, p)` mean. A
    /// correct generator fails this with probability below 10⁻¹⁴ per check.
    fn assert_binomial(count: usize, n: usize, p: f64, what: &str) {
        let mean = n as f64 * p;
        let sigma = (n as f64 * p * (1.0 - p)).sqrt();
        let deviation = (count as f64 - mean).abs();
        assert!(
            deviation <= 8.0 * sigma,
            "{what}: {count} is {deviation:.1} from {mean:.1} (8σ = {:.1})",
            8.0 * sigma
        );
    }

    // ----- Word list -----------------------------------------------------------------

    #[test]
    fn embedded_wordlist_is_effs_file() {
        let digest = Sha256::digest(WORDLIST.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, WORDLIST_SHA256);
        assert_eq!(WORDLIST.len(), 108_800);
    }

    #[test]
    fn wordlist_parses_and_is_valid() {
        let words = wordlist().unwrap();
        assert_eq!(words.len(), WORD_COUNT);
        assert_eq!(words.first(), Some(&"abacus"));
        assert_eq!(words.get(1), Some(&"abdomen"));
        assert_eq!(words.last(), Some(&"zoom"));
        let unique: HashSet<_> = words.iter().collect();
        assert_eq!(unique.len(), WORD_COUNT);
        for word in words {
            assert!((3..=9).contains(&word.len()), "{word}");
            assert!(word.bytes().next().unwrap().is_ascii_lowercase(), "{word}");
            assert!(word.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'));
        }
        let hyphenated: Vec<&str> = words.iter().copied().filter(|w| w.contains('-')).collect();
        assert_eq!(hyphenated, ["drop-down", "felt-tip", "t-shirt", "yo-yo"]);
    }

    #[test]
    fn wordlist_is_prefix_free() {
        // The passphrase docs rely on this for empty separators.
        let words: HashSet<&str> = wordlist().unwrap().iter().copied().collect();
        for word in &words {
            for end in 1..word.len() {
                assert!(
                    !words.contains(&word[..end]),
                    "{} starts {word}",
                    &word[..end]
                );
            }
        }
    }

    #[test]
    fn dice_keys_count_in_base_six() {
        assert_eq!(dice_key(0), Some(*b"11111"));
        assert_eq!(dice_key(1), Some(*b"11112"));
        assert_eq!(dice_key(5), Some(*b"11116"));
        assert_eq!(dice_key(6), Some(*b"11121"));
        assert_eq!(dice_key(WORD_COUNT - 1), Some(*b"66666"));
        assert_eq!(dice_key(WORD_COUNT), None);
    }

    #[test]
    fn wordlist_parser_refuses_every_deviation() {
        assert!(parse_wordlist(WORDLIST).is_some());
        let lines: Vec<&str> = WORDLIST.lines().collect();
        let join = |lines: &[String]| lines.iter().map(|l| format!("{l}\n")).collect::<String>();
        let edited = |line: usize, replacement: &str| {
            let mut copy: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
            copy[line] = replacement.to_owned();
            join(&copy)
        };
        let cases = [
            (
                "no final newline",
                WORDLIST.trim_end_matches('\n').to_owned(),
            ),
            ("extra blank line", format!("{WORDLIST}\n")),
            ("CRLF", WORDLIST.replace('\n', "\r\n")),
            (
                "missing line",
                join(
                    &lines[1..]
                        .iter()
                        .map(|l| (*l).to_owned())
                        .collect::<Vec<_>>(),
                ),
            ),
            ("extra line", format!("{WORDLIST}66667\tzzz\n")),
            ("key out of order", edited(1, "11113\tabdomen")),
            ("key not a die", edited(0, "11110\tabacus")),
            ("space instead of tab", edited(0, "11111 abacus")),
            ("duplicate word", edited(1, "11112\tabacus")),
            ("uppercase", edited(0, "11111\tAbacus")),
            ("leading hyphen", edited(0, "11111\t-abacus")),
            ("digit", edited(0, "11111\taba1us")),
            ("non-ASCII", edited(0, "11111\tabacüs")),
            ("empty word", edited(0, "11111\t")),
            ("trailing space", edited(0, "11111\tabacus ")),
        ];
        for (what, text) in cases {
            assert!(parse_wordlist(&text).is_none(), "accepted: {what}");
        }
    }

    // ----- Passwords -------------------------------------------------------------------

    #[test]
    fn password_length_bounds() {
        for length in [0, 1, 7, 129, 1000, usize::MAX] {
            assert!(
                matches!(password(&options(length)), Err(VaultError::Invalid(_))),
                "length {length} accepted"
            );
        }
        for length in [8, 9, 20, 127, 128] {
            assert_eq!(generate(&options(length)).len(), length);
        }
    }

    #[test]
    fn password_needs_a_class() {
        let none = PasswordOptions {
            lowercase: false,
            uppercase: false,
            digits: false,
            symbols: false,
            ..PasswordOptions::default()
        };
        assert!(matches!(password(&none), Err(VaultError::Invalid(_))));
        let none = PasswordOptions {
            avoid_ambiguous: true,
            ..none
        };
        assert!(matches!(password(&none), Err(VaultError::Invalid(_))));
    }

    #[test]
    fn symbol_set_is_all_printable_ascii_punctuation() {
        let expected: Vec<u8> = (0x21u8..=0x7E)
            .filter(|c| !c.is_ascii_alphanumeric())
            .collect();
        assert_eq!(SYMBOLS, expected.as_slice());
        assert_eq!(SYMBOLS.len(), 32);
        for c in AMBIGUOUS {
            assert!(
                LOWERCASE.contains(c)
                    || UPPERCASE.contains(c)
                    || DIGITS.contains(c)
                    || SYMBOLS.contains(c)
            );
        }
        let sizes: Vec<usize> = [LOWERCASE, UPPERCASE, DIGITS, SYMBOLS]
            .iter()
            .map(|set| character_class(set, true).len())
            .collect();
        assert_eq!(sizes, [24, 24, 8, 24]);
    }

    /// Every selected class appears, and nothing from an unselected class does, for every
    /// combination of classes, even at the minimum length.
    #[test]
    fn every_selected_class_is_present() {
        let sets = [LOWERCASE, UPPERCASE, DIGITS, SYMBOLS];
        for mask in 1u8..16 {
            for avoid_ambiguous in [false, true] {
                let selected = |bit: u8| mask & (1 << bit) != 0;
                let options = PasswordOptions {
                    length: 8,
                    lowercase: selected(0),
                    uppercase: selected(1),
                    digits: selected(2),
                    symbols: selected(3),
                    avoid_ambiguous,
                };
                for _ in 0..100 {
                    let value = generate(&options);
                    for (bit, set) in sets.iter().enumerate() {
                        let present = value.bytes().any(|c| set.contains(&c));
                        assert_eq!(present, selected(bit as u8), "{options:?}");
                    }
                    if avoid_ambiguous {
                        assert!(!value.bytes().any(|c| AMBIGUOUS.contains(&c)));
                    }
                }
            }
        }
    }

    #[test]
    fn avoid_ambiguous_excludes_look_alikes() {
        let options = PasswordOptions {
            length: 128,
            avoid_ambiguous: true,
            ..PasswordOptions::default()
        };
        let mut seen = HashSet::new();
        for _ in 0..200 {
            let value = generate(&options);
            assert!(value.bytes().all(|c| !AMBIGUOUS.contains(&c)), "{value}");
            seen.extend(value.bytes());
        }
        // 25,600 draws from 80 characters: all of them show up.
        assert_eq!(seen.len(), 80);
    }

    #[test]
    fn password_entropy() {
        let bits = |options: &PasswordOptions| password(options).unwrap().entropy_bits;
        assert_close(bits(&options(20)), 20.0 * 94f64.log2());
        assert_close(bits(&options(8)), 8.0 * 94f64.log2());
        let no_look_alikes = PasswordOptions {
            avoid_ambiguous: true,
            ..options(20)
        };
        assert_close(bits(&no_look_alikes), 20.0 * 80f64.log2());
        let digits = PasswordOptions {
            length: 12,
            lowercase: false,
            uppercase: false,
            digits: true,
            symbols: false,
            avoid_ambiguous: true,
        };
        assert_close(bits(&digits), 12.0 * 3.0);
        let letters = PasswordOptions {
            digits: false,
            symbols: false,
            ..options(10)
        };
        assert_close(bits(&letters), 10.0 * 52f64.log2());
    }

    /// Single class: every position is uniform over the class.
    #[test]
    fn password_characters_are_uniform() {
        let options = PasswordOptions {
            length: 128,
            lowercase: true,
            uppercase: false,
            digits: false,
            symbols: false,
            avoid_ambiguous: false,
        };
        let mut counts: HashMap<u8, usize> = HashMap::new();
        let rounds = 1000;
        for _ in 0..rounds {
            for c in generate(&options).bytes() {
                *counts.entry(c).or_default() += 1;
            }
        }
        assert_eq!(counts.len(), 26);
        for (c, count) in counts {
            assert_binomial(count, rounds * 128, 1.0 / 26.0, &format!("'{}'", c as char));
        }
    }

    /// The guaranteed characters are written first; after the shuffle every position must
    /// have the same chance of holding a digit.
    #[test]
    fn guaranteed_characters_are_shuffled() {
        let options = options(8);
        let rounds = 4000;
        let mut digits_at = [0usize; 8];
        for _ in 0..rounds {
            for (position, c) in generate(&options).bytes().enumerate() {
                if c.is_ascii_digit() {
                    digits_at[position] += 1;
                }
            }
        }
        // One guaranteed digit plus 4 draws from 94 characters (10 digits), spread over 8
        // positions.
        let p = (1.0 + 4.0 * 10.0 / 94.0) / 8.0;
        for (position, count) in digits_at.iter().enumerate() {
            assert_binomial(*count, rounds, p, &format!("digits at {position}"));
        }
    }

    #[test]
    fn shuffle_is_uniform_over_permutations() {
        let mut rng = LatchingRng::new(SysRng);
        let mut counts: HashMap<[u8; 3], usize> = HashMap::new();
        let rounds = 60_000;
        for _ in 0..rounds {
            let mut items = [0u8, 1, 2];
            shuffle(&mut items, &mut rng).unwrap();
            *counts.entry(items).or_default() += 1;
        }
        rng.check().unwrap();
        assert_eq!(counts.len(), 6);
        for (order, count) in counts {
            assert_binomial(count, rounds, 1.0 / 6.0, &format!("{order:?}"));
        }
    }

    // ----- Passphrases -----------------------------------------------------------------

    fn index_of() -> HashMap<&'static str, usize> {
        wordlist()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, w)| (*w, i))
            .collect()
    }

    #[test]
    fn passphrase_word_count_bounds() {
        for words in [0, 1, 2, 13, 100] {
            assert!(
                matches!(passphrase(&phrase(words, "-")), Err(VaultError::Invalid(_))),
                "{words} words accepted"
            );
        }
        let index = index_of();
        for words in 3..=12 {
            let value = passphrase(&phrase(words, " ")).unwrap().value;
            let parts: Vec<&str> = value.expose_secret().split(' ').collect();
            assert_eq!(parts.len(), words);
            assert!(parts.iter().all(|p| index.contains_key(p)));
        }
    }

    #[test]
    fn separator_rules() {
        for bad in [
            "abcd", "----", "\n", "\t", "-\u{0}", "\u{7f}", "\u{85}", "a\rb",
        ] {
            assert!(
                matches!(passphrase(&phrase(4, bad)), Err(VaultError::Invalid(_))),
                "separator {bad:?} accepted"
            );
        }
        // Separators that cannot occur inside a word: the words can be split back out.
        let index = index_of();
        for good in [" ", "...", "·•‿", "🙂", "+/="] {
            let value = passphrase(&phrase(4, good)).unwrap().value;
            let parts: Vec<&str> = value.expose_secret().split(good).collect();
            assert_eq!(parts.len(), 4, "{good:?}");
            assert!(parts.iter().all(|p| index.contains_key(p)), "{good:?}");
        }
        // Empty, a hyphen, or letters are allowed too.
        for good in ["", "-", "ab", "x"] {
            let value = passphrase(&phrase(4, good)).unwrap().value;
            assert!(value.expose_secret().len() >= 4 * 3 + 3 * good.len());
        }
        let joined = passphrase(&phrase(4, "")).unwrap().value;
        assert!(
            joined
                .expose_secret()
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'-')
        );
    }

    #[test]
    fn capitalize_uppercases_each_first_letter() {
        let index = index_of();
        let options = PassphraseOptions {
            capitalize: true,
            ..phrase(12, " ")
        };
        for _ in 0..50 {
            let value = passphrase(&options).unwrap().value;
            for part in value.expose_secret().split(' ') {
                let mut bytes = part.bytes();
                assert!(bytes.next().unwrap().is_ascii_uppercase(), "{part}");
                assert!(bytes.all(|b| b.is_ascii_lowercase() || b == b'-'), "{part}");
                assert!(index.contains_key(part.to_ascii_lowercase().as_str()));
            }
        }
    }

    #[test]
    fn include_number_appends_one_digit_to_one_word() {
        let index = index_of();
        let options = PassphraseOptions {
            include_number: true,
            capitalize: true,
            ..phrase(5, "+")
        };
        for _ in 0..200 {
            let value = passphrase(&options).unwrap().value;
            let text = value.expose_secret();
            assert_eq!(text.bytes().filter(u8::is_ascii_digit).count(), 1, "{text}");
            let parts: Vec<&str> = text.split('+').collect();
            assert_eq!(parts.len(), 5);
            let with_digit: Vec<&&str> = parts
                .iter()
                .filter(|p| p.bytes().any(|b| b.is_ascii_digit()))
                .collect();
            assert_eq!(with_digit.len(), 1);
            assert!(
                with_digit[0].bytes().last().unwrap().is_ascii_digit(),
                "{text}"
            );
            for part in parts {
                let word = part.trim_end_matches(|c: char| c.is_ascii_digit());
                assert!(
                    index.contains_key(word.to_ascii_lowercase().as_str()),
                    "{part}"
                );
            }
        }
    }

    #[test]
    fn passphrase_entropy() {
        let bits = |options: &PassphraseOptions| passphrase(options).unwrap().entropy_bits;
        let per_word = 7776f64.log2();
        assert_close(bits(&phrase(6, "-")), 6.0 * per_word);
        assert_close(bits(&phrase(3, "")), 3.0 * per_word);
        assert_close(bits(&phrase(12, " ")), 12.0 * per_word);
        let numbered = PassphraseOptions {
            include_number: true,
            ..phrase(6, "-")
        };
        assert_close(bits(&numbered), 6.0 * per_word + 10f64.log2() + 6f64.log2());
        let capitalized = PassphraseOptions {
            capitalize: true,
            ..phrase(6, "-")
        };
        assert_close(bits(&capitalized), 6.0 * per_word);
        assert_close(6.0 * per_word, 77.548_875_021_634_68);
    }

    /// Word choices are uniform: bucket them by their first and last die.
    #[test]
    fn passphrase_words_are_uniform() {
        let index = index_of();
        let rounds = 3000;
        let mut first_die = [0usize; 6];
        let mut last_die = [0usize; 6];
        for _ in 0..rounds {
            let value = passphrase(&phrase(12, " ")).unwrap().value;
            for part in value.expose_secret().split(' ') {
                let i = index[part];
                first_die[i / 1296] += 1;
                last_die[i % 6] += 1;
            }
        }
        for (die, buckets) in [("first", first_die), ("last", last_die)] {
            for (face, count) in buckets.iter().enumerate() {
                assert_binomial(*count, rounds * 12, 1.0 / 6.0, &format!("{die} die {face}"));
            }
        }
    }

    /// The digit's word and value are uniform too.
    #[test]
    fn passphrase_number_is_uniform() {
        let options = PassphraseOptions {
            include_number: true,
            ..phrase(3, " ")
        };
        let rounds = 3000;
        let mut word_counts = [0usize; 3];
        let mut digit_counts = [0usize; 10];
        for _ in 0..rounds {
            let value = passphrase(&options).unwrap().value;
            for (position, part) in value.expose_secret().split(' ').enumerate() {
                if let Some(d) = part.bytes().find(u8::is_ascii_digit) {
                    word_counts[position] += 1;
                    digit_counts[usize::from(d - b'0')] += 1;
                }
            }
        }
        for (position, count) in word_counts.iter().enumerate() {
            assert_binomial(
                *count,
                rounds,
                1.0 / 3.0,
                &format!("digit in word {position}"),
            );
        }
        for (digit, count) in digit_counts.iter().enumerate() {
            assert_binomial(*count, rounds, 0.1, &format!("digit {digit}"));
        }
    }

    // ----- RNG failure ------------------------------------------------------------------

    #[derive(Debug)]
    struct Broken;

    impl core::fmt::Display for Broken {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            f.write_str("broken RNG")
        }
    }

    impl core::error::Error for Broken {}

    /// Works for `ok` draws, then fails forever.
    struct FailsAfter {
        ok: usize,
    }

    impl FailsAfter {
        fn draw(&mut self) -> Result<(), Broken> {
            if self.ok == 0 {
                return Err(Broken);
            }
            self.ok -= 1;
            Ok(())
        }
    }

    impl TryRng for FailsAfter {
        type Error = Broken;

        fn try_next_u32(&mut self) -> Result<u32, Broken> {
            self.draw()
                .and_then(|()| SysRng.try_next_u32().map_err(|_| Broken))
        }

        fn try_next_u64(&mut self) -> Result<u64, Broken> {
            self.draw()
                .and_then(|()| SysRng.try_next_u64().map_err(|_| Broken))
        }

        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Broken> {
            self.draw()
                .and_then(|()| SysRng.try_fill_bytes(dst).map_err(|_| Broken))
        }
    }

    #[test]
    fn rng_failure_is_an_error_not_a_panic() {
        let numbered = PassphraseOptions {
            include_number: true,
            ..phrase(12, "-")
        };
        // A password of 128 characters needs at least 128 + 127 = 255 draws (picks plus
        // shuffle); a 12-word numbered passphrase needs at least 14. Fail at every point
        // along the way.
        for ok in 0..255 {
            assert!(matches!(
                password_with(FailsAfter { ok }, &options(128)),
                Err(VaultError::Rng)
            ));
        }
        for ok in 0..14 {
            assert!(matches!(
                passphrase_with(FailsAfter { ok }, &numbered),
                Err(VaultError::Rng)
            ));
        }
        // With enough good draws, both succeed.
        assert!(password_with(FailsAfter { ok: 10_000 }, &options(128)).is_ok());
        assert!(passphrase_with(FailsAfter { ok: 1000 }, &numbered).is_ok());
    }

    #[test]
    fn latching_rng_keeps_failing_and_fills_ones() {
        let mut rng = LatchingRng::new(FailsAfter { ok: 1 });
        assert!(rng.check().is_ok());
        let _ = rng.next_u32();
        assert!(rng.check().is_ok());
        assert_eq!(rng.next_u64(), u64::MAX);
        assert!(matches!(rng.check(), Err(VaultError::Rng)));
        assert_eq!(rng.next_u32(), u32::MAX);
        let mut buf = [0u8; 4];
        rng.fill_bytes(&mut buf);
        assert_eq!(buf, [0xFF; 4]);
        assert!(matches!(rng.check(), Err(VaultError::Rng)));
    }

    // ----- Output handling --------------------------------------------------------------

    #[test]
    fn secret_buf_is_exact() {
        let mut buf = SecretBuf::new(3);
        buf.extend(b"ab").unwrap();
        assert!(buf.extend(b"cd").is_err());
        assert!(SecretBuf::new(2).into_secret().is_err()); // not filled
        buf.push(b'c').unwrap();
        assert!(buf.push(b'd').is_err());
        assert_eq!(buf.into_secret().unwrap().expose_secret(), "abc");
    }

    #[test]
    fn debug_output_is_redacted() {
        let generated = password(&options(20)).unwrap();
        let debug = format!("{generated:?}");
        assert!(!debug.contains(generated.value.expose_secret()));
        assert!(debug.contains("REDACTED"));
    }

    #[test]
    fn defaults_match_ipc_doc() {
        assert_eq!(
            PasswordOptions::default(),
            PasswordOptions {
                length: 20,
                lowercase: true,
                uppercase: true,
                digits: true,
                symbols: true,
                avoid_ambiguous: false
            }
        );
        assert_eq!(PassphraseOptions::default(), phrase(6, "-"));
        let a = generate(&PasswordOptions::default());
        let b = generate(&PasswordOptions::default());
        assert_ne!(a, b);
    }
}
