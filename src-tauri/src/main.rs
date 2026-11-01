// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod commands;
#[cfg(test)]
mod contract;
#[cfg(feature = "dev-mock")]
mod dev_mock;
mod dto;
mod error;
#[cfg(test)]
mod flow_tests;
mod lock;
mod monitors;
mod navigation;
mod paths;
mod platform;
mod security;
mod state;
mod system_events;
mod ui;
mod window;

use std::sync::Arc;

use efre_authn::Authenticator;
use tauri::{AppHandle, Manager as _, RunEvent, WebviewWindow};

use crate::state::{AppState, Environment};

/// Shown when Windows' security key API is missing or older than efre needs (API 4,
/// ARCHITECTURE §4.4).
#[cfg(all(windows, not(feature = "dev-mock")))]
const UPDATE_WINDOWS: &str = "This version of Windows is too old for efre: it needs the \
    Windows security key API (webauthn.dll) version 4 or later. Install the latest Windows \
    updates, then restart efre.";

type AuthenticatorChoice = (Result<Arc<dyn Authenticator>, String>, Option<u32>);

/// The Windows WebAuthn API, with its prompts parented to efre's window.
#[cfg(all(windows, not(feature = "dev-mock")))]
fn authenticator_for(window: &WebviewWindow) -> AuthenticatorChoice {
    let hwnd = match window.hwnd() {
        Ok(hwnd) => hwnd.0 as isize,
        Err(_) => {
            return (
                Err(
                    "efre could not find its own window, so Windows can't show its security \
                     prompts. Restart efre."
                        .to_owned(),
                ),
                None,
            );
        }
    };
    match platform::authenticator(hwnd) {
        Ok((authenticator, version)) => (Ok(authenticator), Some(version)),
        Err(efre_authn::AuthnError::UnsupportedPlatform) => (Err(UPDATE_WINDOWS.to_owned()), None),
        Err(error) => (
            Err(format!(
                "efre could not start Windows' security key support ({error}). Restart \
                 efre, or update Windows."
            )),
            None,
        ),
    }
}

/// Simulated YubiKeys for UI development (debug builds only).
#[cfg(feature = "dev-mock")]
fn authenticator_for(_window: &WebviewWindow) -> AuthenticatorChoice {
    (Ok(Arc::new(dev_mock::DevMockAuthenticator::new())), None)
}

#[cfg(all(not(windows), not(feature = "dev-mock")))]
fn authenticator_for(_window: &WebviewWindow) -> AuthenticatorChoice {
    (Err("efre runs on Windows 10 and 11 only.".to_owned()), None)
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    // Before any window exists: the folder check must see `%LOCALAPPDATA%\efre` before
    // WebView2 creates its data folder inside it.
    let paths = match handle.path().local_data_dir() {
        Ok(local) => paths::prepare(&local).map_err(|e| e.to_string()),
        Err(_) => Err(paths::PathError::NoLocalAppData.to_string()),
    };
    let window = window::create_main_window(&handle)?;
    let (authenticator, api_version) = authenticator_for(&window);
    let state = Arc::new(AppState::new(
        Environment {
            authenticator,
            api_version,
            paths,
        },
        Box::new(clipboard::Clipboard::new()),
        Box::new(ui::TauriUi::new(&handle)),
        Box::new(lock::MonotonicClock::new()),
    ));
    state.spawn_lock_worker()?;
    app.manage(state);
    Ok(())
}

/// Quitting: lock and clear efre's clipboard value (and, on `Exit`, close the vault).
fn shut_down(handle: &AppHandle, close: bool) {
    if let Some(state) = handle.try_state::<Arc<AppState>>() {
        state.shutdown(close);
    }
}

fn main() {
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch just focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_webview_window(window::MAIN_LABEL) {
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::setup_start,
            commands::setup_enroll_key,
            commands::setup_finish,
            commands::setup_cancel,
            commands::unlock,
            commands::lock,
            commands::cancel_prompt,
            commands::activity,
            commands::list_items,
            commands::get_item,
            commands::create_item,
            commands::update_item,
            commands::set_favorite,
            commands::trash_item,
            commands::restore_item,
            commands::delete_item,
            commands::empty_trash,
            commands::reveal_field,
            commands::copy_field,
            commands::copy_role,
            commands::generate_password,
            commands::generate_passphrase,
            commands::copy_generated,
            commands::get_settings,
            commands::set_settings,
            commands::list_keys,
            commands::add_key,
            commands::rename_key,
            commands::remove_key,
            commands::open_vault_folder,
            commands::security_info,
        ])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("efre failed to start");

    // The watchers live exactly as long as the event loop.
    let mut watchers: Option<monitors::Monitors> = None;
    app.run(move |handle, event| match event {
        // Right after `setup`, before the event loop has served the first page.
        RunEvent::Ready => {
            if let Some(state) = handle.try_state::<Arc<AppState>>() {
                window::lock_down_browser_ui(handle, state.inner());
                watchers = Some(monitors::start(state.inner()));
            }
        }
        RunEvent::ExitRequested { .. } => shut_down(handle, false),
        RunEvent::Exit => {
            shut_down(handle, true);
            // Unregisters the OS notifications.
            watchers.take();
        }
        _ => {}
    });
}
