# Slack

The admin has a Slack bot (`src/lib/slack/`). From Slack you can:

- **Get alerts.** A message arrives when a Claude terminal finishes a turn or is
  waiting on you (a permission prompt, a choice). It shows the end of the
  terminal's screen. A waiting prompt gets a button per option, plus **Esc** and
  **Show screen**.
- **Reply into a terminal.** Whatever you write in an alert's thread is typed
  into that terminal, followed by Enter. While it's waiting on a choice, reply
  with the option's number. `!esc`, `!enter`, `!tab`, `!up`, `!down` and
  `!ctrl-c` press those keys. Once you've replied in a thread, that terminal's
  next alert lands in the same thread (and in the channel) for an hour.
- **Run commands.** Use `/genie <command>` anywhere (only you see the answer), a
  DM to the bot, or a message mentioning `@genie` in a channel it's in:

  | Command | What it does |
  |---|---|
  | `status` | every terminal and what it's doing |
  | `show <terminal> [lines]` | the end of its screen (its thread then talks to it) |
  | `send <terminal> <text>` | type a line into it |
  | `key <terminal> <key>` | press `1`…`9`, `esc`, `enter`, `tab`, `up`, `down`, `ctrl-c` |
  | `ask <question>` | ask Claude about what the terminals are doing (same as Jarvis's Q&A) |
  | `mute [terminal]` / `unmute <terminal>` | stop or resume its alerts |
  | `projects` | the projects |
  | `tasks <project> [all]` | its open and in-progress tasks |
  | `task add <project> <title>` | add a task |
  | `task start\|done\|reopen <project> <id>` | move a task |

  A terminal or project name can be shortened to any prefix that matches only
  one name. Put a name that has spaces in quotes.

The bot uses **Socket Mode**: the box opens the connection to Slack, so nginx
needs no new route and Slack never connects in. It runs inside the prod admin
process (`src/instrumentation.ts` starts it), and only on prod: admin-dev reads
the same `.env.local`, and two connections would split Slack's events between
them. Set `SLACK_ON_DEV=1` to run it on a dev instance instead.

## Who can use it

Only the Slack users in `SLACK_ALLOWED_USERS` can use it. Typing into a
terminal is as powerful as having a shell on the box, so treat that list like the
Users page. Anyone else who messages the bot or clicks one of its buttons is told
their Slack user id once, and nothing else happens. That's also the easy way to
find your own id.

## Setting it up

1. On <https://api.slack.com/apps>, choose **Create New App**, then **From a
   manifest**. Pick the workspace and paste `ops/slack-app-manifest.json`.
2. **Basic Information → App-Level Tokens → Generate**, with the scope
   `connections:write`. This gives the `xapp-…` token.
3. **Install App → Install to Workspace**. This gives the Bot User OAuth Token
   (`xoxb-…`).
4. Add to `admin/.env.local`:

   ```sh
   SLACK_BOT_TOKEN=xoxb-…
   SLACK_APP_TOKEN=xapp-…
   SLACK_ALLOWED_USERS=U012AB3CD          # comma-separated; Slack profile → ⋮ → Copy member ID
   SLACK_CHANNEL=C0123456789              # optional: alerts go here (invite @genie); unset = a DM to each allowed user
   # SLACK_ALERTS=off                     # optional: commands and replies only, no alerts
   ```

5. If genie's egress firewall is on (`/etc/genie/firewall-allow.txt`, the
   Firewall page), allow `slack.com`, `wss-primary.slack.com`,
   `wss-backup.slack.com` and `hooks.slack.com`, then run `sudo genie-firewall`.
   Without them the journal shows `[slack] not started: fetch failed
   (ECONNREFUSED)`. The bot keeps retrying (up to every 10 min), so it connects
   once they're allowed, with no restart needed.
6. `sudo admin-ctl deploy`, or just restart `admin.service` if nothing else
   changed. `journalctl -u admin.service | grep '\[slack\]'` should show
   `signed in to <workspace>` and `socket: connected`.

The tokens are kept out of terminals, agent runs and board Claude runs, like
the admin's other secrets. Which thread belongs to which terminal, and which
terminals are muted, is saved in `/opt/project/.slack/state.json`
(`SLACK_STATE_FILE`). Without that file, a restart would cut existing threads
off from their terminals.

## Notes

- Alerts come from a poll of the terminals every 3 s, the same detection the
  dock and the voice alerts use (`classify` in `src/lib/terminals.ts`). A new
  status has to hold for two polls, so the moment between two steps, when
  "esc to interrupt" blinks out, isn't taken for a finished turn. Terminals that
  are already open when the server starts are recorded first, not alerted.
- Replies are sent as one line, because tmux `send-keys` would submit at every
  newline.
- Free text can't answer a choice prompt: it would land in the menu as
  keystrokes. Reply with the number, or `!esc` and then the text.
- Every action is logged as `[slack] <user> …` in the admin's journal.
- `src/lib/slack/core.ts` is the pure part (parsing, detection, messages) and is
  tested in `core.test.ts`. `SLACK_API_URL` points the bot at a stand-in Slack,
  for end-to-end checks.
