//! The connection to Spiridus: one WebSocket to `<server>/browser-ws` (admin/server/browser-bridge.mjs, the same
//! hub as the Chrome extension), kept open and reconnected. Pairing claims a one-time code from Spiridus's
//! Browsers page and keeps the token it gets; after that every connection says hello with the token. Commands
//! come as `{t:"cmd", id, type, args}` and are answered `{t:"result", id, ok, data | error}` (actions.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio_tungstenite::tungstenite::Message;

use crate::actions;
use crate::config::{norm_server, socket_url, Config};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Serialize, Default)]
pub struct Status {
    /// idle (not paired) | connecting | connected | disconnected
    pub state: String,
    pub error: String,
}

pub struct Bridge {
    pub app: AppHandle,
    cfg_path: PathBuf,
    cfg: Mutex<Config>,
    status: Mutex<Status>,
    /// wakes the connection loop: paired, unpaired, reconnect
    wake: Notify,
    /// drops the current socket (unpair)
    hangup: Notify,
    claim: Mutex<Option<(String, String, oneshot::Sender<Result<String, String>>)>>,
    out: Mutex<Option<mpsc::UnboundedSender<String>>>,
    /// ui_tree refs → their middle (logical points, global), for click {ref}
    pub refs: Mutex<HashMap<String, (f64, f64)>>,
}

impl Bridge {
    pub fn new(app: AppHandle, cfg_path: PathBuf) -> Arc<Bridge> {
        let cfg = Config::load(&cfg_path);
        Arc::new(Bridge {
            app,
            cfg_path,
            cfg: Mutex::new(cfg),
            status: Mutex::new(Status { state: "idle".into(), error: String::new() }),
            wake: Notify::new(),
            hangup: Notify::new(),
            claim: Mutex::new(None),
            out: Mutex::new(None),
            refs: Mutex::new(HashMap::new()),
        })
    }

