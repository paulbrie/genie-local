//! The menu bar / system tray icon: the connection's state, Talk to Spiridus, Settings, Pause, Quit.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::bridge::bridge;

pub struct TrayItems {
    status: MenuItem<Wry>,
    pause: CheckMenuItem<Wry>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Not paired", false, None::<&str>)?;
    let chat = MenuItem::with_id(app, "chat", "Talk to Spiridus…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pause control", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Spiridus Desktop", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &sep, &chat, &settings, &pause, &sep2, &quit])?;
    app.manage(TrayItems { status, pause });

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("an app icon"))
        .tooltip("Spiridus Desktop")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "chat" => crate::open_chat(app),
            "settings" => crate::open_settings(app),
            "pause" => {
                let b = bridge(app);
                let paused = !b.config().paused;
                b.update(|c| c.paused = paused);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            // Windows / Linux: a left click opens the chat (the menu is on the right button)
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                if !cfg!(target_os = "macos") {
                    crate::open_chat(tray.app_handle());
                }
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}

pub fn refresh(app: &AppHandle) {
    let Some(items) = app.try_state::<TrayItems>() else { return };
    let Some(b) = app.try_state::<std::sync::Arc<crate::bridge::Bridge>>() else { return };
    let c = b.config();
    let s = b.status();
    let host = c.server.split("://").nth(1).unwrap_or(&c.server).split('/').next().unwrap_or("").to_string();
    let line = match (c.token.is_some(), s.state.as_str()) {
        (false, _) => "Not paired: open Settings".to_string(),
        (true, "connected") if c.paused => format!("Paused · {host}"),
        (true, "connected") => format!("Connected to {host} as {}", c.name),
        (true, "connecting") => format!("Connecting to {host}…"),
        (true, _) => format!("Offline · {}", if s.error.is_empty() { host } else { s.error.clone() }),
    };
    let _ = items.status.set_text(line.clone());
    let _ = items.pause.set_checked(c.paused);
    if let Some(t) = app.tray_by_id("main") {
        let _ = t.set_tooltip(Some(format!("Spiridus Desktop · {line}")));
    }
}
