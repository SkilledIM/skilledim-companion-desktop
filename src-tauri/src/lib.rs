mod secure_store;

use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
      // Forward deep-link argv from a second instance into the running app.
      if let Some(url) = argv.iter().find(|arg| arg.starts_with("skilledim-companion://")) {
        let _ = app.emit("companion-auth-callback", url.clone());
      }
    }));
  }

  builder
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_deep_link::init())
    .invoke_handler(tauri::generate_handler![
      secure_store::secure_store_token,
      secure_store::secure_load_token,
      secure_store::secure_clear_token,
      secure_store::secure_store_pending_auth,
      secure_store::secure_load_pending_auth,
      secure_store::secure_clear_pending_auth,
      secure_store::secure_store_profile,
      secure_store::secure_load_profile,
      secure_store::secure_clear_profile,
      secure_store::secure_clear_all,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(any(windows, target_os = "linux"))]
      {
        // Ensures deep links work in `tauri:dev` and non-installed builds.
        let _ = app.deep_link().register_all();
      }

      let handle = app.handle().clone();
      app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
          let _ = handle.emit("companion-auth-callback", url.to_string());
        }
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
