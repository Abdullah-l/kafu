# Kafu

Kafu (كفو, "dependable") runs Claude Code as a daemon you talk to from Slack, Telegram, or a local web UI. Every message is handled by the official `claude` CLI, so it uses your existing Claude Code login, MCP servers, skills, and project `CLAUDE.md`.

## Features

- **Slack** over Socket Mode: DMs, @mentions, per-thread sessions, live progress message with a Stop button, file uploads, reactions
- **Multi-user Slack** (opt-in): one bot for a whole team, each person signs in with their own Claude subscription
- **Telegram**: DMs and groups, voice transcription (whisper.cpp), images, per-chat model switching
- **Web UI**: chat, session history, usage, runtime info
- **Models**: Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 4.5, or any Claude model ID; optional fallback model and keyword-based routing
- **Security levels** from read-only to unrestricted, scoped to the project directory
- **Hot reload**: edit `.claude/kafu/settings.json` and changes apply within 30 seconds

## Requirements

- [Bun](https://bun.sh)
- Node.js (for the Telegram voice converter)
- [Claude Code](https://code.claude.com), logged in

## Quick start

As a Claude Code plugin:

```
/plugin marketplace add Abdullah-l/kafu
/plugin install kafu@kafu
/kafu:start
```

Or from a clone, inside the project folder the bot should work in:

```bash
bun install
bun run /path/to/kafu/src/index.ts start --web
```

The first run creates `.claude/kafu/settings.json`. Fill in the connectors you want and the daemon picks them up.

## Settings

```json
{
  "model": "claude-opus-5-5",
  "slack": {
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "allowedUserIds": ["U0123456789"],
    "listenChannels": []
  },
  "telegram": {
    "token": "123456:ABC-DEF...",
    "allowedUserIds": [123456789]
  },
  "security": { "level": "moderate" },
  "web": { "enabled": true, "host": "127.0.0.1", "port": 4632 }
}
```

Allowlists are fail-closed: an empty `allowedUserIds` blocks everyone. See `commands/config.md` for every key.

### Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) and enable **Socket Mode** (gives the `xapp-` token).
2. Bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:write`, `reactions:write`, `files:read`, `files:write`.
3. Events: `app_mention`, `message.im`, `message.channels`, `message.groups`. Enable **Interactivity** for the Stop button.
4. Install to the workspace and copy the `xoxb-` bot token.

## Multi-user Slack

Off by default. Turn it on to share one Slack bot across a team, with every request running on the requester's own Claude subscription:

```json
{
  "multiUser": { "enabled": true, "mcpConfig": ".mcp.json" },
  "slack": { "allowedUserIds": ["*"] }
}
```

- The first time someone talks to the bot, it DMs them a Claude sign-in link (the official `claude setup-token` flow). They approve, paste the code back in the DM, and they're connected.
- Each person gets their own long-lived token (stored encrypted in `.claude/kafu/users/`), their own Claude config folder (history, personal settings), and their own sessions. Nobody's run ever uses someone else's account or the operator's login.
- MCP servers in `multiUser.mcpConfig` (default: the project's `.mcp.json`) are shared by everyone. Personal MCP servers live in each user's own config folder.
- Runs are fully parallel across people and threads. If two people talk in the same thread, each gets their own session, seeded with the thread history.
- Connections page (`multiUser.portal`): Slack hands each person a signed one-time link to a page where they sign in with Claude, connect GitHub through a device code, paste other service tokens, see their status and pick a model. Without the portal, the same setup works through DM commands: `login`, `logout`, `whoami`, `model`, `connect`, `connect <service>`, `disconnect <service>`.
- `multiUser.directMessages: false` makes the bot answer DMs only with a private pointer to channels and the connections page.
- Per-person service credentials: list them in `multiUser.credentials` (`id`, `label`, `env`, `help`, optional `pattern`). Set `"method": "github"` (with optional `scopes`) to connect GitHub through the device sign-in link instead of pasting a token. Each becomes a `connect <id>` command; the value is stored encrypted and exported as `env` only for that person's runs. Shared MCP servers that reference `${ENV}` for a credential the person hasn't connected are left out of their session. Only the person who started a run can press its Stop button. `/reset` only clears your own sessions.
- `allowedUserIds: ["*"]` lets anyone in the workspace use it; list member IDs to restrict it.
- The encryption key is generated at `.claude/kafu/secret.key`, or set `KAFU_SECRET_KEY` (32 bytes, base64) to keep it out of the project folder.
- In the Slack app, enable the **Messages** tab under App Home so people can DM the bot.

## CLI

```bash
kafu start [--web] [--web-port 4632] [--trigger] [--prompt "text"] [--telegram] [--slack] [--replace-existing]
kafu send "text" [--telegram] [--slack]
kafu status [--all]
kafu --stop | --stop-all | --clear
```

(`kafu` = `bun run src/index.ts`.)

## Development

```bash
bun install
bun test
```

## License

MIT. See [LICENSE](LICENSE).
