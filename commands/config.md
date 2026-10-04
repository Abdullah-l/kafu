---
description: View or modify Kafu settings
---

View or modify Kafu settings in `.claude/kafu/settings.json`. Use `$ARGUMENTS` to determine the action. If no arguments are given, show the current config.

Changes are hot-reloaded every 30 seconds. No restart needed.

## Sub-commands

### `show` (default)

Read `.claude/kafu/settings.json` and display:

- **General**: model, fallback model, agentic routing on/off, timezone
- **Slack**: bot/app token configured (first 5 chars + "..." or "not configured"), allowed users, listen channels
- **Telegram**: token configured (masked), allowed users
- **Security**: level, allowed tools, disallowed tools
- **Web UI**: enabled, host:port
- **Timeouts**: telegram, slack, default (minutes)

Never print full tokens.

### `model <id>` / `model`

1. If an ID is in `$ARGUMENTS`, use it.
2. Otherwise ask with **AskUserQuestion**: "Which Claude model should Kafu use?" (header: "Model", options: "claude-opus-5-5 (Recommended)", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5-20251001")
3. Set `model` and confirm.

### `fallback model <id>` / `fallback model`

Set `fallback.model`, used automatically when the primary run hits a rate limit. Ask with the same model options plus "None" (`""`).

### `agentic on` / `agentic off`

Toggle `agentic.enabled`. When on, prompts are routed by keyword to the models in `agentic.modes` (default: planning → `opus`, implementation → `sonnet`).

### `slack tokens` / `slack users <id1,id2,...>` / `slack channels <id1,id2,...>` / `slack off`

- `tokens`: ask in free-form text for the bot token (`xoxb-...`) and app token (`xapp-...`); set `slack.botToken` and `slack.appToken`.
- `users`: set `slack.allowedUserIds` (array of strings).
- `channels`: set `slack.listenChannels` (channels where the bot answers without an @mention).
- `off`: clear `slack.botToken` and `slack.appToken`.

### `telegram token <token>` / `telegram users <id1,id2,...>` / `telegram off`

- `token`: set `telegram.token`.
- `users`: set `telegram.allowedUserIds` (array of numbers).
- `off`: set `telegram.token` to `""` and `telegram.allowedUserIds` to `[]`.

### `timezone <tz>`

Set `timezone` (IANA name like `Asia/Riyadh`, or UTC offset like `UTC+3`). `timezoneOffsetMinutes` is resolved automatically.

### `security level <level>` / `security tools allow <tools>` / `security tools disallow <tools>`

- `level`: one of `locked`, `strict`, `moderate`, `unrestricted`. Explain what it permits.
- `allow` / `disallow`: append comma-separated tool names to `security.allowedTools` / `security.disallowedTools` (deduplicated).

### `web on` / `web off` / `web port <port>` / `web host <host>`

Update `web.enabled`, `web.port`, or `web.host`.

### `reset`

Ask for confirmation with **AskUserQuestion**, then write the defaults:

```json
{
  "model": "",
  "api": "",
  "fallback": { "model": "", "api": "" },
  "timezone": "UTC",
  "timezoneOffsetMinutes": 0,
  "telegram": { "token": "", "allowedUserIds": [] },
  "slack": { "botToken": "", "appToken": "", "allowedUserIds": [], "listenChannels": [] },
  "security": { "level": "moderate", "allowedTools": [], "disallowedTools": [] },
  "web": { "enabled": false, "host": "127.0.0.1", "port": 4632 }
}
```

---

## Reference

| Key | Type | Description |
|-----|------|-------------|
| `model` | string | Claude model ID or alias. Empty = Claude Code default |
| `api` | string | Optional Anthropic API key passed as `ANTHROPIC_AUTH_TOKEN` |
| `fallback.model` | string | Model used when the primary run is rate limited |
| `fallback.api` | string | Optional API key for the fallback model |
| `agentic.enabled` | boolean | Route prompts to models by keyword |
| `agentic.modes` | object[] | `{ name, model, keywords, phrases? }` routing modes |
| `timezone` | string | IANA name or UTC offset |
| `slack.botToken` | string | Bot User OAuth Token (`xoxb-...`) |
| `slack.appToken` | string | Socket Mode App-Level Token (`xapp-...`) |
| `slack.allowedUserIds` | string[] | Slack member IDs allowed to talk to the bot |
| `slack.listenChannels` | string[] | Channels answered without an @mention |
| `slack.allowBots` | string[] | Channels where other bots' messages are passed through |
| `telegram.token` | string | Bot token from @BotFather |
| `telegram.allowedUserIds` | number[] | Telegram user IDs allowed to talk to the bot |
| `telegram.dmIsolation` | string | `shared` (default) or `perUser` sessions for DMs |
| `security.level` | string | `locked` \| `strict` \| `moderate` \| `unrestricted` |
| `security.allowedTools` | string[] | Extra tools to allow |
| `security.disallowedTools` | string[] | Tools to block |
| `timeouts.telegram` / `timeouts.slack` / `timeouts.default` | number | Max minutes per run |
| `web.enabled` / `web.host` / `web.port` | | Local dashboard |
