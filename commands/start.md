---
description: Start daemon mode or run one-shot prompt/trigger
---

Start the Kafu daemon for this project. Follow these steps exactly:

1. **Block home-directory starts (CRITICAL, BLOCKER)**:
   - Run `pwd` and `echo "$HOME"`.
   - If `pwd` equals `$HOME`, STOP immediately.
   - Tell the user exactly:
     - "CRITICAL BLOCKER: For security reasons, close this session and start a new one from the folder you want to initialize Kafu in."
   - Do not continue with any other step until they restart from a non-home project directory.

2. **Runtime checker (Bun + Node)**:
   - Run:
     ```bash
     which bun
     which node
     ```
   - If `bun` is missing:
     - Tell the user Bun is required and will be auto-installed.
     - Run:
       ```bash
       curl -fsSL https://bun.sh/install | bash
       ```
     - Then source the shell profile to make `bun` available in the current session:
       ```bash
       source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null || true
       ```
     - Verify again with `which bun`. If still not found, tell the user installation failed and to install manually from https://bun.sh, then exit.
   - If `node` is missing:
     - Tell the user Node.js is required for the OGG converter helper.
     - Ask them to install Node.js LTS and rerun start, then exit.

3. **Check existing config**: Read `.claude/kafu/settings.json` (if it exists). Determine which sections are already configured:
   - **Model configured** = `model` is non-empty
   - **Slack configured** = `slack.botToken` and `slack.appToken` are non-empty
   - **Telegram configured** = `telegram.token` is non-empty
   - **Security configured** = `security.level` exists and is not `"moderate"` (the default), OR `security.allowedTools`/`security.disallowedTools` are non-empty

4. **Interactive setup — smart mode** (BEFORE launching the daemon):

   **If ALL sections are already configured**, show a summary of the current config (never print tokens) and ask ONE question with AskUserQuestion:
   - "Your settings are already configured. Want to change anything?" (header: "Settings", options: "Keep current settings", "Reconfigure")

   If they choose "Keep current settings", skip to step 6. If "Reconfigure", run step 5 as if nothing was configured.

   **If SOME sections are configured**, summarize them, then only ask about the unconfigured ones in step 5.

5. **Ask setup questions** with **AskUserQuestion** (all unconfigured sections in one call):

   - **Model**: "Which Claude model should Kafu use?" (header: "Model", options: "claude-opus-5-5 (Recommended)", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5-20251001")
   - **Slack**: "Configure Slack?" (header: "Slack", options: "Yes" / "No")
   - **Telegram**: "Configure Telegram?" (header: "Telegram", options: "Yes" / "No")
   - **Security**: "What security level for Claude?" (header: "Security", options:
     - "Moderate (Recommended)" (description: "Full access scoped to project directory")
     - "Locked" (description: "Read-only — can only search and read files, no edits, bash, or web")
     - "Strict" (description: "Can edit files but no bash or web access")
     - "Unrestricted" (description: "Full access with no directory restriction — dangerous"))

   Then, based on their answers:

   - **Model**: set `model` to the chosen ID.
   - **If yes to Slack**: do NOT use AskUserQuestion for Slack fields. Walk them through it in free-form text:
     1. Create an app at https://api.slack.com/apps from scratch and enable **Socket Mode** (this creates the App-Level Token, `xapp-...`).
     2. Under **OAuth & Permissions**, add bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:write`, `reactions:write`, `files:read`, `files:write`. Install to the workspace and copy the **Bot User OAuth Token** (`xoxb-...`).
     3. Under **Event Subscriptions**, subscribe to `app_mention`, `message.im`, `message.channels`, `message.groups`. Turn on **Interactivity** so the Stop button works.
     4. Ask for both tokens and the allowed Slack member IDs (profile → ⋮ → Copy member ID).
     - Set `slack.botToken`, `slack.appToken`, and `slack.allowedUserIds` (array of strings).
     - Optionally ask for channel IDs where the bot should answer without an @mention and set `slack.listenChannels`.
   - **If yes to Telegram**: do NOT use AskUserQuestion for Telegram fields. Ask in free-form text for:
     - The bot token (from `@BotFather`)
     - Allowed Telegram user IDs (from `@userinfobot`)
     - Set `telegram.token` and `telegram.allowedUserIds` (array of numbers).
   - **Security level**: set `security.level` to `"locked"`, `"strict"`, `"moderate"`, or `"unrestricted"`.
   - **If security is "Strict" or "Locked"**: ask with AskUserQuestion:
     - "Allow any specific tools on top of the security level?" (header: "Allow tools", options: "None — use level defaults (Recommended)", "Bash(git:*) — git only", "Bash(git:*) Bash(npm:*) — git + npm")
     - Set `security.allowedTools` accordingly.
   - If `timezone` is missing, set it to `UTC+0`.

   Write the answers to `.claude/kafu/settings.json`.

6. **Launch**:
   ```bash
   mkdir -p .claude/kafu/logs && nohup bun run ${CLAUDE_PLUGIN_ROOT}/src/index.ts start --web > .claude/kafu/logs/daemon.log 2>&1 & echo $!
   ```
   Use the description "Starting Kafu" for this command.
   Wait 1 second, then check `cat .claude/kafu/logs/daemon.log`. If it contains "Aborted: daemon already running", tell the user and exit.
   - Read `.claude/kafu/settings.json` for `web.port` (default `4632`) and `web.host` (default `127.0.0.1`).
   - Open the dashboard (`open` on macOS, `xdg-open` on Linux). If that fails, print the URL.

7. **Capture session ID**: Read `.claude/kafu/session.json` and extract `sessionId`.

8. **Report**: Show the PID, working directory, session ID, which connectors are live, and the Web UI URL. Then:
   - **Slack**: mention the bot in a channel it's been invited to, or DM it.
   - **Telegram**: open the bot, send `/start`, and start talking.
   - **Claude Code**: `cd <WORKING_DIR> && claude --resume <SESSION_ID>`

---

## Reference: Settings — `.claude/kafu/settings.json`

```json
{
  "model": "claude-opus-5-5",
  "timezone": "UTC+0",
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
  "security": {
    "level": "moderate",
    "allowedTools": [],
    "disallowedTools": []
  },
  "web": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4632
  }
}
```

### Security Levels
All levels run headless. Security is enforced via tool restrictions and project-directory scoping.

| Level | Tools available | Directory scoped |
|-------|----------------|-----------------|
| `locked` | Read, Grep, Glob only | Yes |
| `strict` | Everything except Bash, WebSearch, WebFetch | Yes |
| `moderate` | All tools | Yes |
| `unrestricted` | All tools | No |
