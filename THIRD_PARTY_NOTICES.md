# Third-party notices

efre's own code is under the MIT License (see [LICENSE](LICENSE)). The app also ships
or embeds the material below, each under its own license.

## Embedded data and assets

### EFF Large Wordlist for Passphrases
- **Used by:** the passphrase generator. It is embedded unmodified in `efre-core`, and
  a test checks its SHA-256.
- **Copyright:** Electronic Frontier Foundation.
- **License:** [Creative Commons Attribution 3.0 United States](https://creativecommons.org/licenses/by/3.0/us/).
- **Source:** <https://www.eff.org/dice>.

### Inter typeface
- **Used by:** the user interface, bundled through `@fontsource-variable/inter`.
- **Copyright:** 2016 The Inter Project Authors (<https://github.com/rsms/inter>).
- **License:** [SIL Open Font License 1.1](https://openfontlicense.org).

### Noto Sans Tifinagh typeface
- **Used by:** the name ⵉⴼⵔⵉ in the user interface, bundled through
  `@fontsource/noto-sans-tifinagh` (the Tifinagh subset only).
- **Copyright:** 2022 The Noto Project Authors (<https://github.com/notofonts/tifinagh>).
- **License:** [SIL Open Font License 1.1](https://openfontlicense.org).
- **Also used for:** the ⵉⴼⵔⵉ lettering in `docs/images/banner.svg`, converted to
  outlines.

### Lucide icons
- **Used by:** the user interface, through `lucide-react`.
- **Copyright:** Lucide Contributors.
- **License:** ISC.

### Microsoft Edge WebView2 Runtime (release installers only)
- **Used by:** the installers on the GitHub Releases page. They carry Microsoft's
  offline WebView2 Runtime installer, unmodified, and run it only when the PC doesn't
  have WebView2 yet. The release workflow checks that it is validly signed by
  Microsoft.
- **Copyright:** Microsoft Corporation. WebView2 is redistributed as Microsoft allows
  for apps that use it, under the Microsoft Edge WebView2 Runtime license terms
  (<https://developer.microsoft.com/microsoft-edge/webview2/>).
- **Not included:** the installers built by CI and the app itself.

### SQLite
The vault file is a SQLite database. SQLite is compiled in through `rusqlite`'s
`bundled` feature, and it is in the public domain.

### Yubico attestation root certificates
- **Used by:** enrollment, which checks that a key really is a YubiKey. The public CA
  certificates in `crates/efre-authn/src/roots/` are embedded for that check only.
- **Source:** Yubico, at <https://developers.yubico.com/PKI/>.

"YubiKey" and "Yubico" are trademarks of Yubico AB. efre is an independent project and
is not affiliated with or endorsed by Yubico. The app uses no Yubico logos or artwork;
its key illustration is original.

## Libraries
The Rust crates and npm packages that efre depends on keep their own licenses.

CI rejects any Rust crate whose license is not on the permissive allow-list in
[`deny.toml`](deny.toml). The allowed licenses are MIT, Apache-2.0, BSD-3-Clause, ISC,
Zlib, MPL-2.0, Unicode-3.0, BlueOak-1.0.0 and similar.

To list every dependency with its license:
```sh
cargo deny list                       # Rust crates
npm query ".prod"                     # npm packages that ship in the app (see "license")
```
