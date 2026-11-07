/**
 * Spiridus Bridge, in the page (a content script on every http(s) page; the background is background.js).
 *
 * Two things, drawn in a closed shadow root so the page can neither style nor read them:
 *  - In a tab shared with Spiridus, what Spiridus does there: its cursor gliding to where it clicks, types or scrolls,
 *    with who it is and what it does; a line at the bottom with the last thing it did; a glow round the window and a
 *    badge while it is at work.
 *  - While this browser is paired, a chat bubble: talk to any of Spiridus's terminals (what you write is typed into it
 *    and submitted; its screen shows live under it), answer what Claude asks there, or start a new talk (a new Claude
 *    terminal, in a project if you pick one). "Include this page" tells the terminal which tab you said it from, so its
 *    agent can work in it with the browsers MCP tools.
 *
 * Everything the bubble does goes through the background (which holds the pairing token) and only on real input:
 * events the page makes up (`isTrusted` false) are ignored, so a page can't talk to your terminals.
 */
(() => {
  if (window.top !== window) return;
  // Once per page, but an update or reload of the extension leaves the old copy dead (its chrome.runtime gone):
  // that one makes way for this one.
  const prev = window.__spiridusOverlay;
  if (prev?.alive()) return;
  for (const old of document.querySelectorAll("spiridus-bridge")) old.remove();
  window.__spiridusOverlay = {
    alive: () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
  };

  const ask = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e?.message ?? String(e) }));
  const api = async (method, path, opts = {}) => {
    const r = await ask({ kind: "ext-api", method, path, ...opts });
    if (!r?.ok) throw new Error(r?.error ?? "Spiridus didn't answer");
    return r.data;
  };

  const WISP =
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M16 28.5c-4.4 0-8-3.4-8-7.8 0-5.6 4.6-8.6 8.4-12.4 1.6-1.6 2.4-3.4 2.2-5.3 3.8 1.6 5.4 5.6 5.4 10.2v7.5c0 4.4-3.6 7.8-8 7.8Z"/><ellipse fill="var(--bg)" cx="13.4" cy="19.5" rx="1.7" ry="2.3"/><ellipse fill="var(--bg)" cx="18.8" cy="19.5" rx="1.7" ry="2.3"/></svg>';
  const STATUS = {
    "claude-working": ["working…", "#f59e0b"],
    "claude-background": ["working in the background", "#f59e0b"],
    "claude-input": ["waiting for you", "#ef4444"],
    "claude-idle": ["ready", "#10b981"],
    busy: ["running a command", "#f59e0b"],
    idle: ["at a shell prompt", "#a1a1aa"],
  };

  const host = document.createElement("spiridus-bridge");
  host.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
