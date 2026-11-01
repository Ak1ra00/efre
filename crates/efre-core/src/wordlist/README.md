# EFF long word list

`eff_large_wordlist.txt` is the EFF long word list for passphrases, unmodified. It has
7776 words, one for each roll of five dice. `efre_core::generator` embeds it with
`include_str!` and draws passphrase words from it.

## Attribution and licence

- **Work:** "EFF's Long Wordlist" (`eff_large_wordlist.txt`), from *EFF Dice-Generated
  Passphrases*, <https://www.eff.org/dice>. The list was created by Joseph Bonneau and
  published by the Electronic Frontier Foundation in 2016.
- **Copyright:** © 2016 Electronic Frontier Foundation.
- **Licence:** Creative Commons Attribution 3.0 United States (CC BY 3.0 US),
  <https://creativecommons.org/licenses/by/3.0/us/>.
- **Original URL:** <https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt>
- **Changes:** none. The file is byte-identical to the copies listed below.

## Provenance

| | |
|---|---|
| Size | 108 800 bytes, 7776 lines, LF line endings, ASCII |
| SHA-256 | `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e` |
| Retrieved | 2026-10-31 |

eff.org was not reachable from the build environment (its network policy denied it), so
the file was taken from independent copies in well-known projects and compared byte for
byte:

| Source | Result |
|---|---|
| `ulif/diceware` (the `diceware` Python package), `diceware/wordlists/wordlist_en_eff.txt` | identical, SHA-256 above |
| `protonpass/proton-pass-common` (Proton Pass), `proton-pass-common/eff_large_wordlist.txt` | identical, SHA-256 above |
| `Dashlane/android-apps`, `…/passphrase/src/main/res/raw/eff_large_wordlist.txt` | same 7776 lines, but no final line feed |
| `passbolt/mobile-passbolt-android`, `core/passwordgenerator/src/main/res/raw/eff_large_wordlist.txt` | same 7776 lines, but no final line feed |

Copies that were checked and rejected as edited:
- `guardian/coverdrop` removes the hyphens from `drop-down`, `felt-tip`, `t-shirt` and
  `yo-yo`.
- `micahflee/passphraseme` drops the dice numbers.

The downloads were treated as untrusted data. They were inspected and parsed, never
executed. `diceware`'s `COPYRIGHT` file lists the same source URL and licence for its copy.

## Checks

The unit tests in `generator.rs` check:
- the SHA-256 above;
- that the file parses into exactly 7776 unique words, with dice keys `11111` to `66666`
  in order;
- that every word is lowercase ASCII letters and hyphens, starts with a letter, and is
  3 to 9 characters long;
- that the list is prefix-free (no word is the start of another).

The application also re-validates the list once at run time, and refuses to generate
passphrases if it fails.

To compare against EFF's own file, download it from the original URL and run
`certutil -hashfile eff_large_wordlist.txt SHA256` on Windows, or `sha256sum` elsewhere.

`.gitattributes` in this folder turns off line-ending conversion for the file. Without it,
a Windows checkout with `core.autocrlf=true` would rewrite it to CRLF and break the
checks.
