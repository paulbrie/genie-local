/**
 * Spiridus Bridge, the service worker. It keeps one WebSocket open to Spiridus
 * (<server>/browser-ws, see admin/server/browser-bridge.mjs) and runs the
 * commands Spiridus sends in the tabs its user shared from the popup, or that
 * Spiridus opened itself. Control goes through chrome.debugger (the DevTools
 * protocol), so clicks and keys are real input events, and `cdp` passes any
 * DevTools command straight through. Chrome shows its "being debugged" bar on
 * the tabs being controlled; cancelling it unshares the tab.
 *
 * Commands ({type, args}; `tabId` defaults to the only shared tab, else the
 * focused window's active tab when it's shared):
 *   tabs                                  the shared tabs
 *   open {url, active?}                   a new tab (shared, marked as opened by Spiridus)
 *   close | activate | reload | back | forward {tabId}
 *   navigate {tabId, url}                 waits for the load (up to 20 s)
 *   screenshot {tabId, format?, quality?, fullPage?}  data URL + the CSS viewport it shows
 *   snapshot {tabId, maxText?}            interactive elements with refs (e12), headings, page text
 *   click | hover {tabId, ref | selector | text [, nth] | x, y [, button, clickCount]}
 *   type {tabId, text, ref|selector|text?, clear?, submit?}
 *   key {tabId, key}                      "Enter", "Control+a", "Shift+Tab", "a"…
 *   scroll {tabId, dx?, dy?, x?, y?}      a mouse wheel turn
 *   select {tabId, ref|selector, value}   pick a <select> option by value or label
 *   eval {tabId, expression}              its value (awaited, JSON)
 *   html {tabId, selector?, max?} | text {tabId, max?}
 *   wait {tabId, selector? | text?, timeoutMs?}
 *   viewport {tabId}
 *   dialog {tabId, accept, promptText?}   answer an alert/confirm/prompt
 *   cdp {tabId, method, params?}          any DevTools protocol command
 *   subscribe {tabId, methods: [...]}     forward these DevTools events too
 *
 * Any command may say `by` (who is acting: "Alice", "Claude"); the tab's overlay (overlay.js) shows its cursor
 * going where it acts, with that name and what it does.
 */
import { DEFAULT_SERVER } from "./config.js";

const VERSION = chrome.runtime.getManifest().version;
const PING_MS = 20_000;
const NAV_WAIT_MS = 20_000;
const MAX_TEXT = 20_000;

// ------------------------------------------------------------------ state

let ws = null;
let status = "idle"; // idle | connecting | connected | disconnected
let lastError = "";
let backoff = 1000;
let reconnectTimer = null;
let pingTimer = null;
/** while a pairing is in flight: its resolve */
let claimDone = null;

/** tabId → "user" | "opened" (session storage: tab ids don't outlive the browser) */
let shared = {};
let shareAll = false;
/** tabId → Set of extra CDP event methods to forward */
const subscriptions = new Map();
const attached = new Set();

const loaded = (async () => {
  shared = (await chrome.storage.session.get("shared")).shared ?? {};
  shareAll = !!(await chrome.storage.local.get("shareAll")).shareAll;
})();

const settings = () => chrome.storage.local.get(["server", "token", "linkId", "name"]);
const saveShared = () => chrome.storage.session.set({ shared });

// ------------------------------------------------------------------ connection

