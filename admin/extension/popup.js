const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);
let formFilled = false;

function text(el, s) {
  el.textContent = s;
}

async function render() {
  const s = await ask({ kind: "state" });
  $("dot").className = `dot ${s.status}`;
  const err = s.error && s.status !== "connected" ? s.error : "";
  $("error").classList.toggle("hidden", !err);
  text($("error"), err);
  $("pairForm").classList.toggle("hidden", s.paired);
  $("paired").classList.toggle("hidden", !s.paired);

  if (!s.paired) {
    text($("statusLine"), "Not paired with a Spiridus yet.");
    if (!formFilled) {
      $("server").value = s.server ?? "";
      formFilled = true;
    }
    return;
  }

  const host = (() => {
    try {
      return new URL(s.server).host;
    } catch {
      return s.server;
    }
  })();
  text($("statusLine"), `${s.name || "This browser"} · ${s.status === "connected" ? "connected to" : s.status + ","} ${host}`);

  const t = s.tab;
  $("thisTab").classList.toggle("hidden", !t);
  if (t) {
    text($("tabTitle"), t.title || t.url);
    const btn = $("shareBtn");
    btn.disabled = t.restricted || s.shareAll;
    btn.className = t.shared ? "" : "primary";
    text(btn, t.shared ? "Stop sharing this tab" : "Share this tab with Spiridus");
    btn.onclick = async () => {
      await ask({ kind: "share", tabId: t.id, on: !t.shared });
      render();
    };
    text(
      $("tabNote"),
      t.restricted ? "Chrome doesn't let extensions control this page." : s.shareAll ? "Every tab is shared." : t.opened ? "Spiridus opened this tab." : "",
    );
  }

  $("shareAll").checked = s.shareAll;
  if (document.activeElement !== $("bubble")) $("bubble").value = s.bubble ?? "all";
  const list = $("sharedList");
  list.replaceChildren();
  for (const tab of s.shared) {
    const row = document.createElement("div");
    row.className = "tab";
    const name = document.createElement("span");
    name.textContent = tab.title || tab.url;
    name.title = tab.url;
    const stop = document.createElement("button");
    stop.textContent = "Stop";
    stop.onclick = async () => {
      await ask({ kind: "share", tabId: tab.id, on: false });
      render();
    };
    row.append(name, stop);
    list.append(row);
  }
}

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pairBtn").disabled = true;
  text($("pairBtn"), "Pairing…");
  const r = await ask({ kind: "pair", server: $("server").value, code: $("code").value, name: $("name").value.trim() || "Chrome" });
  $("pairBtn").disabled = false;
  text($("pairBtn"), "Pair");
  if (!r.ok) {
    $("error").classList.remove("hidden");
    text($("error"), r.error);
  }
  render();
});
$("shareAll").addEventListener("change", async (e) => {
  if (e.target.checked && !confirm("Let Spiridus see and control every tab in this browser?")) {
    e.target.checked = false;
    return;
  }
  await ask({ kind: "shareAll", on: e.target.checked });
  render();
});
$("bubble").addEventListener("change", (e) => ask({ kind: "bubble", mode: e.target.value }));
$("unpair").addEventListener("click", async () => {
  await ask({ kind: "unpair" });
  formFilled = false;
  render();
});
$("reconnect").addEventListener("click", async () => {
  await ask({ kind: "reconnect" });
  setTimeout(render, 800);
});

render();
setInterval(render, 1500);
