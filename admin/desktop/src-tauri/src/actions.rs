//! What Spiridus can ask this computer to do (`{t:"cmd", type, args}` from bridge.rs):
//!
//!   info | displays                              the OS, host, user, and the displays (logical points)
//!   screenshot {display?, maxWidth?, quality?}   a JPEG of one display; width/height are the display's points,
//!                                                and x, y for input are points from its top-left corner
//!   click {x, y, display? | ref} [button: left|right|middle, count]
//!   move {x, y, display?} | drag {x, y, toX, toY, display?} | scroll {dy?, dx?, x?, y?, display?} (notches)
//!   type {text} | key {key: "enter", "cmd+c", "ctrl+shift+esc", "f5", "a"…; several separated by spaces}
//!   ui_tree {}                                   the focused window's elements (macOS Accessibility, Windows
//!                                                UI Automation), each with a ref for click {ref}
//!   apps | open {target: app name, path or URL} | focus {app}
//!   clipboard_get | clipboard_set {text}
//!   run {command, cwd?, timeoutMs?}              a shell command (zsh/sh -lc; PowerShell on Windows)
//!   ls {path} | read {path, max?} | write {path, text | base64, append?}
//!
//! Input, the clipboard and opening apps need `allow.input`; run needs `allow.shell`; ls/read/write need
//! `allow.files` (the owner switches them in the app's settings). While paused, only info and displays answer.
//! Every input shows in the overlay first (overlay.rs): the cursor going there, who, and what.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use serde_json::{json, Value};

use crate::bridge::{Bridge, VERSION};
use crate::overlay;

type R = Result<Value, String>;

// ---------------------------------------------------------------- the machine

pub fn os_name() -> String {
    let os = match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        o => o,
    };
    format!("{os} {}", std::env::consts::ARCH)
}

pub fn hostname() -> String {
    whoami::devicename().or_else(|_| whoami::hostname()).unwrap_or_else(|_| "computer".into())
}

pub fn username() -> String {
    whoami::username().unwrap_or_default()
}

pub fn info() -> Value {
    json!({ "userAgent": format!("Spiridus Desktop {VERSION} ({})", os_name()), "platform": std::env::consts::OS,
            "version": VERSION, "os": os_name(), "hostname": hostname(), "user": username() })
}

/// A display, in logical points (as screenshots and input coordinates use them) and where it starts in
/// the coordinates the input layer uses (`ix`, `iy`, `iscale`): points on macOS, pixels elsewhere.
#[derive(Clone)]
pub struct Display {
    pub id: u32,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub primary: bool,
    pub ix: f64,
    pub iy: f64,
    pub iscale: f64,
}

pub fn all_displays() -> Result<Vec<(Display, xcap::Monitor)>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("can't list the displays: {e}"))?;
    let mut out = vec![];
    for m in monitors {
        let scale = m.scale_factor().unwrap_or(1.0) as f64;
        let (rx, ry) = (m.x().unwrap_or(0) as f64, m.y().unwrap_or(0) as f64);
        let (rw, rh) = (m.width().unwrap_or(0) as f64, m.height().unwrap_or(0) as f64);
        // xcap: points on macOS and Linux, device pixels on Windows
        let (x, y, width, height) = if cfg!(target_os = "windows") { (rx / scale, ry / scale, rw / scale, rh / scale) } else { (rx, ry, rw, rh) };
        // the input layer (enigo): points on macOS, device pixels on Windows and X11
        let (ix, iy, iscale) = if cfg!(target_os = "macos") {
            (x, y, 1.0)
        } else if cfg!(target_os = "windows") {
            (rx, ry, scale)
        } else {
            (x * scale, y * scale, scale)
        };
        out.push((
            Display {
                id: m.id().unwrap_or(0),
                name: m.friendly_name().or_else(|_| m.name()).unwrap_or_default(),
                x, y, width, height, scale,
                primary: m.is_primary().unwrap_or(false),
                ix, iy, iscale,
            },
            m,
        ));
    }
    if out.is_empty() {
        return Err("no display found (is anyone logged in?)".into());
    }
    Ok(out)
}