function normServer(raw) {
  const u = new URL(String(raw).trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("the address must start with https://");
  u.pathname = u.pathname.replace(/\/+$/, "").replace(/\/(browsers|login)$/, "");
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}
function socketUrl(server) {
  const u = new URL(server);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/browser-ws";
  return u.toString();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function info() {
  return { userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform ?? navigator.platform, version: VERSION };
}

/** Open the socket: with `claim` it pairs ({server, code, name}), else it says hello with the saved token. */
async function connect(claim) {
  await loaded;
  clearTimeout(reconnectTimer);
  const s = await settings();
  const server = claim?.server ?? s.server;
  if (!server || (!claim && !s.token)) {
    status = "idle";
    return;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
  }
  status = "connecting";
  const sock = new WebSocket(socketUrl(server));
  ws = sock;
  sock.onopen = () => {
    if (claim) sock.send(JSON.stringify({ t: "claim", code: claim.code, name: claim.name, info: info() }));
    else sock.send(JSON.stringify({ t: "hello", token: s.token, info: info() }));
  };
  sock.onmessage = (ev) => onMessage(sock, ev.data);
  sock.onerror = () => {
    lastError = `can't reach ${server}`;
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    status = "disconnected";
    clearInterval(pingTimer);
    refreshBadges();
    pushOverlay();
    if (ev.reason) lastError = ev.reason;
    if (claimDone) {
      claimDone({ ok: false, error: lastError || "the connection closed" });
      claimDone = null;
    }
    if (ev.code === 4401) {
      // Revoked, or a code/token that doesn't work: stop trying until paired again.
      if (!claim) chrome.storage.local.remove(["token", "linkId"]);
      detachAll();
      return;
    }
    if (ev.code === 4409) return; // a newer connection of ours took over
    reconnectTimer = setTimeout(() => connect(), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

function onConnected() {
  status = "connected";
  lastError = "";
  backoff = 1000;
  clearInterval(pingTimer);
  // Traffic every 20 s also keeps this service worker alive (Chrome 116+).
  pingTimer = setInterval(() => send({ t: "ping" }), PING_MS);
  reportTabs();
  refreshBadges();
  pushOverlay();
}

async function onMessage(sock, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.t) {
    case "paired":
      await chrome.storage.local.set({ token: msg.token, linkId: msg.id, name: msg.name, server: pendingServer });
      onConnected();
      claimDone?.({ ok: true, name: msg.name });
      claimDone = null;
      return;
    case "welcome":
      await chrome.storage.local.set({ linkId: msg.id, name: msg.name });
      onConnected();
      return;
    case "refused":
      lastError = msg.reason;
      return;
    case "revoked":
      lastError = "unpaired from Spiridus";
      return;
    case "cmd": {
      let reply;
      try {
        reply = { t: "result", id: msg.id, ok: true, data: await run(msg.type, msg.args ?? {}) };
      } catch (e) {
        reply = { t: "result", id: msg.id, ok: false, error: e?.message ?? String(e) };
      }
      if (ws === sock) send(reply);
      return;
    }
  }
}

let pendingServer = null;
async function pair(serverRaw, code, name) {
  const server = normServer(serverRaw);
  pendingServer = server;
  await chrome.storage.local.remove(["token", "linkId"]);
  return new Promise((resolve) => {
    claimDone = resolve;
    connect({ server, code, name });
    setTimeout(() => {
      if (claimDone === resolve) {
        claimDone = null;
        resolve({ ok: false, error: lastError || `no answer from ${server}` });
      }
    }, 15_000);
  });
}

async function unpair() {
  send({ t: "unpair" }); // Spiridus revokes the pairing too
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  clearInterval(pingTimer);
  status = "idle";
  await chrome.storage.local.remove(["token", "linkId", "name"]);
  shared = {};
  await saveShared();
  await detachAll();
  refreshBadges();
  pushOverlay();
}

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());
chrome.alarms.create("bridge-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  // Wakes the worker if Chrome stopped it while it was offline, so it tries again.
  if (a.name === "bridge-keepalive" && !ws) connect();
});
connect();

// ------------------------------------------------------------------ sharing

const RESTRICTED = /^(chrome|chrome-extension|chrome-untrusted|devtools|edge|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

function isShared(tabId) {
  return shareAll || !!shared[tabId];
}

async function setShared(tabId, on, how = "user") {
  await loaded;
  if (on) shared[tabId] = shared[tabId] ?? how;
  else {
    delete shared[tabId];
    if (!shareAll) await detach(tabId);
  }
  await saveShared();
  emit(on ? "shared" : "unshared", tabId, { how });
  refreshBadges();
  pushOverlay(tabId);
  reportTabs();
}

async function setShareAll(on) {
  shareAll = on;
  await chrome.storage.local.set({ shareAll: on });
  if (!on) for (const id of [...attached]) if (!shared[id]) await detach(id);
  emit(on ? "shared-all" : "unshared-all", undefined, {});
  refreshBadges();
  pushOverlay();
  reportTabs();
}

async function refreshBadges() {
  for (const t of await chrome.tabs.query({})) {
    const on = isShared(t.id) && status === "connected";
    chrome.action.setBadgeText({ tabId: t.id, text: on ? "ON" : "" }).catch(() => {});
  }
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a" }).catch(() => {});
}

const tabInfo = (t) => ({
  id: t.id,
  windowId: t.windowId,
  url: t.url ?? t.pendingUrl ?? "",
  title: t.title ?? "",
  active: t.active,
  status: t.status,
  opened: shared[t.id] === "opened",
  attached: attached.has(t.id),
});

async function sharedTabs() {
  const all = await chrome.tabs.query({});
  return { tabs: all.filter((t) => isShared(t.id)), unshared: all.filter((t) => !isShared(t.id)).length };
}

let tabsTimer = null;
function reportTabs() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    const { tabs, unshared } = await sharedTabs();
    send({ t: "tabs", tabs: tabs.map(tabInfo), unshared });
  }, 250);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!isShared(tabId)) return;
  if ("url" in change || "title" in change || "status" in change) reportTabs();
  if (change.status === "complete") refreshBadges();
});
chrome.tabs.onActivated.addListener(() => reportTabs());
chrome.tabs.onRemoved.addListener(async (tabId) => {
  attached.delete(tabId);
  subscriptions.delete(tabId);
  if (shared[tabId]) {
    delete shared[tabId];
    await saveShared();
  }
  reportTabs();
});

