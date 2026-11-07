// Talk to Spiridus's terminals from this computer: the same as the Chrome extension's chat bubble (its routes,
// /api/browsers/ext/…), through the app (ext_api in lib.rs), which holds the pairing token.
import { WISP } from "./wisp.js";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
$("logo").innerHTML = WISP;
const NEW = "__new__";
const STATUS = {
  "claude-working": ["working…", "#f59e0b"], "claude-background": ["working in the background", "#f59e0b"],
  "claude-input": ["waiting for you", "#ef4444"], "claude-idle": ["ready", "#10b981"],
  busy: ["running a command", "#f59e0b"], idle: ["at a shell prompt", "#a1a1aa"],
};
let current = null, timer = null;
const api = (method, path, opts = {}) => invoke("ext_api", { method, path, query: opts.query ?? null, body: opts.body ?? null });
const err = (m) => { $("err").textContent = m || ""; $("err").classList.toggle("hidden", !m); };

async function load() {
  let r;
  try { r = await api("GET", "terminals"); err(""); } catch (e) { err(String(e)); return; }
  const terms = r.terminals.filter((t) => !t.dead).sort((a, b) => b.createdAt - a.createdAt);
  $("pick").replaceChildren(new Option("＋ New talk", NEW), ...terms.map((t) => new Option(`${t.name}${t.project && t.project !== t.name ? ` · ${t.project}` : ""} · ${(STATUS[t.status] ?? [t.status])[0]}`, t.name)));
  $("project").replaceChildren(new Option("(none)", ""), ...r.projects.map((p) => new Option(p, p)));
  const keep = current ?? localStorage.getItem("talkTerminal");
  select(keep && terms.some((t) => t.name === keep) ? keep : terms[0]?.name ?? NEW);
}

function select(name) {
  current = name === NEW ? null : name;
  $("pick").value = name;
  if (current) localStorage.setItem("talkTerminal", current);
  for (const id of ["screen", "status"]) $(id).classList.toggle("hidden", !current);
  $("fresh").classList.toggle("hidden", !!current);
  $("keys").classList.add("hidden");
  $("screen").textContent = "";
  $("send").textContent = current ? "Send" : "Start";
  $("text").placeholder = current ? `Write to ${name}… (Enter sends, Shift+Enter for a new line)` : "What should the new Claude do? (Enter starts it)";
  poll(true);
}

async function poll(down) {
  clearTimeout(timer);
  if (!current) return;
  try {
    const r = await api("GET", "screen", { query: { terminal: current } });
    if (r.name !== current) return;
    const s = $("screen"), atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
    if (s.textContent !== r.text) { s.textContent = r.text || "(nothing yet)"; if (down || atBottom) s.scrollTop = s.scrollHeight; }
    const [label, color] = STATUS[r.status] ?? [r.status, "#a1a1aa"];
    $("status").querySelector("i").style.background = color;
    $("status").querySelector("span").textContent = `${current} · ${label}`;
    const keys = $("keys");
    keys.replaceChildren();
    for (const c of r.choices ?? []) keys.append(button(`${c.n}. ${c.label.slice(0, 40)}`, String(c.n), "choice"));
    for (const [l, k] of r.status === "claude-input" ? [["Enter", "Enter"], ["Esc", "Escape"], ["↑", "Up"], ["↓", "Down"]] : [["Esc", "Escape"], ["Ctrl+C", "C-c"]]) keys.append(button(l, k));
    keys.classList.remove("hidden");
    err("");
  } catch (e) { err(String(e)); }
  if (!document.hidden) timer = setTimeout(() => poll(false), 2000);
}

function button(label, key, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.onclick = async () => {
    try { await api("POST", "key", { body: { terminal: current, key } }); setTimeout(() => poll(true), 400); } catch (e) { err(String(e)); }
  };
  return b;
}

async function send() {
  const text = $("text").value.trim();
  if (!text) return;
  $("send").disabled = true;
  const computer = $("withComputer").checked;
  try {
    const body = current ? { terminal: current, text, computer } : { text, computer, ...($("project").value ? { project: $("project").value } : {}), ...($("tname").value.trim() ? { name: $("tname").value.trim() } : {}) };
    const r = await api("POST", "talk", { body });
    $("text").value = "";
    $("tname").value = "";
    if (r.started) { current = r.terminal; await load(); } else setTimeout(() => poll(true), 500);
  } catch (e) { err(String(e)); } finally { $("send").disabled = false; }
}

$("pick").onchange = () => select($("pick").value);
$("refresh").onclick = load;
$("send").onclick = send;
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(false); });
load();