pub fn displays() -> Result<Vec<Value>, String> {
    Ok(all_displays()?
        .into_iter()
        .map(|(d, _)| json!({ "id": d.id, "name": d.name, "x": d.x, "y": d.y, "width": d.width, "height": d.height, "scale": d.scale, "primary": d.primary }))
        .collect())
}

fn pick(id: Option<u64>) -> Result<(Display, xcap::Monitor), String> {
    let all = all_displays()?;
    match id {
        Some(id) => all.into_iter().find(|(d, _)| d.id as u64 == id).ok_or_else(|| format!("no display {id}")),
        None => {
            let primary = all.iter().position(|(d, _)| d.primary).unwrap_or(0);
            Ok(all.into_iter().nth(primary).unwrap())
        }
    }
}

/// A point of a display (points from its top-left) → the input layer's coordinates.
fn to_input(d: &Display, x: f64, y: f64) -> (i32, i32) {
    ((d.ix + x * d.iscale).round() as i32, (d.iy + y * d.iscale).round() as i32)
}

/// The input layer's coordinates → the display they're on, and the point on it (for the overlay).
fn from_input(ix: f64, iy: f64) -> Option<(Display, f64, f64)> {
    let all = all_displays().ok()?;
    all.into_iter().map(|(d, _)| d).find_map(|d| {
        let (x, y) = ((ix - d.ix) / d.iscale, (iy - d.iy) / d.iscale);
        (x >= 0.0 && y >= 0.0 && x < d.width && y < d.height).then_some((d, x, y))
    })
}

// ---------------------------------------------------------------- macOS permissions

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
}

/// What the OS lets this app do: see the screen (macOS Screen Recording), drive input and read the UI
/// (macOS Accessibility). Elsewhere both are simply true.
pub fn permissions() -> Value {
    #[cfg(target_os = "macos")]
    {
        let (screen, access) = unsafe { (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() != 0) };
        json!({ "screen": screen, "accessibility": access })
    }
    #[cfg(not(target_os = "macos"))]
    json!({ "screen": true, "accessibility": true })
}

/// Without Screen Recording, macOS still hands back a picture: the wallpaper, the menu bar and our own windows,
/// with every other app's windows left out. Say so instead (and ask macOS to show its prompt, once).
fn screen_allowed() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        unsafe { CGRequestScreenCaptureAccess() };
        return Err("Spiridus Desktop may not see this screen yet: System Settings → Privacy & Security → Screen Recording → allow Spiridus Desktop, then quit and reopen it (without it macOS shows only the wallpaper)".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- args

fn num(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(|v| v.as_f64())
}
fn text<'a>(a: &'a Value, k: &str) -> Option<&'a str> {
    a.get(k).and_then(|v| v.as_str())
}
fn by(a: &Value) -> String {
    text(a, "by").map(|s| s.chars().take(40).collect()).filter(|s: &String| !s.trim().is_empty()).unwrap_or_else(|| "Spiridus".into())
}

/// Where an input command means, in input coordinates: a ref from ui_tree, or x, y on a display.
fn target(b: &Bridge, a: &Value) -> Result<(i32, i32), String> {
    if let Some(r) = text(a, "ref") {
        let p = b.refs.lock().unwrap().get(r).copied().ok_or_else(|| format!("no element {r}: read the UI again (ui_tree)"))?;
        return Ok((p.0.round() as i32, p.1.round() as i32));
    }
    let (x, y) = (num(a, "x").ok_or("say where: x and y (points on the display), or a ref")?, num(a, "y").ok_or("y is missing")?);
    let (d, _) = pick(a.get("display").and_then(|v| v.as_u64()))?;
    if x < 0.0 || y < 0.0 || x > d.width || y > d.height {
        return Err(format!("{x}, {y} is outside display {} ({}×{} points)", d.id, d.width, d.height));
    }
    Ok(to_input(&d, x, y))
}