// ------------------------------------------------------------------ events to Spiridus

const buckets = new Map();
/** At most ~30 events a second per tab, so a chatty console can't flood the socket. */
function emit(kind, tabId, data) {
  const key = tabId ?? 0;
  const now = Date.now();
  const b = buckets.get(key) ?? { n: 0, at: now };
  if (now - b.at > 1000) {
    b.n = 0;
    b.at = now;
  }
  if (++b.n > 30) return;
  buckets.set(key, b);
  send({ t: "event", kind, tabId, data });
}

const clip = (s, n = 2000) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const remoteText = (o) => (o ? (o.value !== undefined ? (typeof o.value === "string" ? o.value : JSON.stringify(o.value)) : o.description ?? o.unserializableValue ?? o.type) : "");

chrome.debugger.onEvent.addListener((src, method, params) => {
  const tabId = src.tabId;
  if (!tabId || !isShared(tabId)) return;
  switch (method) {
    case "Runtime.consoleAPICalled":
      emit("console", tabId, { level: params.type, text: clip((params.args ?? []).map(remoteText).join(" ")) });
      break;
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails ?? {};
      emit("error", tabId, { text: clip(d.exception?.description ?? d.text), url: d.url, line: d.lineNumber });
      break;
    }
    case "Page.frameNavigated":
      if (!params.frame?.parentId) emit("navigated", tabId, { url: params.frame?.url });
      break;
    case "Page.javascriptDialogOpening":
      emit("dialog", tabId, { type: params.type, message: clip(params.message), defaultPrompt: params.defaultPrompt });
      break;
  }
  if (subscriptions.get(tabId)?.has(method)) {
    const json = JSON.stringify(params);
    emit("cdp", tabId, { method, params: json.length > 20_000 ? clip(json, 20_000) : params });
  }
});

chrome.debugger.onDetach.addListener(async (src, reason) => {
  const tabId = src.tabId;
  attached.delete(tabId);
  emit("detached", tabId, { reason });
  // The person clicked "Cancel" on Chrome's debugging bar: that tab is off limits now.
  if (reason === "canceled_by_user" && shared[tabId]) await setShared(tabId, false);
  reportTabs();
});

// ------------------------------------------------------------------ debugger

async function ensureAttached(tabId) {
  if (!isShared(tabId)) throw new Error(`tab ${tabId} isn't shared with Spiridus: share it from the extension's popup`);
  if (attached.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  if (RESTRICTED.test(tab.url ?? "")) throw new Error(`Chrome doesn't let extensions control ${tab.url}`);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (!/already attached/i.test(e?.message ?? "")) throw e;
  }
  attached.add(tabId);
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Runtime.enable");
  reportTabs();
}

