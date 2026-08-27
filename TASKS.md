- [ ] I need a way in which I can paste clipboard data into the terminal
- [ ] The orange dot showing terminal activity can be hardly distinguished between its ideal and active state. Ideally we would use Claude CLI logo animation
- [ ] check the Agents capability and suggest missing features or improvemebts in AGENTS-IMPROVEMENTS.md as a task list
- [ ] I would like to keep in a text log file the server stats (CPU, MEM, DISK) even when the UI is not calling (should ve croned)? In the top bar add a historical graph (d, 7d, 30d) of the server activity
- [ ] For each Claude terminal I'd like to see the in/out tokens

## Deploy & security backlog (install review, 2026-08-27)

Findings from an end-to-end review of `deploy/install.sh` and the provisioning
flow, done together with the Genie manager's `genie-local` recipe (which now
upgrades in place, health-checks, and passes `INSTALL_CODE_SERVER=0`). Ordered
by priority; section numbers refer to install.sh.

### P0 — bugs

- [ ] **Re-running install.sh breaks DB auth.** §7 generates a fresh
      `DB_PASSWORD` on every run and `ALTER ROLE`s the live role, while §8
      leaves an existing `admin/.env.local` untouched — a re-run desyncs the
      role password from `DATABASE_URL`: migrations fail and the running
      dashboard loses Postgres. Fix: when `admin/.env.local` exists, parse the
      password out of its `DATABASE_URL` and reuse it instead of generating.
- [ ] **`db:migrate` failure is only a warning.** §10 warns and continues, and
      the installer still prints "Setup complete". Make it fatal (or retry
      once) so a broken schema can't masquerade as a good install.
- [ ] **No end-of-install verification.** §14 prints verify commands but never
      runs them. Run them: wait for `admin.service` active, curl
      `127.0.0.1:3000/admin/login` expecting 200, exit non-zero on failure.
      (The manager recipe checks this externally; install.sh shouldn't depend
      on that.)

### P1 — security

- [ ] **Bind the admin app to loopback.** `admin.service` runs
      `next dev -H 0.0.0.0 -p 3001` but nginx proxies to `127.0.0.1:3001` —
      `-H 127.0.0.1` loses nothing and stops raw-VM installs from exposing the
      dev server (verbose errors, spoofable `X-Forwarded-Proto`) directly.
- [ ] **Own the genie user's sudo.** §3 creates `genie` with
      `--disabled-password` + `sudo` group, which cannot actually sudo (no
      password to type). It only works when Genie Standard Setup's NOPASSWD
      drop-in already exists. Write `/etc/sudoers.d/genie`
      (`genie ALL=(ALL) NOPASSWD:ALL`, chmod 440) in install.sh so the box
      doesn't depend on recipe ordering.
- [ ] **Firewall + TLS baseline for raw VMs.** nginx serves plain HTTP :3000
      and hardcodes `X-Forwarded-Proto https` — fine behind the teleporthq TLS
      front, unsafe on an arbitrary VM (admin_session cookie in cleartext).
      Add a UFW section (default deny incoming; allow 22, 3000) and either an
      optional Caddy/certbot TLS mode or a loud README note stating the TLS
      assumption.

### P2 — reproducibility & operations

- [ ] **Pin what gets installed.** The clone takes the default branch @HEAD,
      and code-server/NodeSource float latest via `curl | sh`. Add a
      `REPO_REF` env (install from a tag), start tagging releases, pin the
      code-server version. Two servers installed a week apart should run the
      same code.
- [ ] **Define the upgrade path in-repo.** Once `/opt/project/admin` exists,
      §5 skips the copy forever — re-running install.sh never updates code.
      The manager recipe upgrades via local `git fetch` + `reset --hard`
      (untracked `.env.local`/`.mcp.json`/`projects/` survive) + deps +
      migrations + restart; document that as canonical or add a
      `deploy/update.sh` doing the same for manual use.
- [ ] **Keep an install log on the box.** Add
      `exec > >(tee /var/log/genie-local-install.log) 2>&1` near the top of
      install.sh. (The manager recipe currently tees externally.)
- [ ] **Single owner for code-server.** §11 and the manager's dedicated
      code-server recipe both write `code-server.service` with different
      config (workspace, port 8080 vs 127.0.0.1:13337, password handling) —
      last writer wins. The recipe now passes `INSTALL_CODE_SERVER=0`;
      consider flipping the default to 0 here and pointing at the dedicated
      recipe.

### Bigger bets (not tasks yet — pick deliberately)

- **Golden snapshot:** bake this repo into a base image (install.sh becomes the
  image builder), with a first-boot unit generating per-instance secrets
  (`.env.local`, DB + code-server passwords, `.mcp.json`). Provisioning drops
  from 5–15 min to seconds and eliminates the GitHub PAT from the server path.
- **Release-artifact distribution:** publish a tarball per release (or have the
  manager push the bundle over its SSH channel, like the vps-stats sync) so no
  GitHub credential ever touches a target VM.

