---
description: Show Kafu daemon status
---

Show the current status of the Kafu daemon. Check all of the following:

1. **Daemon process**: Read `.claude/kafu/daemon.pid` and check if the process is alive with `kill -0 <pid>`. Report whether the daemon is running or stopped.

2. **Runtime state**: Read `.claude/kafu/state.json` and show uptime, security level, and which connectors (Slack, Telegram, web) are active.

3. **Configuration**: Read `.claude/kafu/settings.json` and show the model, security level, and whether Slack and Telegram are configured (never print tokens).

Format the output clearly for the user.