async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  subscriptions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
async function detachAll() {
  for (const id of [...attached]) await detach(id);
}

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

/** Run `fn(arg)` in the page and return its (JSON) value; a thrown error becomes ours. */
async function inPage(tabId, fn, arg) {
  await ensureAttached(tabId);
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression: `(${fn.toString()})(${JSON.stringify(arg ?? null)})`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
}

function withTimeout(p, ms, why) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(why)), ms))]);
}

// ------------------------------------------------------------------ in-page helpers (run inside the page: self-contained)

/** Interactive elements get a ref ("e12") that click/type/select take. */
function pageSnapshot({ maxText }) {
  const S = (window.__spiridus ??= { byRef: new Map(), byEl: new WeakMap(), n: 0 });
  const vw = innerWidth, vh = innerHeight;
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=textbox],[role=combobox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
    // an ancestor's opacity: 0 or display: none hides it too (opacity isn't inherited)
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return r;
  };
  const nameOf = (el) => {
    const t = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    const lb = el.getAttribute("aria-labelledby");
    return t(
      el.getAttribute("aria-label") ||
        (lb && lb.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ")) ||
        (el.labels && el.labels[0]?.innerText) ||
        el.getAttribute("alt") ||
        el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        (el.type === "submit" || el.type === "button" ? el.value : ""),
    ).slice(0, 80);
  };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio" || ty === "range") return ty === "range" ? "slider" : ty;
      return ty === "search" ? "searchbox" : "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  const els = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (/^H[1-3]$/.test(el.tagName) || el.matches(INTERACTIVE)) els.push(el);
    }
  };
  walk(document);
  for (const el of els) {
    if (out.length >= 500) {
      out.push("… (more elements: scroll, or use selectors)");
      break;
    }
    const r = visible(el);
    if (!r) continue;
    // edges count as out: an off-canvas drawer (fixed, right: 0, translateX(100%)) starts exactly at x = vw
    const off = r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw ? " (offscreen)" : "";
    if (/^H[1-3]$/.test(el.tagName)) {
      out.push(`${"#".repeat(Number(el.tagName[1]))} ${el.innerText.replace(/\s+/g, " ").trim().slice(0, 100)}${off}`);
      continue;
    }
    let ref = S.byEl.get(el);
    if (!ref || S.byRef.get(ref) !== el) {
      ref = `e${++S.n}`;
      S.byEl.set(el, ref);
      S.byRef.set(ref, el);
    }
    const role = roleOf(el);
    const bits = [`[${ref}] ${role} "${nameOf(el).replace(/"/g, "'")}"`];
    if ("value" in el && role !== "button" && el.value) bits.push(`value="${String(el.value).slice(0, 60)}"`);
    if (el.checked) bits.push("checked");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") bits.push("disabled");
    if (el.getAttribute("aria-expanded")) bits.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.getAttribute("aria-selected") === "true") bits.push("selected");
    if (role === "link") bits.push(`→ ${el.getAttribute("href").slice(0, 80)}`);
    out.push(bits.join(" ") + off);
  }
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
  return {
    url: location.href,
    title: document.title,
    viewport: { width: vw, height: vh, scrollX, scrollY, scrollHeight: document.documentElement.scrollHeight },
    elements: out.join("\n"),
    text: text.length > maxText ? text.slice(0, maxText) + `… (${text.length} chars)` : text,
  };
}

