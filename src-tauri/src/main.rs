// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod navigation;
mod window;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Must be the first plugin: a second launch just focuses the existing window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(main) = app.get_webview_window(window::MAIN_LABEL) {
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }))
        .setup(|app| {
            window::create_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("efre failed to start");
}
