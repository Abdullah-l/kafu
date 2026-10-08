# Kafu

Kafu (كفو, "dependable") runs Claude Code as a daemon you talk to from Slack, Telegram, or a local web UI. Every message is handled by the official `claude` CLI, so it uses your existing Claude Code login, MCP servers, skills, and project `CLAUDE.md`.

## Features

- **Slack** over Socket Mode: DMs, @mentions, per-thread sessions, live progress message with a Stop button, file uploads, reactions
- **Teams** (opt-in): one Slack bot for a whole team; each person's requests run on their own computer through a small agent, or on the server with their own credentials
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

Or install the CLI and run it inside the project folder the bot should work in:

```bash
bun install -g github:Abdullah-l/kafu
kafu start --web
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

## Teams: one Slack bot, everyone's own Claude

Turn on multi-user mode to share one Slack bot across a team. Every request runs with the requester's own Claude account and tools; nobody uses anyone else's.

```json
{
  "multiUser": { "enabled": true, "portal": { "enabled": true, "port": 4650, "publicUrl": "http://your-server:4650" } },
  "slack": { "allowedUserIds": ["*"] }
}
```

`allowedUserIds: ["*"]` lets anyone in the workspace use it; list member IDs to restrict it. Runs are fully parallel across people and threads; if two people talk in one thread, each gets their own session seeded with the thread history. Only the person who started a run can stop it.

### Recommended: run on each person's own computer

The server keeps the Slack connection and routing. The work runs in the official `claude` on the person's machine, with their own Claude login, MCP servers, repos, git and SSO sessions. The server stores nobody's credentials.

```bash
bun install -g github:Abdullah-l/kafu
kafu agent pair <server-url> <code>   # mention the bot with `pair` in Slack to get this command
kafu agent                            # keep it running
kafu agent status                     # pairing, Claude, gh and MCP status
```

- The agent connects out to the server (`/agent` WebSocket on the portal port); nothing listens on the laptop.
- Pairing codes work once and expire in 10 minutes. The device token is stored in `~/.kafu/agent.json` (`KAFU_AGENT_HOME` overrides the folder). `unpair` in Slack revokes it; `status` shows whether your computer is connected.
- `~/.kafu/agent.json` also sets `workspace` (where Claude runs, default your home folder), `permissionMode` (default `bypassPermissions`; use `acceptEdits` plus `allowedTools` to restrict) and `allowedTools`.
- If someone is paired but their computer is offline, the bot tells them instead of running anything.
- Slack attachments travel with the request; live progress and the Stop button work the same.
- Update with the same `bun install -g` command.

### Alternative: run on the server

People who haven't paired a computer run on the server, each with their own Claude config folder, sessions and stored credentials. Use this with Claude Team/Enterprise or API-key setups; check that your plan's terms allow it before sharing personal subscriptions this way.

- Connections page (`multiUser.portal`): Slack hands each person a private one-time link to a page where they sign in with Claude (the official `claude setup-token` flow), connect GitHub through a device code, paste other service tokens, see their status and pick a model. Without the portal, the same setup works through DM commands: `login`, `logout`, `whoami`, `model`, `connect`, `connect <service>`, `disconnect <service>`.
- Per-person service credentials: list them in `multiUser.credentials` (`id`, `label`, `env`, `help`, optional `pattern`; `"method": "github"` with optional `scopes` for the device sign-in). Each value is stored encrypted and exported as `env` only for that person's runs. Shared MCP servers in `multiUser.mcpConfig` (default `.mcp.json`) that reference `${ENV}` for a credential the person hasn't connected are left out of their session.
- Tokens are encrypted with `KAFU_SECRET_KEY` (32 bytes, base64), or a key generated at `.claude/kafu/secret.key`.
- Everyone's runs share one OS user on the server. Isolate per user before opening it to people you don't trust.

### Slack settings for teams

- `multiUser.directMessages: false`: the bot answers DMs only with a private pointer to channels and the connections page. Also untick "Allow users to send messages" under App Home in the Slack app.
- The connections page and the agent endpoint are plain HTTP on the portal port. Keep that port on a private network or put it behind HTTPS.

## CLI

```bash
kafu start [--web] [--web-port 4632] [--trigger] [--prompt "text"] [--telegram] [--slack] [--replace-existing]
kafu send "text" [--telegram] [--slack]
kafu status [--all]
kafu --stop | --stop-all | --clear
```

From a clone, `kafu` is `bun run src/index.ts`.

## Development

```bash
bun install
bun test
```

## License

MIT. See [LICENSE](LICENSE).