/** Find the element a command means, scroll it into view, and say where its middle is (CSS px). */
function pageLocate({ ref, selector, text, nth }) {
  let el = null;
  if (ref) {
    el = window.__spiridus?.byRef.get(ref) ?? null;
    if (!el || !el.isConnected) throw new Error(`no element ${ref} any more: take a new snapshot`);
  } else if (selector) {
    const all = document.querySelectorAll(selector);
    el = all[nth ?? 0] ?? null;
    if (!el) throw new Error(`nothing matches ${selector}${nth ? ` (#${nth})` : ""}`);
  } else if (text) {
    const want = text.toLowerCase();
    const hits = [];
    for (const e of document.querySelectorAll("body *")) {
      if (!e.innerText || !e.innerText.toLowerCase().includes(want)) continue;
      // innermost match only
      if ([...e.children].some((c) => c.innerText?.toLowerCase().includes(want))) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) hits.push(e);
    }
    el = hits[nth ?? 0] ?? null;
    if (!el) throw new Error(`no visible element with the text "${text}"`);
    el = el.closest('a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],label,summary') ?? el;
  } else return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  // scrolling can't bring in what's fixed off-canvas (a closed drawer menu): a click there would hit nothing
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight)
    throw new Error(`that ${el.tagName.toLowerCase()} is outside the viewport even after scrolling (a closed menu or drawer?): open what holds it first`);
  const top = document.elementFromPoint(x, y);
  const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? top.tagName.toLowerCase() + (top.id ? `#${top.id}` : "") : null;
  const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 40);
  return { x, y, tag: el.tagName.toLowerCase(), label, covered };
}

// ------------------------------------------------------------------ input

const MOD = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
const KEYS = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Esc: [27, "Escape"], Backspace: [8, "Backspace"],
  Delete: [46, "Delete"], ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"], Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"],
  Space: [32, "Space", " "], " ": [32, "Space", " "], Insert: [45, "Insert"],
  F1: [112, "F1"], F2: [113, "F2"], F3: [114, "F3"], F4: [115, "F4"], F5: [116, "F5"], F6: [117, "F6"],
  F7: [118, "F7"], F8: [119, "F8"], F9: [120, "F9"], F10: [121, "F10"], F11: [122, "F11"], F12: [123, "F12"],
};

async function pressKey(tabId, combo) {
  const parts = String(combo).split("+");
  const name = parts.pop() || "+";
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MOD)) throw new Error(`unknown modifier ${m}`);
    modifiers |= MOD[m];
  }
  let def = KEYS[name];
  let key = name;
  if (!def) {
    if (name.length !== 1) throw new Error(`unknown key ${name}`);
    const up = name.toUpperCase();
    const code = /[A-Z]/.test(up) ? `Key${up}` : /\d/.test(name) ? `Digit${name}` : "";
    def = [up.charCodeAt(0), code, name];
  } else key = def[1] === "Space" ? " " : def[1];
  const [keyCode, code, text] = def;
  // With Ctrl/Alt/Meta held there's no text to insert (Ctrl+A selects, it doesn't type "a").
  const typed = modifiers & 7 ? undefined : text;
  const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: typed ? "keyDown" : "rawKeyDown", text: typed, unmodifiedText: typed });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

async function mouseAt(tabId, x, y, { button = "left", clickCount = 1, move = false } = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (move) return;
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
}

/** Where a command points: an element (ref/selector/text) or x, y in CSS px of the viewport. */
async function target(tabId, a) {
  if (a.ref || a.selector || a.text) return inPage(tabId, pageLocate, { ref: a.ref, selector: a.selector, text: a.text, nth: a.nth });
  if (typeof a.x === "number" && typeof a.y === "number") return { x: a.x, y: a.y };
  throw new Error("say where: ref, selector, text, or x and y");
}

function waitLoaded(tabId, ms = NAV_WAIT_MS) {
  return new Promise((resolve) => {
    const done = (loading) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loading);
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done(false);
    };
    const timer = setTimeout(() => done(true), ms);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ------------------------------------------------------------------ commands

async function defaultTab() {
  const { tabs } = await sharedTabs();
  if (tabs.length === 1) return tabs[0].id;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isShared(active.id)) return active.id;
  if (!tabs.length) throw new Error("no tab is shared with Spiridus: share one from the extension's popup, or open one");
  throw new Error(`${tabs.length} tabs are shared: say which (tabId)`);
}

// ------------------------------------------------------------------ the overlay (overlay.js)