    pub fn config(&self) -> Config {
        self.cfg.lock().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut Config)) {
        let mut c = self.cfg.lock().unwrap();
        f(&mut c);
        c.save(&self.cfg_path);
        drop(c);
        self.changed();
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set_status(&self, state: &str, error: Option<String>) {
        {
            let mut s = self.status.lock().unwrap();
            s.state = state.into();
            if let Some(e) = error {
                s.error = e;
            } else if state == "connected" {
                s.error.clear();
            }
        }
        self.changed();
    }

    /// Tell the windows (settings, chat, overlays) and the tray that something changed, and Spiridus our state.
    pub fn changed(&self) {
        let _ = self.app.emit("bridge-state", self.ui_state());
        crate::tray::refresh(&self.app);
        self.report_state();
    }

    pub fn ui_state(&self) -> Value {
        let c = self.config();
        let s = self.status();
        json!({
            "server": c.server, "paired": c.token.is_some(), "name": c.name, "linkId": c.link_id,
            "paused": c.paused, "allow": c.allow, "status": s.state, "error": s.error, "version": VERSION,
            "os": actions::os_name(), "hostname": actions::hostname(), "user": actions::username(),
        })
    }

    pub fn send(&self, msg: Value) {
        if let Some(tx) = self.out.lock().unwrap().as_ref() {
            let _ = tx.send(msg.to_string());
        }
    }

    /// Our state, for Spiridus's Browsers page: the displays, and what this computer's owner allows.
    pub fn report_state(&self) {
        let c = self.config();
        self.send(json!({ "t": "state", "state": {
            "displays": actions::displays().unwrap_or_default(),
            "os": actions::os_name(), "hostname": actions::hostname(), "user": actions::username(),
            "paused": c.paused, "allow": c.allow, "version": VERSION, "permissions": actions::permissions(),
        }}));
    }

    /// Pair with a one-time code from Spiridus's Browsers page. Resolves with the name Spiridus gave this computer.
    pub async fn pair(self: &Arc<Self>, server: &str, code: &str, name: &str) -> Result<String, String> {
        let server = norm_server(server)?;
        let (tx, rx) = oneshot::channel();
        self.update(|c| {
            c.server = server.clone();
            c.token = None;
            c.link_id = None;
        });
        *self.claim.lock().unwrap() = Some((code.trim().to_string(), name.trim().to_string(), tx));
        self.hangup.notify_waiters();
        self.wake.notify_one();
        match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(Ok(r)) => r,
            _ => {
                self.claim.lock().unwrap().take();
                Err(format!("no answer from {server}"))
            }
        }
    }

    pub fn unpair(&self) {
        self.send(json!({ "t": "unpair" }));
        self.update(|c| {
            c.token = None;
            c.link_id = None;
        });
        self.hangup.notify_waiters();
        self.wake.notify_one();
    }

    pub fn reconnect(&self) {
        self.hangup.notify_waiters();
        self.wake.notify_one();
    }

    /// The connection, for as long as the app runs.
    pub async fn run(self: Arc<Self>) {
        let mut backoff = 1u64;
        loop {
            let cfg = self.config();
            let claiming = self.claim.lock().unwrap().is_some();
            if cfg.server.is_empty() || (cfg.token.is_none() && !claiming) {
                self.set_status("idle", None);
                self.wake.notified().await;
                continue;
            }
            self.set_status("connecting", None);
            let url = socket_url(&cfg.server);
            let ws = match tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async(url.as_str())).await {
                Ok(Ok((ws, _))) => ws,
                Ok(Err(e)) => {
                    self.fail_claim(format!("can't reach {}: {e}", cfg.server));
                    self.set_status("disconnected", Some(format!("can't reach {}", cfg.server)));
                    self.pause_before_retry(&mut backoff).await;
                    continue;
                }
                Err(_) => {
                    self.fail_claim(format!("{} didn't answer", cfg.server));
                    self.set_status("disconnected", Some(format!("{} didn't answer", cfg.server)));
                    self.pause_before_retry(&mut backoff).await;
                    continue;
                }
            };
            let (mut write, mut read) = ws.split();
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();

            let first = match self.claim.lock().unwrap().as_ref() {
                Some((code, name, _)) => json!({ "t": "claim", "kind": "desktop", "code": code, "name": name, "info": actions::info() }),
                None => json!({ "t": "hello", "token": cfg.token, "info": actions::info() }),
            };
            if write.send(Message::text(first.to_string())).await.is_err() {
                self.pause_before_retry(&mut backoff).await;
                continue;
            }
            *self.out.lock().unwrap() = Some(tx.clone());

            let writer = tokio::spawn(async move {
                while let Some(m) = rx.recv().await {
                    if write.send(Message::text(m)).await.is_err() {
                        break;
                    }
                }
                let _ = write.close().await;
            });
            // Traffic every 20 s keeps proxies from dropping a quiet socket.
            let pinger = {
                let tx = tx.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(20)).await;
                        if tx.send(json!({ "t": "ping" }).to_string()).is_err() {
                            break;
                        }
                    }
                })
            };

            // Our state again every minute: displays come and go, and on macOS the list is empty until Screen
            // Recording is allowed, which can happen after we connected.
            let reporter = {
                let me = Arc::clone(&self);
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        me.report_state();
                    }
                })
            };

            let mut closed: Option<(u16, String)> = None;
            loop {
                tokio::select! {
                    _ = self.hangup.notified() => break,
                    m = read.next() => match m {
                        Some(Ok(Message::Text(t))) => {
                            if let Ok(v) = serde_json::from_str::<Value>(t.as_str()) {
                                self.on_message(v, &mut backoff);
                            }
                        }
                        Some(Ok(Message::Close(frame))) => {
                            closed = frame.map(|f| (u16::from(f.code), f.reason.to_string()));
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) | None => break,
                    }
                }
            }
            *self.out.lock().unwrap() = None;
            pinger.abort();
            reporter.abort();
            writer.abort();

            let (code, reason) = closed.unwrap_or((1006, String::new()));
            if !reason.is_empty() {
                self.set_status("disconnected", Some(reason.clone()));
            } else {
                self.set_status("disconnected", None);
            }
            self.fail_claim(if reason.is_empty() { "the connection closed".into() } else { reason.clone() });
            if code == 4401 {
                // revoked, or a token Spiridus doesn't know: wait for a new pairing
                self.update(|c| {
                    c.token = None;
                    c.link_id = None;
                });
                continue;
            }
            if code == 4409 {
                // A newer connection with our token took over (a second copy of the app, where the single-instance
                // check couldn't see this one). Try again much later, in case that one is gone by then.
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(300)) => {}
                    _ = self.wake.notified() => {}
                }
                continue;
            }
            self.pause_before_retry(&mut backoff).await;
        }
    }

    fn fail_claim(&self, why: String) {
        if let Some((_, _, tx)) = self.claim.lock().unwrap().take() {
            let _ = tx.send(Err(why));
        }
    }

    async fn pause_before_retry(&self, backoff: &mut u64) {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(*backoff)) => {}
            _ = self.wake.notified() => {}
        }
        *backoff = (*backoff * 2).min(30);
    }

    fn on_message(self: &Arc<Self>, v: Value, backoff: &mut u64) {
        match v["t"].as_str().unwrap_or("") {
            "paired" => {
                let token = v["token"].as_str().map(String::from);
                let name = v["name"].as_str().unwrap_or("").to_string();
                self.update(|c| {
                    c.token = token;
                    c.link_id = v["id"].as_i64();
                    c.name = name.clone();
                });
                *backoff = 1;
                self.set_status("connected", None);
                if let Some((_, _, tx)) = self.claim.lock().unwrap().take() {
                    let _ = tx.send(Ok(name));
                }
                crate::enable_autostart(&self.app);
            }
            "welcome" => {
                let name = v["name"].as_str().unwrap_or("").to_string();
                self.update(|c| {
                    c.name = name;
                    c.link_id = v["id"].as_i64();
                });
                *backoff = 1;
                self.set_status("connected", None);
            }
            "refused" => {
                let why = v["reason"].as_str().unwrap_or("refused").to_string();
                self.status.lock().unwrap().error = why;
            }
            "cmd" => {
                let me = Arc::clone(self);
                tauri::async_runtime::spawn(async move {
                    let id = v["id"].clone();
                    let kind = v["type"].as_str().unwrap_or("").to_string();
                    let args = v.get("args").cloned().unwrap_or(json!({}));
                    let reply = match actions::run(&me, &kind, &args).await {
                        Ok(data) => json!({ "t": "result", "id": id, "ok": true, "data": data }),
                        Err(e) => json!({ "t": "result", "id": id, "ok": false, "error": e }),
                    };
                    me.send(reply);
                });
            }
            _ => {}
        }
    }
}

pub fn bridge(app: &AppHandle) -> Arc<Bridge> {
    app.state::<Arc<Bridge>>().inner().clone()
}