<style>
  :host { --bg: #ffffff; --fg: #0a0a0a; --muted: #71717a; --line: #e4e4e7; --soft: #f4f4f5; --accent: #7c3aed; }
  @media (prefers-color-scheme: dark) { :host { --bg: #18181b; --fg: #fafafa; --muted: #a1a1aa; --line: #3f3f46; --soft: #27272a; } }
  * { box-sizing: border-box; font: 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .hidden { display: none !important; }
  .glow { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 3px var(--accent), inset 0 0 28px rgba(124, 58, 237, 0.35); opacity: 0; transition: opacity 0.4s; }
  .glow.on { opacity: 1; }
  .cursor { position: fixed; left: 0; top: 0; pointer-events: none; transition: transform 0.28s ease-out, opacity 0.4s; opacity: 0; will-change: transform; }
  .cursor.on { opacity: 1; }
  .cursor svg { width: 22px; height: 22px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); }
  .cursor .tag { position: absolute; left: 18px; top: 16px; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; padding: 2px 8px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 600; }
  .ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 2px solid var(--accent); pointer-events: none; animation: ripple 0.6s ease-out forwards; }
  @keyframes ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
  .trace { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); max-width: 70vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 5px 12px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,.25); opacity: 0; transition: opacity 0.3s; pointer-events: none; }
  .trace.on { opacity: 1; }
  .badge { position: fixed; left: 14px; bottom: 14px; display: flex; align-items: center; gap: 6px; padding: 4px 10px 4px 6px; border-radius: 999px; background: var(--bg); color: var(--fg); border: 1px solid var(--accent); box-shadow: 0 2px 10px rgba(0,0,0,.18); font-size: 12px; pointer-events: none; }
  .badge svg { width: 16px; height: 16px; color: var(--accent); }
  .badge.idle { border-color: var(--line); color: var(--muted); }
  .badge.idle svg { color: var(--muted); }

  .bubble { position: fixed; right: 18px; bottom: 18px; width: 48px; height: 48px; border-radius: 50%; border: 0; background: #0a0a0a; color: #fff; --bg: #0a0a0a; cursor: pointer; pointer-events: auto; box-shadow: 0 6px 20px rgba(0,0,0,.3); display: grid; place-items: center; transition: transform .15s; }
  .bubble:hover { transform: scale(1.06); }
  .bubble svg { width: 26px; height: 26px; }

  .panel { position: fixed; right: 18px; bottom: 76px; width: 400px; max-width: calc(100vw - 36px); height: 560px; max-height: calc(100vh - 100px); display: flex; flex-direction: column; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.28); pointer-events: auto; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 12px; border-bottom: 1px solid var(--line); }
  .head svg { width: 18px; height: 18px; flex: none; }
  select, input, textarea { width: 100%; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; outline: none; }
  select:focus, input:focus, textarea:focus { border-color: var(--accent); }
  .head select { flex: 1; min-width: 0; }
  button.x { flex: none; width: 28px; height: 28px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; }
  button.x:hover { background: var(--soft); color: var(--fg); }
  .status { display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); }
  .status i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .screen { flex: 1; overflow: auto; margin: 0; padding: 10px 12px; background: var(--soft); font: 11.5px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
  .new { flex: 1; display: flex; flex-direction: column; gap: 8px; padding: 12px; overflow: auto; }
  .new label { font-size: 12px; color: var(--muted); }
  .keys { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
  .keys button, .send { border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 4px 9px; cursor: pointer; font-size: 12px; }
  .keys button:hover { background: var(--soft); }
  .keys button.choice { border-color: var(--accent); }
  .compose { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--line); margin-top: 8px; }
  .compose textarea { resize: none; height: 64px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .row label { flex: 1; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; }
  .row input[type="checkbox"] { width: auto; margin: 0; }
  .send { background: #0a0a0a; color: #fff; border-color: #0a0a0a; padding: 6px 14px; font-weight: 600; }
  .send:disabled { opacity: .5; cursor: default; }
  .note { font-size: 12px; color: var(--muted); }
  .err { font-size: 12px; color: #ef4444; }
</style>
<div class="glow"></div>
<div class="cursor"><svg viewBox="0 0 20 20"><path d="M2 2 L17 9 L10 11 L8 18 Z" fill="#7c3aed" stroke="white" stroke-width="1.5"/></svg><span class="tag"></span></div>
<div class="trace"></div>
<div class="badge hidden">${WISP}<span></span></div>
<button class="bubble hidden" title="Talk to Spiridus">${WISP}</button>
<div class="panel hidden" role="dialog" aria-label="Talk to Spiridus">
  <div class="head">${WISP}<select class="pick"></select><button class="x refresh" title="Refresh the list">↻</button><button class="x close" title="Close">×</button></div>
  <div class="status hidden"><i></i><span></span></div>
  <pre class="screen hidden"></pre>
  <div class="new hidden">
    <label>Project (the new terminal starts in it)<select class="project"></select></label>
    <label>Name (optional)<input class="name" placeholder="talk-…" maxlength="64"></label>
    <div class="note">A new Claude starts in its own terminal with what you write below as its first message. It shows in Spiridus's Terminals like the others.</div>
  </div>
  <div class="keys hidden"></div>
  <div class="compose">
    <textarea class="text" placeholder="Write to the terminal… (Enter sends, Shift+Enter for a new line)"></textarea>
    <div class="row"><label><input type="checkbox" class="withPage" checked> Include this page</label><button class="send">Send</button></div>
    <div class="err hidden"></div>
  </div>
</div>`;
  const $ = (sel) => root.querySelector(sel);
  const el = {
    glow: $(".glow"), cursor: $(".cursor"), tag: $(".cursor .tag"), trace: $(".trace"), badge: $(".badge"), badgeText: $(".badge span"),
    bubble: $(".bubble"), panel: $(".panel"), pick: $(".pick"), status: $(".status"), statusDot: $(".status i"),
    statusText: $(".status span"), screen: $(".screen"), fresh: $(".new"), project: $(".project"), name: $(".name"),
    keys: $(".keys"), text: $(".text"), withPage: $(".withPage"), send: $(".send"), err: $(".err"),
  };
  (document.documentElement || document.body).appendChild(host);
  // Keys typed in the panel are ours, not the page's shortcuts.
  for (const t of ["keydown", "keyup", "keypress"]) host.addEventListener(t, (e) => e.stopPropagation());

  // ---------------------------------------------------------------- state from the background

  let state = { paired: false, connected: false, shared: false, bubble: "all", server: "" };
  function applyState(s) {
    state = { ...state, ...s };
    const onSpiridus = state.server && location.href.startsWith(state.server);
    const showBubble = state.paired && !onSpiridus && (state.bubble === "all" || (state.bubble === "shared" && state.shared));
    el.bubble.classList.toggle("hidden", !showBubble);
    if (!showBubble) el.panel.classList.add("hidden");
    renderBadge();
  }
  ask({ kind: "overlay-hello" }).then((s) => s && s.kind === "overlay-state" && applyState(s));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ask({ kind: "overlay-hello" }).then((s) => s && s.kind === "overlay-state" && applyState(s));
  });

  // ---------------------------------------------------------------- what Spiridus does here

  let lastAction = 0, actor = "Spiridus", traceTimer, workTimer;
  function renderBadge() {
    const working = Date.now() - lastAction < 6000;
    const show = state.shared && state.connected;
    el.badge.classList.toggle("hidden", !show);
    el.badge.classList.toggle("idle", !working);
    el.badgeText.textContent = working ? `${actor} is working here` : "Shared with Spiridus";
    el.glow.classList.toggle("on", show && working);
    if (!working) el.cursor.classList.remove("on");
  }
  function onAction(m) {
    lastAction = Date.now();
    actor = m.by || "Spiridus";
    el.tag.textContent = `${actor} · ${m.what}`;
    if (typeof m.x === "number" && typeof m.y === "number") {
      el.cursor.style.transform = `translate(${m.x - 2}px, ${m.y - 2}px)`;
      el.cursor.classList.add("on");
      if (/^(clicking|double-clicking|choosing)/.test(m.what)) {
        setTimeout(() => {
          const r = document.createElement("div");
          r.className = "ripple";
          r.style.left = `${m.x}px`;
          r.style.top = `${m.y}px`;
          root.appendChild(r);
          setTimeout(() => r.remove(), 700);
        }, 300);
      }
    }
    el.trace.textContent = `${actor} · ${m.what}`;
    el.trace.classList.add("on");
    clearTimeout(traceTimer);
    traceTimer = setTimeout(() => el.trace.classList.remove("on"), 3000);
    renderBadge();
    clearTimeout(workTimer);
    workTimer = setTimeout(renderBadge, 6100);
  }

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m?.kind === "overlay-ping") reply({ ok: true });
    else if (m?.kind === "overlay-state") applyState(m);
    else if (m?.kind === "action") onAction(m);
  });

  // ---------------------------------------------------------------- the chat bubble

  const NEW = "__new__";
  let terminals = [], projects = [], current = null, pollTimer = null;

  const real = (fn) => (e) => {
    if (!e.isTrusted) return;
    fn(e);
  };
  const setErr = (msg) => {
    el.err.textContent = msg || "";
    el.err.classList.toggle("hidden", !msg);
  };

  async function loadTerminals() {
    try {
      const r = await api("GET", "terminals");
      terminals = r.terminals.filter((t) => !t.dead).sort((a, b) => b.createdAt - a.createdAt);
      projects = r.projects;
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
    const keep = current;
    el.pick.replaceChildren();
    el.pick.append(new Option("＋ New talk", NEW));
    for (const t of terminals) {
      const label = `${t.name}${t.project && t.project !== t.name ? ` · ${t.project}` : ""} · ${(STATUS[t.status] ?? [t.status])[0]}`;
      el.pick.append(new Option(label, t.name));
    }
    el.project.replaceChildren(new Option("(none)", ""), ...projects.map((p) => new Option(p, p)));
    const page = (location.hostname.split(".").slice(-2, -1)[0] || "").toLowerCase();
    const guess = projects.find((p) => p.toLowerCase() === page);
    if (guess) el.project.value = guess;
    const stored = (await chrome.storage.local.get("talkTerminal")).talkTerminal;
    select(keep && terminals.some((t) => t.name === keep) ? keep : stored && terminals.some((t) => t.name === stored) ? stored : terminals.length ? terminals[0].name : NEW);
  }

  function select(name) {
    current = name === NEW ? null : name;
    el.pick.value = name;
    chrome.storage.local.set({ talkTerminal: current });
    const fresh = !current;
    el.fresh.classList.toggle("hidden", !fresh);
    el.screen.classList.toggle("hidden", fresh);
    el.status.classList.toggle("hidden", fresh);
    el.keys.classList.add("hidden");
    el.text.placeholder = fresh ? "What should the new Claude do? (Enter starts it)" : `Write to ${name}… (Enter sends, Shift+Enter for a new line)`;
    el.send.textContent = fresh ? "Start" : "Send";
    el.screen.textContent = "";
    poll(true);
  }

  async function poll(scrollDown) {
    clearTimeout(pollTimer);
    if (el.panel.classList.contains("hidden") || !current) return;
    try {
      const r = await api("GET", "screen", { query: { terminal: current } });
      if (r.name !== current) return;
      const atBottom = el.screen.scrollHeight - el.screen.scrollTop - el.screen.clientHeight < 40;
      if (el.screen.textContent !== r.text) {
        el.screen.textContent = r.text || "(nothing on the screen yet)";
        if (scrollDown || atBottom) el.screen.scrollTop = el.screen.scrollHeight;
      }
      const [label, color] = STATUS[r.status] ?? [r.status, "#a1a1aa"];
      el.statusDot.style.background = color;
      el.statusText.textContent = `${current} · ${label}`;
      renderKeys(r);
      setErr("");
    } catch (e) {
      setErr(e.message);
    }
    if (document.visibilityState === "visible") pollTimer = setTimeout(() => poll(false), 2000);
  }

  function renderKeys(r) {
    el.keys.replaceChildren();
    const waiting = r.status === "claude-input";
    for (const c of r.choices ?? []) {
      const b = document.createElement("button");
      b.className = "choice";
      b.textContent = `${c.n}. ${c.label.length > 40 ? c.label.slice(0, 40) + "…" : c.label}`;
      b.addEventListener("click", real(() => key(String(c.n))));
      el.keys.append(b);
    }
    for (const [label, k] of waiting ? [["Enter", "Enter"], ["Esc", "Escape"], ["↑", "Up"], ["↓", "Down"]] : [["Esc", "Escape"], ["Ctrl+C", "C-c"]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = `Press ${label} in ${current}`;
      b.addEventListener("click", real(() => key(k)));
      el.keys.append(b);
    }
    el.keys.classList.remove("hidden");
  }

  async function key(k) {
    if (!current) return;
    try {
      await api("POST", "key", { body: { terminal: current, key: k } });
      setTimeout(() => poll(true), 400);
    } catch (e) {
      setErr(e.message);
    }
  }

  async function send() {
    const text = el.text.value.trim();
    if (!text) return;
    el.send.disabled = true;
    setErr("");
    const page = el.withPage.checked ? { url: location.href, title: document.title, tabId: state.tabId } : undefined;
    try {
      const body = current ? { terminal: current, text, page } : { text, page, ...(el.project.value ? { project: el.project.value } : {}), ...(el.name.value.trim() ? { name: el.name.value.trim() } : {}) };
      const r = await api("POST", "talk", { body });
      el.text.value = "";
      el.name.value = "";
      if (r.started) {
        await loadTerminals();
        select(r.terminal);
      } else setTimeout(() => poll(true), 500);
    } catch (e) {
      setErr(e.message);
    } finally {
      el.send.disabled = false;
    }
  }

  function toggle(open) {
    el.panel.classList.toggle("hidden", !open);
    if (open) {
      loadTerminals();
      setTimeout(() => el.text.focus(), 50);
    } else clearTimeout(pollTimer);
  }

  el.bubble.addEventListener("click", real(() => toggle(el.panel.classList.contains("hidden"))));
  $(".close").addEventListener("click", real(() => toggle(false)));
  $(".refresh").addEventListener("click", real(() => loadTerminals()));
  el.pick.addEventListener("change", real(() => select(el.pick.value)));
  el.send.addEventListener("click", real(() => send()));
  el.text.addEventListener(
    "keydown",
    real((e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") toggle(false);
    }),
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll(false);
  });
})();