/** What Spiridus is doing, shown in the tab: its cursor glides to `at` with a few words. */
function show(tabId, a, what, at) {
  const by = typeof a.by === "string" && a.by.trim() ? a.by.trim().slice(0, 40) : "Spiridus";
  chrome.tabs.sendMessage(tabId, { kind: "action", by, what, x: at?.x, y: at?.y }).catch(() => {});
}
/** A beat for the cursor to get there before the click, so the person sees where it lands. */
const glide = () => new Promise((r) => setTimeout(r, 300));
const what = (p) => (p.label ? `${p.tag} "${p.label}"` : p.tag ?? `${Math.round(p.x)}, ${Math.round(p.y)}`);

async function overlayState(tabId) {
  const s = await settings();
  const { bubble } = await chrome.storage.local.get("bubble");
  return {
    kind: "overlay-state",
    tabId,
    paired: !!s.token,
    connected: status === "connected",
    shared: isShared(tabId),
    bubble: bubble ?? "all",
    server: s.server ?? "",
  };
}
/** Tell the overlays (every tab's, or one's) what changed: pairing, connection, sharing, the bubble setting. */
async function pushOverlay(tabId) {
  const tabs = tabId ? [{ id: tabId }] : await chrome.tabs.query({});
  for (const t of tabs) chrome.tabs.sendMessage(t.id, await overlayState(t.id)).catch(() => {});
}

