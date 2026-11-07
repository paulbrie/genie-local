import { WISP } from "./wisp.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
$("logo").innerHTML = WISP;
let filled = false;

const PERMS = {
  macOS: "macOS asks once for each: <b>Screen Recording</b> (to see the screen) and <b>Accessibility</b> (to click, type and read the UI), in System Settings → Privacy &amp; Security. Switch Spiridus Desktop on in both, then quit and reopen it.",
  Windows: "Windows needs nothing more. It can't control windows of programs running as administrator, nor UAC prompts or the lock screen.",
  Linux: "On Linux it works under X11; reading the UI isn't supported yet.",
};

function render(s) {
  $("dot").className = `dot ${s.status}`;
  const host = (() => { try { return new URL(s.server).host; } catch { return s.server; } })();
  $("status").textContent = !s.paired
    ? "Not paired yet"
    : s.status === "connected"
      ? `${s.paused ? "Paused" : "Connected"} to ${host} as "${s.name}"`
      : s.status === "connecting" ? `Connecting to ${host}…` : `Offline (${host})`;
  $("error").textContent = s.error && s.status !== "connected" ? s.error : "";
  $("error").classList.toggle("hidden", !(s.error && s.status !== "connected"));
  $("pairForm").classList.toggle("hidden", s.paired);
  $("paired").classList.toggle("hidden", !s.paired);
  if (!filled) {
    $("server").value = s.server || "";
    $("name").value = s.name || s.hostname || "";
    filled = true;
  }
  $("allowInput").checked = s.allow.input;
  $("allowShell").checked = s.allow.shell;
  $("allowFiles").checked = s.allow.files;
  $("paused").checked = s.paused;
  $("user").textContent = s.user || "you";
  const os = s.os.split(" ")[0];
  $("permsText").innerHTML = PERMS[os] ?? "";
  $("trayWord").textContent = os === "macOS" ? "menu bar" : "system tray";
}

const refresh = async () => render(await invoke("get_state"));
listen("bridge-state", (e) => render(e.payload));
refresh();

$("pairForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pairBtn").disabled = true;
  $("pairBtn").textContent = "Pairing…";
  try {
    await invoke("pair", { server: $("server").value, code: $("code").value, name: $("name").value });
    $("code").value = "";
  } catch (err) {
    $("error").textContent = String(err);
    $("error").classList.remove("hidden");
  } finally {
    $("pairBtn").disabled = false;
    $("pairBtn").textContent = "Pair";
  }
});
const allow = () => invoke("set_allow", { input: $("allowInput").checked, shell: $("allowShell").checked, files: $("allowFiles").checked });
for (const id of ["allowInput", "allowShell", "allowFiles"]) $(id).addEventListener("change", allow);
$("paused").addEventListener("change", () => invoke("set_paused", { paused: $("paused").checked }));
$("reconnect").addEventListener("click", () => invoke("reconnect"));
$("chat").addEventListener("click", () => invoke("show_chat"));
$("unpair").addEventListener("click", async () => {
  if (!confirm("Unpair this computer? Spiridus won't see or control it until it's paired again.")) return;
  await invoke("unpair");
  filled = false;
  refresh();
});