/// Show it in the overlay (cursor to where, who, what) and give the eye a moment before acting.
async fn announce(b: &Bridge, a: &Value, at: Option<(i32, i32)>, what: &str) {
    let spot = at.and_then(|(ix, iy)| from_input(ix as f64, iy as f64));
    overlay::show(&b.app, spot.as_ref().map(|(d, x, y)| (d.id, *x, *y)), &by(a), what);
    if spot.is_some() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn with_enigo<T>(f: impl FnOnce(&mut Enigo) -> Result<T, String>) -> Result<T, String> {
    let mut e = Enigo::new(&Settings::default()).map_err(|e| format!("can't control the input: {e} (on macOS: System Settings → Privacy & Security → Accessibility → allow Spiridus Desktop)"))?;
    f(&mut e)
}
fn ie<E: std::fmt::Display>(e: E) -> String {
    format!("input failed: {e}")
}

// ---------------------------------------------------------------- keys

fn key_of(name: &str) -> Result<Key, String> {
    let n = name.to_lowercase();
    Ok(match n.as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "esc" | "escape" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "up" | "arrowup" => Key::UpArrow,
        "down" | "arrowdown" => Key::DownArrow,
        "left" | "arrowleft" => Key::LeftArrow,
        "right" | "arrowright" => Key::RightArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "space" => Key::Space,
        "shift" => Key::Shift,
        "ctrl" | "control" => Key::Control,
        "alt" | "option" | "opt" => Key::Alt,
        "cmd" | "command" | "meta" | "win" | "super" => Key::Meta,
        "capslock" => Key::CapsLock,
        "f1" => Key::F1, "f2" => Key::F2, "f3" => Key::F3, "f4" => Key::F4, "f5" => Key::F5, "f6" => Key::F6,
        "f7" => Key::F7, "f8" => Key::F8, "f9" => Key::F9, "f10" => Key::F10, "f11" => Key::F11, "f12" => Key::F12,
        _ => {
            let mut cs = name.chars();
            match (cs.next(), cs.next()) {
                (Some(c), None) => Key::Unicode(c.to_ascii_lowercase()),
                _ => return Err(format!("unknown key {name}")),
            }
        }
    })
}

fn press(e: &mut Enigo, combo: &str) -> Result<(), String> {
    let parts: Vec<&str> = combo.split('+').filter(|p| !p.is_empty()).collect();
    let Some((last, mods)) = parts.split_last() else { return Err("no key".into()) };
    let mods: Vec<Key> = mods.iter().map(|m| key_of(m)).collect::<Result<_, _>>()?;
    let key = key_of(last)?;
    for m in &mods {
        e.key(*m, Direction::Press).map_err(ie)?;
    }
    let r = e.key(key, Direction::Click).map_err(ie);
    for m in mods.iter().rev() {
        let _ = e.key(*m, Direction::Release);
    }
    r
}

// ---------------------------------------------------------------- commands

pub async fn run(b: &Arc<Bridge>, kind: &str, a: &Value) -> R {
    let cfg = b.config();
    if cfg.paused && !matches!(kind, "info" | "displays") {
        return Err("paused on this computer: its owner has to resume it (the tray icon)".into());
    }
    let need = |ok: bool, what: &str| if ok { Ok(()) } else { Err(format!("{what} is switched off on this computer (its settings)")) };
    match kind {
        "info" => Ok(json!({ "info": info(), "displays": displays()?, "allow": cfg.allow, "paused": cfg.paused, "permissions": permissions() })),
        "displays" => Ok(json!(displays()?)),
        "screenshot" => screenshot(a).await,
        "click" | "move" | "drag" | "scroll" | "type" | "key" | "open" | "focus" | "clipboard_get" | "clipboard_set" => {
            need(cfg.allow.input, "Mouse and keyboard control")?;
            input(b, kind, a).await
        }
        "ui_tree" => ui_tree(b).await,
        "apps" => apps().await,
        "run" => {
            need(cfg.allow.shell, "Running commands")?;
            overlay::show(&b.app, None, &by(a), &format!("running {}", text(a, "command").unwrap_or("").chars().take(40).collect::<String>()));
            shell(a).await
        }
        "ls" | "read" | "write" => {
            need(cfg.allow.files, "File access")?;
            files(kind, a).await
        }
        _ => Err(format!("unknown command {kind}")),
    }
}