/** The chat bubble's calls to Spiridus, made here with the pairing token (the page never sees it). Only these. */
const EXT_API = new Set(["GET terminals", "GET screen", "POST talk", "POST key"]);
async function extApi({ method, path, query, body }) {
  if (!EXT_API.has(`${method} ${path}`)) throw new Error(`not allowed: ${method} ${path}`);
  const s = await settings();
  if (!s.token || !s.server) throw new Error("this browser isn't paired with Spiridus");
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const res = await fetch(`${s.server}/api/browsers/ext/${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function run(type, a) {
  await loaded;
  if (type === "tabs") return (await sharedTabs()).tabs.map(tabInfo);
  if (type === "open") {
    if (!/^https?:\/\//i.test(a.url ?? "")) throw new Error("open takes an http(s) url");
    const t = await chrome.tabs.create({ url: a.url, active: a.active !== false });
    await setShared(t.id, true, "opened");
    const loading = await waitLoaded(t.id);
    return { ...tabInfo(await chrome.tabs.get(t.id)), loading };
  }

  const tabId = Number(a.tabId) || (await defaultTab());
  if (!isShared(tabId)) throw new Error(`tab ${tabId} isn't shared with Spiridus`);

  switch (type) {
    case "close":
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    case "activate": {
      const t = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return tabInfo(t);
    }
    case "navigate": {
      if (!/^https?:\/\//i.test(a.url ?? "")) throw new Error("navigate takes an http(s) url");
      show(tabId, a, `going to ${new URL(a.url).host}`);
      await glide();
      await chrome.tabs.update(tabId, { url: a.url });
      const loading = await waitLoaded(tabId);
      return { ...tabInfo(await chrome.tabs.get(tabId)), loading };
    }
    case "reload":
    case "back":
    case "forward": {
      const p = waitLoaded(tabId);
      if (type === "reload") await chrome.tabs.reload(tabId);
      else if (type === "back") await chrome.tabs.goBack(tabId);
      else await chrome.tabs.goForward(tabId);
      const loading = await p;
      return { ...tabInfo(await chrome.tabs.get(tabId)), loading };
    }
    case "screenshot": {
      await ensureAttached(tabId);
      const format = a.format === "png" ? "png" : "jpeg";
      const m = await cdp(tabId, "Page.getLayoutMetrics");
      const vp = m.cssVisualViewport ?? m.layoutViewport;
      const params = { format, ...(format === "jpeg" ? { quality: Math.min(100, Math.max(10, Number(a.quality) || 70)) } : {}) };
      if (a.fullPage) {
        const size = m.cssContentSize ?? m.contentSize;
        Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, 16_000), scale: 1 } });
      }
      const shot = await withTimeout(
        cdp(tabId, "Page.captureScreenshot", params),
        10_000,
        "Chrome didn't paint the tab (it's probably in the background): activate it and try again",
      );
      return {
        dataUrl: `data:image/${format};base64,${shot.data}`,
        viewport: { width: vp.clientWidth, height: vp.clientHeight, scrollX: vp.pageX, scrollY: vp.pageY },
        fullPage: !!a.fullPage,
      };
    }
    case "snapshot":
      show(tabId, a, "reading the page");
      return inPage(tabId, pageSnapshot, { maxText: Math.min(Number(a.maxText) || 4000, MAX_TEXT * 5) });
    case "click":
    case "hover": {
      const p = await target(tabId, a);
      show(tabId, a, `${type === "hover" ? "pointing at" : a.clickCount > 1 ? "double-clicking" : "clicking"} ${what(p)}`, p);
      await glide();
      await mouseAt(tabId, p.x, p.y, { button: a.button ?? "left", clickCount: Number(a.clickCount) || 1, move: type === "hover" });
      return p;
    }
    case "type": {
      let p = null;
      if (a.ref || a.selector) p = await target(tabId, { ref: a.ref, selector: a.selector, nth: a.nth });
      const typed = String(a.text ?? "");
      show(tabId, a, `typing "${typed.length > 30 ? typed.slice(0, 30) + "…" : typed}"`, p);
      if (p) {
        await glide();
        await mouseAt(tabId, p.x, p.y);
      }
      else await ensureAttached(tabId);
      if (a.clear) {
        await inPage(tabId, () => {
          const el = document.activeElement;
          if (el && "value" in el) {
            el.select?.();
          } else if (el?.isContentEditable) {
            document.getSelection()?.selectAllChildren(el);
          }
        });
        await pressKey(tabId, "Backspace");
      }
      await cdp(tabId, "Input.insertText", { text: String(a.text ?? "") });
      if (a.submit) await pressKey(tabId, "Enter");
      return { typed: String(a.text ?? "").length, at: p };
    }
    case "key":
      await ensureAttached(tabId);
      show(tabId, a, `pressing ${a.key}`);
      for (const k of String(a.key).split(" ").filter(Boolean)) await pressKey(tabId, k);
      return { pressed: a.key };
    case "scroll": {
      await ensureAttached(tabId);
      const vp = await inPage(tabId, () => ({ w: innerWidth, h: innerHeight }));
      const x = typeof a.x === "number" ? a.x : vp.w / 2, y = typeof a.y === "number" ? a.y : vp.h / 2;
      show(tabId, a, `scrolling ${Number(a.dy ?? 400) < 0 ? "up" : "down"}`, { x, y });
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(a.dx) || 0, deltaY: Number(a.dy ?? 400) });
      await new Promise((r) => setTimeout(r, 150));
      return inPage(tabId, () => ({ scrollX, scrollY, scrollHeight: document.documentElement.scrollHeight }));
    }
    case "select": {
      const p = await target(tabId, a);
      show(tabId, a, `choosing "${a.value}"`, p);
      await glide();
      return inPage(
        tabId,
        ({ ref, selector, value }) => {
          const el = ref ? window.__spiridus?.byRef.get(ref) : document.querySelector(selector);
          if (!(el instanceof HTMLSelectElement)) throw new Error("that isn't a <select>");
          const opt = [...el.options].find((o) => o.value === value) ?? [...el.options].find((o) => o.label.trim().toLowerCase() === String(value).toLowerCase());
          if (!opt) throw new Error(`no option ${value}; there are: ${[...el.options].map((o) => o.label).join(", ")}`);
          el.value = opt.value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: opt.value, label: opt.label };
        },
        { ref: a.ref, selector: a.selector, value: a.value },
      );
    }
    case "eval": {
      await ensureAttached(tabId);
      show(tabId, a, "running a script");
      const r = await cdp(tabId, "Runtime.evaluate", { expression: String(a.expression ?? ""), returnByValue: true, awaitPromise: true, userGesture: true, replMode: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result?.value !== undefined ? r.result.value : (r.result?.description ?? r.result?.type);
    }
    case "html":
      return inPage(
        tabId,
        ({ selector, max }) => {
          const el = selector ? document.querySelector(selector) : document.documentElement;
          if (!el) throw new Error(`nothing matches ${selector}`);
          const h = el.outerHTML;
          return h.length > max ? h.slice(0, max) + `… (${h.length} chars)` : h;
        },
        { selector: a.selector, max: Math.min(Number(a.max) || MAX_TEXT, 2_000_000) },
      );
    case "text":
      return inPage(
        tabId,
        ({ max }) => {
          const t = document.body?.innerText ?? "";
          return t.length > max ? t.slice(0, max) + `… (${t.length} chars)` : t;
        },
        { max: Math.min(Number(a.max) || MAX_TEXT, 2_000_000) },
      );
    case "wait":
      return inPage(
        tabId,
        async ({ selector, text, timeoutMs }) => {
          const end = Date.now() + timeoutMs;
          const found = () => (selector ? !!document.querySelector(selector) : (document.body?.innerText ?? "").toLowerCase().includes(String(text).toLowerCase()));
          while (Date.now() < end) {
            if (found()) return { found: true };
            await new Promise((r) => setTimeout(r, 200));
          }
          return { found: false };
        },
        { selector: a.selector, text: a.text, timeoutMs: Math.min(Number(a.timeoutMs) || 10_000, 60_000) },
      );
    case "viewport":
      return inPage(tabId, () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio, url: location.href, title: document.title }));
    case "dialog":
      await ensureAttached(tabId);
      await cdp(tabId, "Page.handleJavaScriptDialog", { accept: a.accept !== false, ...(a.promptText != null ? { promptText: String(a.promptText) } : {}) });
      return { handled: true };
    case "cdp":
      await ensureAttached(tabId);
      if (typeof a.method !== "string") throw new Error("cdp takes a method, e.g. Network.getCookies");
      show(tabId, a, a.method);
      return cdp(tabId, a.method, a.params ?? {});
    case "subscribe": {
      await ensureAttached(tabId);
      const set = new Set(Array.isArray(a.methods) ? a.methods.map(String) : []);
      if (set.size) subscriptions.set(tabId, set);
      else subscriptions.delete(tabId);
      return { forwarding: [...set] };
    }
  }
  throw new Error(`unknown command ${type}`);
}

