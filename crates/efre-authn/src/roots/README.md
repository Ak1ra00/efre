# Pinned Yubico FIDO attestation CAs

`attestation::verify_packed` accepts an attestation certificate only if it chains to
one of these DER certificates. `attestation::tests::pinned_fingerprints` asserts the
SHA-256 fingerprints below. Never edit or add a file without repeating the checks.

| File | Subject | Serial | SHA-256 (DER) | Validity |
|---|---|---|---|---|
| `yubico-u2f-root-ca-serial-457200631.der` | CN=Yubico U2F Root CA Serial 457200631 (root, RSA-2048) | 1B4053F7 | `0fa1386f80eb8713263ae5c1d84deb455bdf08aea50ab05503cefee82b092d42` | 2014-08-01 → 2050-09-04 |
| `yubico-fido-root-ca-serial-450203556.der` | CN=Yubico FIDO Root CA Serial 450203556 (root, RSA-2048) | 48E1234DFFFFCAA45F3D6ED0ABCAAD2320AB020F | `35f1a54b353bfb711e6d42adbeb76c0e9dead095018e6a94783ba2192fd6faad` | 2024-05-01 → 2060-04-30 |
| `yubico-fido-attestation-a-1.der` | CN=Yubico FIDO Attestation A 1 (issuing CA, pathlen 0) | — | `4ebabc9cbc964f722c985f3784d057e9ef5dcf454dcb4f767fccca58cf16a4e8` | 2024-12-01 → 9999-12-31 |
| `yubico-fido-attestation-b-1.der` | CN=Yubico FIDO Attestation B 1 (issuing CA, pathlen 0) | — | `4eadda86ff62cff987e111a07910d8554de42f71d5d6da7744610e09012dd319` | 2024-12-01 → 9999-12-31 |
| `yubico-fido-attestation-b2-1.der` | CN=Yubico FIDO Attestation B2 1 (issuing CA, pathlen 0) | — | `3c6fe819adbd80afe75dc90af7bba34c95b2b7ac64384816e033f63b7c93848b` | 2025-08-01 → 9999-12-31 |

## Why these and not "Yubico Attestation Root 1"

Since firmware 5.7.4, Yubico issues attestation certificates under **Yubico
Attestation Root 1** (2024-12-01). That root also signs Yubico's PIV, OpenPGP, Secure
Domain and YubiHSM attestation branches:
`Root 1 → Yubico Attestation Intermediate A 1 / B 1 → Yubico {FIDO | PIV | OPGP | SD} Attestation …`.
efre pins only the three **FIDO** issuing CAs of that tree, so a certificate from
another branch can never pass as FIDO attestation. Each was checked with
`openssl verify -CAfile <Root 1> -untrusted <Intermediate A 1 + B 1>` (OK). Root 1
itself (SHA-256 `62760c6a6ef91679f454c8902b80fd009825b3f25da90f1fbace2ec6586cd5a8`)
is not pinned. If Yubico adds another FIDO issuing CA, enrollment of keys under it
fails closed until it is added here.

## Sources

1. **Yubico's published CA bundle**, `yubico-ca-certs.txt` (last update 2025-02-03) and
   `yubico-intermediate.pem`, from the source repository of developers.yubico.com:
   `https://raw.githubusercontent.com/Yubico/developers.yubico.com/master/static/PKI/`.
   `yubico-ca-certs.txt` is served at https://developers.yubico.com/PKI/yubico-ca-certs.txt.
2. **OpenPGP signature** `yubico-ca-certs.txt.sig` in that repository: a good signature
   by subkey `EAA09128E15582099347E5D3C81FDCBBE03F92DF` of primary key
   `57A9DEED4C6D962A923BB691816F3ED99921835E` (Emil Lundberg, Yubico, created 2017).
   The key came from keyserver.ubuntu.com. The **same primary key** signs Yubico's
   Maven Central releases (`com.yubico:webauthn-server-attestation:1.12.4.jar.asc`,
   2022). This ties the bundle, including both 2024 roots, to Yubico's release
   signer through infrastructure independent of GitHub (Sonatype's control of the
   `com.yubico` namespace).
3. **U2F root only, three more copies:**
   - `webauthn-rs-device-catalog` 0.5.0-20230418 (crates.io, MPL-2.0), byte-identical;
   - `@motebit/crypto-webauthn` 1.0.41 (npm, Apache-2.0), same serial and fingerprint;
   - `com.yubico:webauthn-server-attestation:1.12.4` `metadata.json` (Maven Central,
     BSD-2-Clause). This copy has a one-bit difference in the serial (1B5053F7), so its
     self-signature does not verify, but its subject and public key are identical,
     and those are what a trust anchor uses.

   A real YubiKey 5Ci attestation certificate (the test fixture) verifies against the
   pinned key with both `openssl verify` and `rustls-webpki`.
