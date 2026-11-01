//! The IPC commands of docs/IPC.md, as thin Tauri wrappers around [`AppState`].
//!
//! Each command counts as activity for the idle timer, captures the lock epoch, then
//! runs on Tauri's blocking pool: the vault mutex can be held for minutes by a
//! Windows Security prompt, and neither the main thread nor the async workers may
//! wait for it. Commands that prompt emit `key-step` before each prompt.

use std::sync::Arc;

use tauri::State;

use crate::dto::{
    AppStatus, CopyResult, FieldRole, Generated, ItemDraft, ItemMeta, ItemView, KeyInfo,
    PassphraseOptions, PasswordOptions, SecurityInfo, Settings, WebText,
};
use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

type Shared<'a> = State<'a, Arc<AppState>>;

async fn run<T, F>(state: Shared<'_>, f: F) -> IpcResult<T>
where
    T: Send + 'static,
    F: FnOnce(&AppState, u64) -> IpcResult<T> + Send + 'static,
{
    let state = Arc::clone(state.inner());
    state.triggers.touch();
    let epoch = state.triggers.epoch();
    tauri::async_runtime::spawn_blocking(move || f(&state, epoch))
        .await
        .map_err(|_| IpcError::internal("This action failed unexpectedly."))?
}

#[tauri::command]
pub(crate) async fn app_status(state: Shared<'_>) -> IpcResult<AppStatus> {
    run(state, |s, _| Ok(s.app_status())).await
}

#[tauri::command]
pub(crate) async fn setup_start(state: Shared<'_>) -> IpcResult<AppStatus> {
    run(state, |s, epoch| s.setup_start(epoch)).await
}

#[tauri::command]
pub(crate) async fn setup_enroll_key(state: Shared<'_>, nickname: String) -> IpcResult<KeyInfo> {
    run(state, move |s, epoch| s.setup_enroll_key(epoch, &nickname)).await
}

#[tauri::command]
pub(crate) async fn setup_finish(state: Shared<'_>) -> IpcResult<AppStatus> {
    run(state, |s, epoch| s.setup_finish(epoch)).await
}

#[tauri::command]
pub(crate) async fn setup_cancel(state: Shared<'_>) -> IpcResult<AppStatus> {
    run(state, |s, epoch| s.setup_cancel(epoch)).await
}

#[tauri::command]
pub(crate) async fn unlock(state: Shared<'_>) -> IpcResult<AppStatus> {
    run(state, |s, epoch| s.unlock(epoch)).await
}

#[tauri::command]
pub(crate) async fn lock(state: Shared<'_>) -> IpcResult<()> {
    run(state, |s, _| {
        s.lock();
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn cancel_prompt(state: Shared<'_>) -> IpcResult<()> {
    run(state, |s, _| {
        s.cancel_prompt();
        Ok(())
    })
    .await
}

/// Resets the idle timer. Only an atomic store, so it runs right here.
#[tauri::command]
pub(crate) fn activity(state: Shared<'_>) -> IpcResult<()> {
    state.triggers.touch();
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_items(state: Shared<'_>) -> IpcResult<Vec<ItemMeta>> {
    run(state, |s, epoch| s.list_items(epoch)).await
}

#[tauri::command]
pub(crate) async fn get_item(state: Shared<'_>, id: String) -> IpcResult<ItemView> {
    run(state, move |s, epoch| s.get_item(epoch, &id)).await
}

#[tauri::command]
pub(crate) async fn create_item(state: Shared<'_>, draft: ItemDraft) -> IpcResult<ItemMeta> {
    run(state, move |s, epoch| s.create_item(epoch, draft)).await
}

#[tauri::command]
pub(crate) async fn update_item(
    state: Shared<'_>,
    id: String,
    draft: ItemDraft,
) -> IpcResult<ItemMeta> {
    run(state, move |s, epoch| s.update_item(epoch, &id, draft)).await
}

#[tauri::command]
pub(crate) async fn set_favorite(
    state: Shared<'_>,
    id: String,
    favorite: bool,
) -> IpcResult<ItemMeta> {
    run(state, move |s, epoch| s.set_favorite(epoch, &id, favorite)).await
}

#[tauri::command]
pub(crate) async fn trash_item(state: Shared<'_>, id: String) -> IpcResult<ItemMeta> {
    run(state, move |s, epoch| s.trash_item(epoch, &id)).await
}

#[tauri::command]
pub(crate) async fn restore_item(state: Shared<'_>, id: String) -> IpcResult<ItemMeta> {
    run(state, move |s, epoch| s.restore_item(epoch, &id)).await
}

#[tauri::command]
pub(crate) async fn delete_item(state: Shared<'_>, id: String) -> IpcResult<()> {
    run(state, move |s, epoch| s.delete_item(epoch, &id)).await
}

#[tauri::command]
pub(crate) async fn empty_trash(state: Shared<'_>) -> IpcResult<usize> {
    run(state, |s, epoch| s.empty_trash(epoch)).await
}

#[tauri::command]
pub(crate) async fn reveal_field(
    state: Shared<'_>,
    id: String,
    field_id: u32,
) -> IpcResult<WebText> {
    run(state, move |s, epoch| s.reveal_field(epoch, &id, field_id)).await
}

#[tauri::command]
pub(crate) async fn copy_field(
    state: Shared<'_>,
    id: String,
    field_id: u32,
) -> IpcResult<CopyResult> {
    run(state, move |s, epoch| s.copy_field(epoch, &id, field_id)).await
}

#[tauri::command]
pub(crate) async fn copy_role(
    state: Shared<'_>,
    id: String,
    role: FieldRole,
) -> IpcResult<CopyResult> {
    run(state, move |s, epoch| s.copy_role(epoch, &id, role)).await
}

#[tauri::command]
pub(crate) async fn generate_password(
    state: Shared<'_>,
    options: PasswordOptions,
) -> IpcResult<Generated> {
    run(state, move |s, epoch| s.generate_password(epoch, options)).await
}

#[tauri::command]
pub(crate) async fn generate_passphrase(
    state: Shared<'_>,
    options: PassphraseOptions,
) -> IpcResult<Generated> {
    run(state, move |s, epoch| s.generate_passphrase(epoch, options)).await
}

#[tauri::command]
pub(crate) async fn copy_generated(state: Shared<'_>) -> IpcResult<CopyResult> {
    run(state, |s, epoch| s.copy_generated(epoch)).await
}

#[tauri::command]
pub(crate) async fn get_settings(state: Shared<'_>) -> IpcResult<Settings> {
    run(state, |s, epoch| s.get_settings(epoch)).await
}

#[tauri::command]
pub(crate) async fn set_settings(state: Shared<'_>, settings: Settings) -> IpcResult<Settings> {
    run(state, move |s, epoch| s.set_settings(epoch, settings)).await
}

#[tauri::command]
pub(crate) async fn list_keys(state: Shared<'_>) -> IpcResult<Vec<KeyInfo>> {
    run(state, |s, epoch| s.list_keys(epoch)).await
}

#[tauri::command]
pub(crate) async fn add_key(state: Shared<'_>, nickname: String) -> IpcResult<KeyInfo> {
    run(state, move |s, epoch| s.add_key(epoch, &nickname)).await
}

#[tauri::command]
pub(crate) async fn rename_key(
    state: Shared<'_>,
    id: String,
    nickname: String,
) -> IpcResult<KeyInfo> {
    run(state, move |s, epoch| s.rename_key(epoch, &id, &nickname)).await
}

#[tauri::command]
pub(crate) async fn remove_key(state: Shared<'_>, id: String) -> IpcResult<Vec<KeyInfo>> {
    run(state, move |s, epoch| s.remove_key(epoch, &id)).await
}

#[tauri::command]
pub(crate) async fn open_vault_folder(state: Shared<'_>) -> IpcResult<()> {
    run(state, |s, _| s.open_vault_folder()).await
}

#[tauri::command]
pub(crate) async fn security_info(state: Shared<'_>) -> IpcResult<SecurityInfo> {
    run(state, |s, _| Ok(s.security_info())).await
}
