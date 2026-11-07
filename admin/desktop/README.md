# Spiridus Desktop

A small app (Tauri 2, Rust) that lets Spiridus and its agents see and drive a whole computer, as the
Spiridus Bridge extension (`../extension`) does a Chrome tab. macOS and Windows (Linux/X11 works too).

- **Pairing**: the same one-time codes as the extension (Spiridus → Browsers → Pair a browser or computer).
  The app connects to `<spiridus>/browser-ws` (`../server/browser-bridge.mjs`) with `kind: "desktop"`,
  keeps the token in its config dir (`config.json`, mode 600), reconnects by itself and starts at login.
- **Commands** (`src-tauri/src/actions.rs`): screenshots per display, mouse and keyboard (enigo), the front
  window's UI elements (macOS Accessibility via JXA, Windows UI Automation via PowerShell), apps, clipboard,
  shell commands, files. Coordinates are a display's logical points from its top-left corner.
- **On screen**: a click-through overlay per display (`ui/overlay.html`): "Spiridus can control this computer"
  while connected, and the actor's cursor, a line and a glow when it acts. The tray/menu bar icon shows the
  state and pauses it; Settings switches off input, commands or files; the chat window talks to Spiridus's
  terminals (the extension's `/api/browsers/ext/*` routes, with the pairing token).

## Build

```sh
cd src-tauri
cargo build                       # a debug build for this OS
npx @tauri-apps/cli@2 build       # an installer (dmg / nsis)
```

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev
libxcb1-dev libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libegl-dev libgbm-dev libclang-dev`.
CI (`.github/workflows/desktop.yml`) builds macOS (arm64, x64) and Windows on every change here and
attaches them to the `desktop-latest` pre-release that the Browsers page links to.

## Unsigned test builds

- **macOS**: ad-hoc signed only. The first time: right-click → Open (or System Settings → Privacy & Security
  → Open Anyway). Then allow **Screen Recording** and **Accessibility** for it and reopen it. Each new build is a
  new app to macOS: allow both again after updating.
- **Windows**: SmartScreen → More info → Run anyway. It can't drive windows of programs running as
  administrator, UAC prompts or the lock screen.
- Nothing works at the login or lock screen: someone has to be logged in.
