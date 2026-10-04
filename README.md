# Kafu

Kafu (كفو, "dependable") runs Claude Code as a daemon you talk to from Slack, Telegram, or a local web UI. Every message is handled by the official `claude` CLI, so it uses your existing Claude Code login, MCP servers, skills, and project `CLAUDE.md`.

## Features

- **Slack** over Socket Mode: DMs, @mentions, per-thread sessions, live progress message with a Stop button, file uploads, reactions
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

MIT. Kafu started as a fork of [claudeclaw](https://github.com/moazbuilds/claudeclaw).
