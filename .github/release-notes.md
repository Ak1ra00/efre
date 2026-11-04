**efre {{VERSION}}** · ⵉⴼⵔⵉ (*ifri*), Tamazight for *cave*. An offline password vault
for Windows that opens only with your YubiKey.

## Install

1. Download **`{{SETUP}}`** below ({{SIZE_MB}} MB).
2. Run it. Windows SmartScreen warns about it, because the installer isn't code-signed
   yet. Choose **More info → Run anyway**.
3. The installer sets up everything efre needs, for your user only. There is no
   administrator prompt, and nothing is downloaded:
   - **efre**, in `%LOCALAPPDATA%\Programs\efre`;
   - **Microsoft Edge WebView2 Runtime**, which draws efre's window. It is installed
     only if your PC doesn't have it yet; Windows 11 already does.
4. Start **efre** from the Start menu, and follow the setup wizard to enroll your
   YubiKeys.

**You also need:**
- Two YubiKeys with FIDO2 (YubiKey 5, Security Key or Bio series), each with a FIDO2
  PIN.
- Windows 11 with current updates (efre needs Windows' WebAuthn API version 4 or
  later).

The [README](https://github.com/Ak1ra00/efre#readme) has the full illustrated how-to.

## Check the download

In PowerShell, in the folder you downloaded it to:

```powershell
(Get-FileHash .\{{SETUP}} -Algorithm SHA256).Hash
```

The result must match `{{SHA256}}`, which is also in `SHA256SUMS.txt`.

## Good to know

- efre makes no network connections. Your vault is a single encrypted file in
  `%LOCALAPPDATA%\efre`. Uninstalling efre never touches it.
- There is no master password and no recovery code: enroll a backup key.
- [SECURITY.md](https://github.com/Ak1ra00/efre/blob/main/SECURITY.md) explains what
  efre protects against and its honest limits.

This installer was built and tested by GitHub Actions from tag `{{TAG}}`. Before
publishing, the workflow checked that:
- the embedded WebView2 installer is signed by Microsoft;
- the app starts on Windows and shows its first screen with zero network sockets;
- the installer installs to `%LOCALAPPDATA%\Programs\efre` and uninstalls without
  touching the vault.
