# @mocaos/cortex

Interactive installer for self-hosted [Cortex](https://github.com/mocaOS/cortex-app) — an
agentic knowledge base with a chat front end.

```bash
npx @mocaos/cortex
```

## What you need

Docker with the **Compose v2 plugin** (`docker compose version`). On Linux,
`apt install docker.io` does **not** include Compose v2; use Docker's official
packages or Docker Desktop.

Also `curl` and `tar`, which the installer uses to fetch the release artifacts.
Both are present on macOS and on virtually every Linux desktop, but Debian's
minimal and cloud images ship `wget` rather than `curl` — preflight checks for
them and names whichever is missing.

`npx` brings its own Node, but if you already have one on your `PATH` it must
be **20.12 or newer** — older Node, including 18, fails the installer's first
check before anything is written or pulled.

~20 GB free disk, ~8 GB RAM, `linux/amd64` or `linux/arm64`, and an
OpenAI-compatible API key — OpenAI, OpenRouter, Venice, Groq, a local Ollama,
or anything else that speaks the same API. Images pull about 1.7 GB total
(the backend is the largest piece, at ~1.2 GB).

## What it does

Reads the latest tested release manifest, checks your environment, asks what it
needs, **verifies your LLM credentials with live calls before writing
anything**, then pulls pinned images and starts the stack.

Two modes: localhost (ports bound to `127.0.0.1`) or a public domain with
automatic HTTPS via Caddy.

## Commands

| Command | Does |
|---|---|
| `npx @mocaos/cortex` | Interactive install |
| `cortex update` | Move to the latest tested release |
| `cortex config` | Show where settings live, then `restart` to apply edits |
| `cortex status` | Service state, health, URLs |
| `cortex logs [service]` | Follow logs |
| `cortex start` / `stop` / `restart` | Lifecycle |
| `cortex backup` | Run a verified backup now |
| `cortex restore [stamp]` | Guided restore |
| `cortex doctor` | One pasteable diagnostic block |
| `cortex uninstall` | Remove containers; volumes need a typed confirmation |

Every command accepts `--dir <path>` if your install isn't `./cortex` or
discoverable by walking up from the current directory.

## Non-interactive

For scripted installs:

```bash
CORTEX_ADMIN_EMAIL=you@example.com \
CORTEX_OPENAI_API_KEY=sk-... \
CORTEX_OPENAI_MODEL=gpt-5.2 \
CORTEX_EMBEDDING_MODEL=text-embedding-3-small \
CORTEX_EMBEDDING_DIMENSION=1536 \
npx @mocaos/cortex --yes
```

Add `CORTEX_MODE=domain` with `CORTEX_APP_DOMAIN`, `CORTEX_CHAT_DOMAIN` and
`CORTEX_ACME_EMAIL` for a public deployment. Secrets are generated unless you
supply `CORTEX_ADMIN_PASSWORD`, `CORTEX_NEO4J_PASSWORD`,
`CORTEX_ADMIN_API_KEY`, `CORTEX_SESSION_SECRET` or
`CORTEX_CHAT_ENCRYPTION_KEY`.

`--yes` runs the same live LLM probes as the interactive wizard — before
`.env` exists and before any image is pulled — so a bad key fails in seconds,
not after a multi-minute pull.

## What it writes

```
./cortex/
  .env             the only file the installer authors — mode 600, holds your secrets
  cortex.json      install state, no secrets
  docker-compose*.yml, Caddyfile*, ops/, .env.example   release artifacts, verbatim
```

`.env` is yours to edit. Compose changes belong in `docker-compose.override.yml`,
which Compose merges automatically and updates never touch.

## Privacy

Error reporting is **off by default everywhere**. The one privacy question the
wizard asks — "send anonymous crash reports to the Cortex maintainers?" —
only toggles Cortex Chat's server-side reporting; the backend and frontend
never report anywhere unless you set your own `SENTRY_DSN_BACKEND` /
`SENTRY_DSN_FRONTEND` in `.env` yourself, and neither the frontend nor Cortex
Chat ever reports **browser-side** errors — that half is compiled out of
every published image at build time, regardless of what you set at runtime.
The installer itself has no telemetry: it talks to GitHub (the release), your
registry (image pulls), and the LLM endpoint you configure — nothing else.

## Manual install

This installer automates the Compose-based setup documented in
[`selfhost/README.md`](https://github.com/mocaOS/cortex-app/blob/main/selfhost/README.md)
in the main Cortex repository. Use that path if you'd rather not run `npx` at all.