// ------------------------------------------------------------------ the popup

const FROM_PAGES = new Set(["overlay-hello", "ext-api"]);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    await loaded;
    if (sender.id !== chrome.runtime.id) return { ok: false, error: "not ours" };
    // The overlay (a content script, so in a tab) only gets its own state and the chat calls; the rest is the popup's.
    if (sender.tab && !FROM_PAGES.has(msg.kind)) return { ok: false, error: "not from a page" };
    switch (msg.kind) {
      case "overlay-hello":
        return overlayState(sender.tab.id);
      case "ext-api":
        return extApi(msg).then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: e?.message ?? String(e) }));
      case "bubble":
        await chrome.storage.local.set({ bubble: ["all", "shared", "off"].includes(msg.mode) ? msg.mode : "all" });
        await pushOverlay();
        return { ok: true };
      case "state": {
        const s = await settings();
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const { tabs } = await sharedTabs();
        return {
          server: s.server ?? DEFAULT_SERVER,
          paired: !!s.token,
          name: s.name ?? "",
          status,
          error: lastError,
          shareAll,
          bubble: (await chrome.storage.local.get("bubble")).bubble ?? "all",
          tab: tab ? { ...tabInfo(tab), shared: isShared(tab.id), restricted: RESTRICTED.test(tab.url ?? "") } : null,
          shared: shareAll ? [] : tabs.map(tabInfo),
        };
      }
      case "pair":
        return pair(msg.server, msg.code, msg.name);
      case "unpair":
        await unpair();
        return { ok: true };
      case "reconnect":
        backoff = 1000;
        await connect();
        return { ok: true };
      case "share":
        await setShared(msg.tabId, !!msg.on);
        return { ok: true };
      case "shareAll":
        await setShareAll(!!msg.on);
        return { ok: true };
    }
    return { error: "unknown" };
  })().then(reply, (e) => reply({ ok: false, error: e?.message ?? String(e) }));
  return true;
});
