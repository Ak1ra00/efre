# efre — agent guide

**efre** (ⵉⴼⵔⵉ, *ifri*: Tamazight for *cave*; plural ⵉⴼⵔⴰⵏ, *ifran*) is an offline, single-user Windows vault that opens only with an enrolled YubiKey. Keep the Tifinagh name in the UI (`src/components/brand/tifinagh.tsx`) and README: it honours the project's Amazigh heritage.
Read `docs/SPEC.md` (the brief) and `docs/ARCHITECTURE.md` (the design; §5 is normative) before changing anything.
Priorities: security > reliability > UX > features. Don't add features beyond the brief.

## Security invariants (never break these)
- **No network.** Never add HTTP/TLS/WebSocket crates, network Tauri plugins, remote URLs, CDNs, telemetry or updaters. `deny.toml` enforces the ban; never loosen it.
- **No custom crypto.** Use only the primitives in ARCHITECTURE §5.1. Any change to the format, KDF labels, AAD layout or verification order requires a design-doc update and the user's review first.
- **Fail closed.** Any AEAD, MAC, parse, version or integrity failure means refusing to open. Never try "best effort" decryption or skip a check.
- **Secrets stay in Rust.** Keys, PRF outputs and KEKs never cross IPC. Secret item fields go to JS only through explicit reveal. Copying happens in Rust.
- **Never persist PRF outputs, KEKs, the VMK, or plaintext.** The only plaintext on disk is the MACed header.
- Secret types use `secrecy`/`Zeroizing` and have no `Display`/`Serialize`. `Debug` is redacted. Errors and logs never contain key or plaintext bytes.
- `MockAuthenticator` exists only behind the `mock` feature, which tests and dev enable. It must never reach a release build.
- Windows-only code goes behind `#[cfg(windows)]`. `efre-core` stays platform-independent.
- Never require admin. Load `webauthn.dll` only from System32.

## Commands
```sh
npm ci                                   # frontend deps (lockfile)
npm run dev                              # tauri dev (Windows); vite only: npm run dev:web
npm run build                            # frontend production build (dist/)
npm run typecheck && npm run lint && npm test
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check && cargo audit
npm run tauri build                      # unsigned NSIS installer (Windows)
```
`src-tauri` needs `dist/` to exist, so run `npm run build` once before `cargo clippy` or `cargo test`.

## Conventions
- Rust stable, edition 2024, workspace lints in the root `Cargo.toml`. Avoid `unsafe` outside the FFI modules, and give every `unsafe` block a `// SAFETY:` comment.
- Integers in the on-disk format are big-endian, and every byte layout is documented in ARCHITECTURE §5.
- IPC commands stay thin: validate input, call `efre-core`, map errors to stable codes.
- TypeScript is strict, with no `any`. Never store anything in `localStorage`, `sessionStorage` or IndexedDB.
- End each phase with green tests, clean lint, a commit, a summary, and a Windows manual-test checklist.

## Git authorship (owner's rule)
- The repo owner is the sole author and committer of every commit. Never list an AI assistant or its vendor as an author, committer or co-author.
- No AI co-author or session trailers, and no "generated with" lines in commits, PR descriptions or comments.
- The identity is set in this repo's git config: `Ak1ra00 <162945952+Ak1ra00@users.noreply.github.com>`.
