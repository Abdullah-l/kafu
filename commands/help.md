---
description: Show Kafu help
---

Display this help information to the user:

**Kafu** runs Claude Code as a daemon you talk to from Slack, Telegram, or a local web UI.

**Commands:**
- `/kafu:start` — Initialize config and start the daemon
- `/kafu:stop` — Stop the running daemon
- `/kafu:clear` — Back up the current session and restart fresh
- `/kafu:status` — Show daemon status and config
- `/kafu:config` — View or modify settings (model, Slack, Telegram, security, web)
- `/kafu:logs` — Show recent run logs
- `/kafu:telegram` — Show Telegram bot status and sessions (use `clear` to reset sessions)
- `/kafu:help` — Show this help message

**CLI:**
- `bun run src/index.ts start` — start the daemon
- `bun run src/index.ts start --web [--web-port 4632]` — start with the web dashboard
- `bun run src/index.ts start --prompt "text"` — one-shot prompt, no daemon
- `bun run src/index.ts start --trigger [--prompt "text"] [--telegram] [--slack]` — start and run a startup prompt, optionally forwarding the reply
- `bun run src/index.ts send "text" [--telegram] [--slack]` — send to the running daemon's session
- `bun run src/index.ts status [--all]`
- `bun run src/index.ts --stop` / `--stop-all` / `--clear`

**Models:** set `model` in settings to any Claude model ID or alias:
- `claude-fable-5-1` — Fable 5.1
- `claude-opus-5-5` — Opus 5.5
- `claude-sonnet-5-5` — Sonnet 5.5
- `claude-haiku-4-5-20251001` — Haiku 4.5

On Telegram, `/model` shows the current model and `/modelfable`, `/modelopus`, `/modelsonnet`, `/modelhaiku`, `/modeldefault` switch it per chat.

**Configuration:** `.claude/kafu/settings.json`, hot-reloaded every 30 seconds.

**Note:** Bun is required. It is auto-installed on first `/kafu:start` if missing.