async fn screenshot(a: &Value) -> R {
    let id = a.get("display").and_then(|v| v.as_u64());
    let max_w = num(a, "maxWidth").unwrap_or(1600.0).clamp(200.0, 4000.0);
    let quality = num(a, "quality").unwrap_or(70.0).clamp(10.0, 95.0) as u8;
    screen_allowed()?;
    tokio::task::spawn_blocking(move || {
        let (d, m) = pick(id)?;
        let img = m.capture_image().map_err(|e| format!("can't capture the screen: {e} (on macOS: System Settings → Privacy & Security → Screen Recording → allow Spiridus Desktop)"))?;
        let w = (d.width.min(max_w)).round().max(1.0) as u32;
        let h = ((d.height * w as f64 / d.width).round().max(1.0)) as u32;
        let small = image::imageops::resize(&img, w, h, image::imageops::FilterType::Triangle);
        let rgb = image::DynamicImage::ImageRgba8(small).to_rgb8();
        let mut buf = vec![];
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality).encode_image(&rgb).map_err(|e| e.to_string())?;
        Ok(json!({
            "dataUrl": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)),
            "display": d.id, "width": d.width, "height": d.height, "imageWidth": w, "imageHeight": h,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn input(b: &Arc<Bridge>, kind: &str, a: &Value) -> R {
    match kind {
        "click" | "move" => {
            let (x, y) = target(b, a)?;
            let button = match text(a, "button").unwrap_or("left") {
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let count = num(a, "count").unwrap_or(1.0).clamp(1.0, 3.0) as u32;
            let what = if kind == "move" { "pointing here".to_string() } else if count > 1 { "double-clicking".into() } else if matches!(button, Button::Right) { "right-clicking".into() } else { "clicking".into() };
            announce(b, a, Some((x, y)), &what).await;
            let move_only = kind == "move";
            tokio::task::spawn_blocking(move || {
                with_enigo(|e| {
                    e.move_mouse(x, y, Coordinate::Abs).map_err(ie)?;
                    if !move_only {
                        for _ in 0..count {
                            e.button(button, Direction::Click).map_err(ie)?;
                        }
                    }
                    Ok(())
                })
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(json!({ "at": [x, y] }))
        }
        "drag" => {
            let (x, y) = target(b, a)?;
            let (tx, ty) = target(b, &json!({ "x": num(a, "toX"), "y": num(a, "toY"), "display": a.get("display") }))?;
            announce(b, a, Some((x, y)), "dragging").await;
            tokio::task::spawn_blocking(move || {
                with_enigo(|e| {
                    e.move_mouse(x, y, Coordinate::Abs).map_err(ie)?;
                    e.button(Button::Left, Direction::Press).map_err(ie)?;
                    for i in 1..=10 {
                        let (px, py) = (x + (tx - x) * i / 10, y + (ty - y) * i / 10);
                        e.move_mouse(px, py, Coordinate::Abs).map_err(ie)?;
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    e.button(Button::Left, Direction::Release).map_err(ie)
                })
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(json!({ "from": [x, y], "to": [tx, ty] }))
        }
        "scroll" => {
            let at = if num(a, "x").is_some() { Some(target(b, a)?) } else { None };
            let (dx, dy) = (num(a, "dx").unwrap_or(0.0).round() as i32, num(a, "dy").unwrap_or(3.0).round() as i32);
            announce(b, a, at, if dy < 0 { "scrolling up" } else { "scrolling down" }).await;
            tokio::task::spawn_blocking(move || {
                with_enigo(|e| {
                    if let Some((x, y)) = at {
                        e.move_mouse(x, y, Coordinate::Abs).map_err(ie)?;
                    }
                    if dy != 0 {
                        e.scroll(dy, Axis::Vertical).map_err(ie)?;
                    }
                    if dx != 0 {
                        e.scroll(dx, Axis::Horizontal).map_err(ie)?;
                    }
                    Ok(())
                })
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(json!({ "scrolled": [dx, dy] }))
        }
        "type" => {
            let t = text(a, "text").ok_or("type takes text")?.to_string();
            let shown: String = t.chars().take(30).collect();
            announce(b, a, None, &format!("typing \"{shown}{}\"", if t.chars().count() > 30 { "…" } else { "" })).await;
            let n = t.chars().count();
            tokio::task::spawn_blocking(move || with_enigo(|e| e.text(&t).map_err(ie))).await.map_err(|e| e.to_string())??;
            Ok(json!({ "typed": n }))
        }
        "key" => {
            let k = text(a, "key").ok_or("key takes a key, e.g. enter or cmd+c")?.to_string();
            announce(b, a, None, &format!("pressing {k}")).await;
            let combos: Vec<String> = k.split_whitespace().map(String::from).collect();
            tokio::task::spawn_blocking(move || {
                with_enigo(|e| {
                    for c in &combos {
                        press(e, c)?;
                        std::thread::sleep(Duration::from_millis(30));
                    }
                    Ok(())
                })
            })
            .await
            .map_err(|e| e.to_string())??;
            Ok(json!({ "pressed": k }))
        }
        "open" => {
            let t = text(a, "target").ok_or("open takes a target: an app's name, a path or a URL")?.to_string();
            announce(b, a, None, &format!("opening {t}")).await;
            open(&t).await
        }
        "focus" => {
            let app = text(a, "app").ok_or("focus takes an app")?.to_string();
            announce(b, a, None, &format!("switching to {app}")).await;
            focus(&app).await
        }
        "clipboard_get" => tokio::task::spawn_blocking(|| with_clipboard(|c| Ok(json!({ "text": c.get_text().unwrap_or_default() }))))
            .await
            .map_err(|e| e.to_string())?,
        "clipboard_set" => {
            let t = text(a, "text").ok_or("clipboard_set takes text")?.to_string();
            tokio::task::spawn_blocking(move || {
                with_clipboard(|c| {
                    c.set_text(t).map_err(|e| e.to_string())?;
                    Ok(json!({ "set": true }))
                })
            })
            .await
            .map_err(|e| e.to_string())?
        }
        _ => Err(format!("unknown command {kind}")),
    }
}

/// One clipboard handle for the app's life: on Linux the text is only there while its owner holds it.
fn with_clipboard<T>(f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, String>) -> Result<T, String> {
    static CLIP: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);
    let mut slot = CLIP.lock().unwrap();
    if slot.is_none() {
        *slot = Some(arboard::Clipboard::new().map_err(|e| format!("can't use the clipboard: {e}"))?);
    }
    f(slot.as_mut().unwrap())
}

// ---------------------------------------------------------------- processes

/// A program's output, both streams, cut to `max` bytes each.
async fn exec(program: &str, args: &[&str], cwd: Option<&str>, timeout_ms: u64, max: usize) -> R {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args).kill_on_drop(true).stdin(std::process::Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(expand(dir));
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.output())
        .await
        .map_err(|_| format!("timed out after {} s", timeout_ms / 1000))?
        .map_err(|e| format!("can't start {program}: {e}"))?;
    let cut = |b: &[u8]| {
        let s = String::from_utf8_lossy(b);
        if s.len() > max { format!("{}… ({} bytes)", &s[..s.floor_char_boundary(max)], s.len()) } else { s.into_owned() }
    };
    Ok(json!({ "code": out.status.code(), "stdout": cut(&out.stdout), "stderr": cut(&out.stderr) }))
}

async fn shell(a: &Value) -> R {
    let c = text(a, "command").ok_or("run takes a command")?;
    let timeout = num(a, "timeoutMs").unwrap_or(60_000.0).clamp(1000.0, 170_000.0) as u64;
    let cwd = text(a, "cwd");
    #[cfg(windows)]
    return exec("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command", c], cwd, timeout, 100_000).await;
    #[cfg(not(windows))]
    {
        let sh = std::env::var("SHELL").unwrap_or_else(|_| if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() });
        exec(&sh, &["-lc", c], cwd.or(Some("~")), timeout, 100_000).await
    }
}

async fn open(t: &str) -> R {
    #[cfg(target_os = "macos")]
    let r = {
        let is_place = t.contains("://") || t.starts_with('/') || t.starts_with('~');
        if is_place { exec("open", &[&expand(t)], None, 15_000, 4000).await } else { exec("open", &["-a", t], None, 15_000, 4000).await }
    };
    #[cfg(windows)]
    let r = exec("cmd", &["/C", "start", "", t], None, 15_000, 4000).await;
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = exec("sh", &["-c", "command -v xdg-open >/dev/null && xdg-open \"$1\" || (\"$1\" >/dev/null 2>&1 &)", "sh", t], None, 15_000, 4000).await;
    let v = r?;
    if v["code"].as_i64().unwrap_or(0) != 0 {
        return Err(format!("couldn't open {t}: {}", v["stderr"].as_str().unwrap_or("").trim()));
    }
    Ok(json!({ "opened": t }))
}

async fn focus(app: &str) -> R {
    #[cfg(target_os = "macos")]
    let r = exec("osascript", &["-e", &format!("tell application {} to activate", applescript_string(app))], None, 10_000, 4000).await;
    #[cfg(windows)]
    let r = exec("powershell.exe", &["-NoProfile", "-Command", "param($n) $p = Get-Process | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -like \"*$n*\" -or $_.MainWindowTitle -like \"*$n*\") } | Select-Object -First 1; if (!$p) { throw \"no window for $n\" }; (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null", app], None, 10_000, 4000).await;
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = exec("wmctrl", &["-a", app], None, 10_000, 4000).await;
    let v = r?;
    if v["code"].as_i64().unwrap_or(0) != 0 {
        return Err(format!("couldn't switch to {app}: {}", v["stderr"].as_str().unwrap_or("").trim()));
    }
    Ok(json!({ "focused": app }))
}

#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

async fn apps() -> R {
    #[cfg(target_os = "macos")]
    let r = exec("osascript", &["-l", "JavaScript", "-e", MAC_APPS], None, 15_000, 200_000).await;
    #[cfg(windows)]
    let r = exec("powershell.exe", &["-NoProfile", "-Command", WIN_APPS], None, 15_000, 200_000).await;
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = exec("sh", &["-c", "(wmctrl -lp 2>/dev/null || ps -eo pid,comm --no-headers | head -100) | grep -v 'Spiridus overlay'"], None, 10_000, 200_000).await;
    let v = r?;
    let out = v["stdout"].as_str().unwrap_or("").trim().to_string();
    Ok(serde_json::from_str::<Value>(&out).unwrap_or(json!({ "text": out })))
}

#[cfg(target_os = "macos")]
const MAC_APPS: &str = r#"
const se = Application("System Events");
const procs = se.applicationProcesses.whose({ backgroundOnly: false });
const names = procs.name(), front = procs.frontmost();
JSON.stringify({ apps: names.map((n, i) => ({ name: n, frontmost: front[i] })) });
"#;

#[cfg(windows)]
const WIN_APPS: &str = r#"
Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ name = $_.ProcessName; title = $_.MainWindowTitle; pid = $_.Id } } | ConvertTo-Json -Compress
"#;

// ---------------------------------------------------------------- the UI tree

async fn ui_tree(b: &Arc<Bridge>) -> R {
    #[cfg(target_os = "macos")]
    let r = exec("osascript", &["-l", "JavaScript", "-e", MAC_TREE], None, 30_000, 2_000_000).await;
    #[cfg(windows)]
    let r = exec("powershell.exe", &["-NoProfile", "-Command", WIN_TREE], None, 30_000, 2_000_000).await;
    #[cfg(all(unix, not(target_os = "macos")))]
    let r: R = Err("reading the UI isn't supported on Linux yet: use screenshots and x, y".into());
    let v = r?;
    let raw = v["stdout"].as_str().unwrap_or("").trim();
    let tree: Value = serde_json::from_str(raw).map_err(|_| {
        let err = v["stderr"].as_str().unwrap_or("").trim();
        if err.contains("-1719") || err.contains("assistive") {
            "Spiridus Desktop may not read the UI yet: System Settings → Privacy & Security → Accessibility → allow it".to_string()
        } else {
            format!("couldn't read the UI: {}", if err.is_empty() { raw } else { err }.chars().take(300).collect::<String>())
        }
    })?;
    let mut refs = b.refs.lock().unwrap();
    refs.clear();
    let mut lines = vec![];
    let elements = tree["elements"].as_array().cloned().unwrap_or_default();
    for (i, e) in elements.iter().enumerate() {
        let (x, y, w, h) = (num(e, "x").unwrap_or(0.0), num(e, "y").unwrap_or(0.0), num(e, "w").unwrap_or(0.0), num(e, "h").unwrap_or(0.0));
        let r = format!("e{}", i + 1);
        refs.insert(r.clone(), (x + w / 2.0, y + h / 2.0));
        let name = text(e, "name").unwrap_or("").replace('"', "'");
        let mut line = format!("[{r}] {} \"{}\"", text(e, "role").unwrap_or("?"), name.chars().take(80).collect::<String>());
        if let Some(val) = text(e, "value").filter(|v| !v.is_empty()) {
            line.push_str(&format!(" value=\"{}\"", val.chars().take(60).collect::<String>()));
        }
        if e.get("enabled") == Some(&json!(false)) {
            line.push_str(" disabled");
        }
        lines.push(line);
    }
    Ok(json!({ "app": tree["app"], "window": tree["window"], "count": lines.len(), "elements": lines.join("\n") }))
}

/// The frontmost app's front window, its elements with a role and a size (Accessibility, via System Events).
#[cfg(target_os = "macos")]
const MAC_TREE: &str = r#"
const se = Application("System Events");
const app = se.applicationProcesses.whose({ frontmost: true })[0];
const win = app.windows.length ? app.windows[0] : null;
const out = [];
if (win) {
  const all = win.entireContents();
  for (let i = 0; i < all.length && out.length < 400; i++) {
    const e = all[i];
    try {
      const role = e.role(), size = e.size(), pos = e.position();
      if (!size || size[0] < 2 || size[1] < 2) continue;
      if (["AXGroup", "AXLayoutArea", "AXSplitGroup", "AXScrollArea", "AXUnknown"].includes(role)) continue;
      let name = ""; try { name = e.name() || e.description() || e.title() || ""; } catch (x) {}
      let value = ""; try { const v = e.value(); value = v == null ? "" : String(v); } catch (x) {}
      let enabled = true; try { enabled = e.enabled(); } catch (x) {}
      out.push({ role: role.replace(/^AX/, ""), name, value: value.slice(0, 100), x: pos[0], y: pos[1], w: size[0], h: size[1], enabled });
    } catch (x) {}
  }
}
JSON.stringify({ app: app.name(), window: win ? win.name() : null, elements: out });
"#;

/// The foreground window's elements (UI Automation). Coordinates are device pixels, as input takes them.
#[cfg(windows)]
const WIN_TREE: &str = r#"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[Fg]::SetProcessDPIAware() | Out-Null
$h = [Fg]::GetForegroundWindow()
$win = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$skip = @('Pane', 'Group', 'Custom', 'Separator', 'Image', 'Thumb', 'TitleBar', 'ScrollBar')
$out = New-Object System.Collections.ArrayList
foreach ($e in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
  if ($out.Count -ge 400) { break }
  $c = $e.Current
  if ($c.IsOffscreen) { continue }
  $r = $c.BoundingRectangle
  if ($r.Width -lt 2 -or $r.Height -lt 2) { continue }
  $role = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
  if ($skip -contains $role -and -not $c.Name) { continue }
  $value = ''
  try { $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $value = $vp.Current.Value } catch {}
  [void]$out.Add([pscustomobject]@{ role = $role; name = $c.Name; value = $value; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height; enabled = $c.IsEnabled })
}
@{ app = (Get-Process -Id $win.Current.ProcessId).ProcessName; window = $win.Current.Name; elements = $out } | ConvertTo-Json -Depth 4 -Compress
"#;

// ---------------------------------------------------------------- files

fn expand(p: &str) -> String {
    if let Some(rest) = p.strip_prefix('~') {
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
        return format!("{home}{rest}");
    }
    p.to_string()
}

async fn files(kind: &str, a: &Value) -> R {
    let path = expand(text(a, "path").ok_or("say which path")?);
    match kind {
        "ls" => {
            let mut rd = tokio::fs::read_dir(&path).await.map_err(|e| format!("{path}: {e}"))?;
            let mut items = vec![];
            while let Ok(Some(e)) = rd.next_entry().await {
                if items.len() >= 1000 {
                    break;
                }
                let md = e.metadata().await.ok();
                items.push(json!({
                    "name": e.file_name().to_string_lossy(),
                    "dir": md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                    "size": md.as_ref().map(|m| m.len()).unwrap_or(0),
                }));
            }
            items.sort_by(|x, y| (!x["dir"].as_bool().unwrap_or(false), x["name"].as_str().unwrap_or("")).cmp(&(!y["dir"].as_bool().unwrap_or(false), y["name"].as_str().unwrap_or(""))));
            Ok(json!({ "path": path, "items": items }))
        }
        "read" => {
            let max = num(a, "max").unwrap_or(1_000_000.0).clamp(1.0, 20_000_000.0) as usize;
            let bytes = tokio::fs::read(&path).await.map_err(|e| format!("{path}: {e}"))?;
            let size = bytes.len();
            let bytes = &bytes[..size.min(max)];
            match std::str::from_utf8(bytes) {
                Ok(t) => Ok(json!({ "path": path, "size": size, "text": t, "truncated": size > max })),
                Err(_) => Ok(json!({ "path": path, "size": size, "base64": base64::engine::general_purpose::STANDARD.encode(bytes), "truncated": size > max })),
            }
        }
        "write" => {
            let data = if let Some(t) = text(a, "text") {
                t.as_bytes().to_vec()
            } else if let Some(b64) = text(a, "base64") {
                base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| format!("bad base64: {e}"))?
            } else {
                return Err("write takes text or base64".into());
            };
            if a.get("append") == Some(&json!(true)) {
                use tokio::io::AsyncWriteExt;
                let mut f = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await.map_err(|e| format!("{path}: {e}"))?;
                f.write_all(&data).await.map_err(|e| e.to_string())?;
            } else {
                tokio::fs::write(&path, &data).await.map_err(|e| format!("{path}: {e}"))?;
            }
            Ok(json!({ "path": path, "written": data.len() }))
        }
        _ => Err(format!("unknown command {kind}")),
    }
}
