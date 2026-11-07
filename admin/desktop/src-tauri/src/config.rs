//! What the app keeps between runs (`config.json` in its config dir): which Spiridus it pairs with, the
//! pairing token, this computer's name there, and what its owner lets Spiridus do here.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Allow {
    /// mouse, keyboard, clipboard, opening apps
    pub input: bool,
    /// running shell commands
    pub shell: bool,
    /// reading and writing files
    pub files: bool,
}

impl Default for Allow {
    fn default() -> Self {
        Allow { input: true, shell: true, files: true }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    /// e.g. https://paul.cloud.teleporthq.ai/admin
    pub server: String,
    pub token: Option<String>,
    pub link_id: Option<i64>,
    pub name: String,
    /// "Pause" in the tray: commands are refused until resumed (the connection stays)
    pub paused: bool,
    pub allow: Allow,
}

impl Config {
    pub fn load(path: &PathBuf) -> Config {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let Ok(json) = serde_json::to_string_pretty(self) else { return };
        let tmp = path.with_extension("tmp");
        if std::fs::write(&tmp, json).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                // the token is in it: only this user reads it
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// "https://host/admin/browsers" or "host/admin" → "https://host/admin"
pub fn norm_server(raw: &str) -> Result<String, String> {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("the Spiridus address is empty".into());
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("https://{s}");
    }
    for suffix in ["/browsers", "/login"] {
        if let Some(t) = s.strip_suffix(suffix) {
            s = t.to_string();
        }
    }
    Ok(s)
}

/// https://host/admin → wss://host/admin/browser-ws
pub fn socket_url(server: &str) -> String {
    let rest = server
        .strip_prefix("https://")
        .map(|r| format!("wss://{r}"))
        .or_else(|| server.strip_prefix("http://").map(|r| format!("ws://{r}")))
        .unwrap_or_else(|| server.to_string());
    format!("{}/browser-ws", rest.trim_end_matches('/'))
}
