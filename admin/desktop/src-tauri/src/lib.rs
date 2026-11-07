//! Spiridus Desktop: lets a Spiridus admin (and its agents) see and drive this computer, as the Spiridus Bridge
//! Chrome extension does a browser tab. It pairs with a one-time code from Spiridus's Browsers page, then keeps
//! a connection open (bridge.rs), starts at login, and runs what Spiridus asks (actions.rs), showing every
//! action on screen (overlay.rs). The tray (tray.rs) shows the state and pauses it; the chat window talks to
//! Spiridus's terminals.

mod actions;
mod bridge;
mod config;
mod overlay;
mod tray;

use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder};

use bridge::Bridge;

pub fn enable_autostart(app: &AppHandle) {
    use tauri_plugin_autostart::ManagerExt;
    let _ = app.autolaunch().enable();
}

fn show_window(app: &AppHandle, label: &str, page: &str, title: &str, w: f64, h: f64, on_top: bool) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(w, h)
        .resizable(true)
        .always_on_top(on_top)
        .center()
        .build();
}

pub fn open_settings(app: &AppHandle) {
    show_window(app, "settings", "settings.html", "Spiridus Desktop", 440.0, 640.0, false);
}

pub fn open_chat(app: &AppHandle) {
    show_window(app, "chat", "chat.html", "Talk to Spiridus", 420.0, 600.0, true);
}

// ---------------------------------------------------------------- what the app's pages call

#[tauri::command]
fn get_state(b: State<'_, Arc<Bridge>>) -> Value {
    b.ui_state()
}

#[tauri::command]
async fn pair(b: State<'_, Arc<Bridge>>, server: String, code: String, name: String) -> Result<String, String> {
    b.inner().clone().pair(&server, &code, &name).await
}

#[tauri::command]
fn show_chat(app: AppHandle) {
    open_chat(&app);
}

#[tauri::command]
fn unpair(b: State<'_, Arc<Bridge>>) {
    b.unpair();
}

#[tauri::command]
fn reconnect(b: State<'_, Arc<Bridge>>) {
    b.reconnect();
}

#[tauri::command]
fn set_paused(b: State<'_, Arc<Bridge>>, paused: bool) {
    b.update(|c| c.paused = paused);
}

#[tauri::command]
fn set_allow(b: State<'_, Arc<Bridge>>, input: bool, shell: bool, files: bool) {
    b.update(|c| {
        c.allow.input = input;
        c.allow.shell = shell;
        c.allow.files = files;
    });
}

/// The chat window's calls to Spiridus (/api/browsers/ext/…), made here with the pairing token. Only these.
#[tauri::command]
async fn ext_api(b: State<'_, Arc<Bridge>>, method: String, path: String, query: Option<Value>, body: Option<Value>) -> Result<Value, String> {
    let allowed = matches!((method.as_str(), path.as_str()), ("GET", "terminals") | ("GET", "screen") | ("POST", "talk") | ("POST", "key"));
    if !allowed {
        return Err(format!("not allowed: {method} {path}"));
    }
    let c = b.config();
    let token = c.token.ok_or("this computer isn't paired with Spiridus")?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/browsers/ext/{path}", c.server);
    let mut req = if method == "GET" { client.get(url) } else { client.post(url) };
    if let Some(Value::Object(q)) = query {
        let pairs: Vec<(String, String)> = q.into_iter().map(|(k, v)| (k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string()))).collect();
        req = req.query(&pairs);
    }
    if let Some(body) = body {
        req = req.json(&body);
    }
    let res = req.bearer_auth(token).timeout(std::time::Duration::from_secs(30)).send().await.map_err(|e| format!("can't reach Spiridus: {e}"))?;
    let status = res.status();
    let data: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(data["error"].as_str().map(String::from).unwrap_or_else(|| format!("HTTP {status}")));
    }
    Ok(data)
}

pub fn run() {
    tauri::Builder::default()
        // launched again (its icon double-clicked): the running one opens Settings, or the chat with --chat
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|a| a == "--chat") {
                open_chat(app);
            } else {
                open_settings(app);
            }
        }))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .invoke_handler(tauri::generate_handler![get_state, show_chat, pair, unpair, reconnect, set_paused, set_allow, ext_api])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // a menu bar app: no Dock icon

            let dir = app.path().app_config_dir()?;
            let b = Bridge::new(app.handle().clone(), dir.join("config.json"));
            app.manage(b.clone());
            // no tray on some Linux desktops: it still runs (Settings opens from a second launch)
            if let Err(e) = tray::create(app.handle()) {
                eprintln!("spiridus-desktop: no tray icon: {e}");
            }
            overlay::create(app.handle());
            tauri::async_runtime::spawn(b.clone().run());
            // first run, or unpaired: show how to pair (at login it starts quietly)
            if std::env::args().any(|a| a == "--chat") {
                open_chat(app.handle());
            } else if b.config().token.is_none() && !std::env::args().any(|a| a == "--background") {
                open_settings(app.handle());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("couldn't start Spiridus Desktop")
        .run(|_app, event| {
            // closing its windows doesn't quit it: it lives in the tray
            if let RunEvent::ExitRequested { api, code: None, .. } = event {
                api.prevent_exit();
            }
        });
}
