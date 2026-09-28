# Hermes Console

A local web console for this Hermes install. Open a browser, get the agent,
the skills, the plugins, the sessions, and the cron jobs. No terminal needed
after startup.

```
./run.sh
```

Then open http://127.0.0.1:8787/ (the script tries to open it for you).

## Menjalankan (tanpa buka Hermes / terminal)

```
./start.sh
```

Itu saja. Skrip ini menyalakan server kalau belum jalan, lalu membuka browser.
Server dijalankan terlepas dari Termux, jadi **kamu bisa tutup Termux dan console
tetap hidup**.

Dari mana saja (sudah terpasang di PATH):

```
hermes-console          # nyalakan + buka browser
hermes-console --stop   # matikan
```

Port lain: `HERMES_CONSOLE_PORT=9000 ./start.sh`

Pertama kali saja, kalau `dist/` belum ada:

```
./run.sh --no-open
```

Kalau console sudah jalan dan kamu buka `./start.sh` lagi, ia mendeteksi dan
langsung membuka browser tanpa menyalakan server kedua.

## What it does

| View | What you get |
|---|---|
| **Overview** | Model, provider, tool switches, skill count, session count, disk, and the runtime facts of this install. |
| **Chat** | Runs `hermes chat` on this machine and streams the run live. Keeps one conversation; start a new one with the New conversation button. |
| **Work** | Live view of the agent while it works: which tool is running, on what, for how long, plus a step list and the raw event stream. |
| **History** | Every stored conversation, searchable. Read any transcript, or continue one in Chat. Separate from Chat on purpose. |
| **Model** | Switch provider and default model, add a new endpoint provider (name, base URL, key, model list), or type a model id directly. |
| **Skills** | All 175 SKILL.md files, searchable by name, description, and category. Open one to read the whole file. |
| **Plugins** | Every plugin manifest, whether it is on, and the tool sets it contributes. |
| **Activity** | Live agent-loop feed (tool calls, API calls, tokens) from the `live-activity` plugin. |
| **Cron** | Scheduled jobs, their schedule, next run, and delivery target. |
| **Settings** | Connection details and the exact limits of this console. |

## Requirements

- `python3` (3.9+). The server is stdlib only: no pip, no venv.
- `node` + `npm` for the build step only. The built `dist/` is committed, so a
  device that only wants to *run* the console can skip it with `./run.sh --no-build`.
- `hermes` on `PATH` for the Chat view and the plugin list.

## Commands

```bash
./run.sh                    # build if needed, serve on 8787, open a browser
./run.sh --port 9000        # different port
./run.sh --no-build         # serve the existing dist/ (no node needed)
./run.sh --no-open          # do not try to open a browser
./run.sh --dev              # Vite dev server on 5173 with hot reload

python3 server.py --port 8787 --no-open   # the server alone
python3 tests/test_api.py                 # API + security smoke test
python3 tests/test_chat_e2e.py            # real agent run, end to end
python3 scripts/verify.py                 # contrast + design-token rules
```

### Dev mode

`./run.sh --dev` starts Vite on 5173 with hot reload. It still needs the Python
server running, because that is what owns the API **and** the session token: Vite
serves the page, but the token comes from `server.py`. Start both:

```bash
./run.sh --no-build          # terminal 1: the API on 8787
./run.sh --dev               # terminal 2: the dev page on 5173
```

The Vite config reads the token from the server and injects it into the dev page
automatically. If the server is not up, the page logs a specific error and the
`--dev` banner warns you, instead of rendering a page whose every request 403s.

## How it is put together

```
index.html            shell, loads tokens.css + app.css
server.py             stdlib HTTP server: static files + JSON API + SSE
run.sh                build and launch
DESIGN.md             the design direction, palette, and measured contrast
scripts/gen-icons.mjs pulls 29 glyphs out of lucide-static into src/icons.ts
src/api.ts            typed client, the only place that knows the wire format
src/dom.ts            typed hyperscript, icons, formatters
src/view-kit.ts       loading / empty / error scaffolding
src/view-*.ts         one file per view (chat, work, history, model, skills, ...)
public/styles/        tokens.css (the design system) + app.css (layout)
tests/                API smoke test and a real end-to-end agent run
dist/                 the built UI that server.py serves
```

State the console creates lives in `~/.hermes-web/runs/`, one JSONL file per
agent run. Override with `HERMES_WEB_HOME`.

## Boundaries, stated plainly

- **Loopback only.** The server binds `127.0.0.1`. It runs the agent, so it must
  never be reachable from your network. There is no option to bind elsewhere.
- **Token guarded.** A random token is minted at startup and injected into the
  served `index.html` as a meta tag. Every `/api` call must send it in
  `X-Hermes-Token`, and a request carrying a non-loopback `Origin` is refused.
  A page on another site cannot read `index.html`, so it cannot forge a call to
  this port.
- **Two writes, and only two.** Everything else is read-only, including the
  session database (opened with `mode=ro`). The exceptions are the Model view:
  - switching the model rewrites **only** the top-level `model:` block of
    `config.yaml`;
  - adding a provider appends to **only** the `custom_providers:` block and
    writes the key to `~/.hermes/.env`.
  Both copy the file to a timestamped `*.bak-console-*` first, then read it back
  and report what actually landed. Skills, plugins, cron, and sessions are never
  written.
- **API keys never appear in the page.** A key typed into the Model form goes
  straight to `.env` over loopback and is cleared from the form field on success.
  The page never receives a key back from the server.
- **Chat costs what chat costs.** Each message runs a real `hermes chat` with
  your configured model and tools. It is not a cheaper side channel.
- **No daemon.** The console runs in the foreground and stops with Ctrl+C. It
  does not install a service.
- **Plugin list needs the CLI.** It comes from `hermes plugins list --json`,
  which takes ~15s. Manifests are read from disk first so the view is instant,
  and the CLI result is cached for minutes to confirm it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `dist/ is missing` | Run `./run.sh` once, or `npm install && npm run build`. |
| Chat says `'hermes' not found on PATH` | The server could not find the CLI. Start it from a shell where `which hermes` works. |
| Everything shows "server unreachable" | The server stopped. Restart `./run.sh`; find a stray one with `pgrep -af server.py`. |
| Activity view is empty | The feed comes from the `live-activity` plugin. Enable it: `hermes plugins enable live-activity`. |
| Skills list looks stale | It is cached for 30 seconds. Press Reload. |
| Cron is empty | No jobs are scheduled. `hermes cron list` confirms; create one with `hermes cron create`. |
| Port already in use | `./run.sh --port 8899`, or stop the old one. |

## Tests

```
$ python3 tests/test_api.py
35 passed, 0 failed
```

The API test covers the token guard, the foreign-Origin refusal, path traversal,
missing and malformed input, and asserts that skill, session, and tool payloads
carry real content rather than placeholder shapes.

```
$ python3 tests/test_chat_e2e.py
15 passed, 0 failed
```

The end-to-end test starts a real agent run through the HTTP API, follows the
SSE stream, checks the reply, then confirms the transcript landed in the session
store and that a second turn reuses the same session.
