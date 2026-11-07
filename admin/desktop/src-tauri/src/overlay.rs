//! A transparent, click-through window over each display (ui/overlay.html): while connected, a small
//! "Spiridus can control this computer" badge; when it acts, its cursor gliding to where, a line saying
//! who and what, and a glow round the screen.

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::actions::all_displays;

pub fn create(app: &AppHandle) {
    let Ok(displays) = all_displays() else { return };
    for (d, _) in displays {
        let label = format!("overlay-{}", d.id);
        if app.get_webview_window(&label).is_some() {
            continue;
        }
        let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(format!("overlay.html?display={}", d.id).into()))
            .title("Spiridus overlay")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .focused(false)
            .visible_on_all_workspaces(true);
        b = if cfg!(target_os = "windows") {
            b.position(0.0, 0.0).inner_size(100.0, 100.0)
        } else {
            b.position(d.x, d.y).inner_size(d.width, d.height)
        };
        let Ok(w) = b.build() else { continue };
        if cfg!(target_os = "windows") {
            // Windows: displays can each have their own scale, so place it in device pixels
            let _ = w.set_position(tauri::PhysicalPosition::new(d.ix as i32, d.iy as i32));
            let _ = w.set_size(tauri::PhysicalSize::new((d.width * d.scale) as u32, (d.height * d.scale) as u32));
        }
        let _ = w.set_ignore_cursor_events(true);
    }
}

/// Show an action: on `spot`'s display (its id, and the point on it), or as a line only.
pub fn show(app: &AppHandle, spot: Option<(u32, f64, f64)>, by: &str, what: &str) {
    let payload = json!({ "display": spot.map(|s| s.0), "x": spot.map(|s| s.1), "y": spot.map(|s| s.2), "by": by, "what": what });
    let _ = app.emit("action", payload);
}
