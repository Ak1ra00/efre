//! Tauri build script.
//!
//! The app manifest puts efre's own commands under the ACL: each one gets an
//! `allow-<command>` permission (underscores become dashes), and only what
//! `capabilities/main.json` grants can be invoked. A test checks this list against
//! docs/IPC.md, the handler in `src/main.rs` and the capability file.

const COMMANDS: &[&str] = &[
    "app_status",
    "setup_start",
    "setup_enroll_key",
    "setup_finish",
    "setup_cancel",
    "unlock",
    "lock",
    "cancel_prompt",
    "activity",
    "list_items",
    "get_item",
    "create_item",
    "update_item",
    "set_favorite",
    "trash_item",
    "restore_item",
    "delete_item",
    "empty_trash",
    "reveal_field",
    "copy_field",
    "copy_role",
    "generate_password",
    "generate_passphrase",
    "copy_generated",
    "get_settings",
    "set_settings",
    "list_keys",
    "add_key",
    "rename_key",
    "remove_key",
    "open_vault_folder",
    "security_info",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
}
