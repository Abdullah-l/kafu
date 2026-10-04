import { runUserMessage, ensureProjectClaudeMd } from "../runner";
import { getSession } from "../sessions";
import { loadSettings, initConfig } from "../config";
import { sendMessageToUser as sendSlackMessage } from "./slack";

export async function send(args: string[]) {
  const telegramFlag = args.includes("--telegram");
  const slackFlag = args.includes("--slack");
  const message = args.filter((a) => a !== "--telegram" && a !== "--slack").join(" ");

  if (!message) {
    console.error("Usage: kafu send <message> [--telegram] [--slack]");
    process.exit(1);
  }

  await initConfig();
  await loadSettings();
  await ensureProjectClaudeMd();

  const session = await getSession();
  if (!session) {
    console.error("No active session. Start the daemon first.");
    process.exit(1);
  }

  const result = await runUserMessage("send", message);
  console.log(result.stdout);

  if (telegramFlag) {
    const settings = await loadSettings();
    const token = settings.telegram.token;
    const userIds = settings.telegram.allowedUserIds;

    if (!token || userIds.length === 0) {
      console.error("Telegram is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of userIds) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: userId, text }),
        }
      );
      if (!res.ok) {
        console.error(`Failed to send to Telegram user ${userId}: ${res.statusText}`);
      }
    }
    console.log("Sent to Telegram.");
  }

  if (slackFlag) {
    const settings = await loadSettings();
    const { botToken, allowedUserIds } = settings.slack;

    if (!botToken || allowedUserIds.length === 0) {
      console.error("Slack is not configured in settings.");
      process.exit(1);
    }

    const text = result.exitCode === 0
      ? result.stdout || "(empty)"
      : `error (exit ${result.exitCode}): ${result.stderr || "Unknown"}`;

    for (const userId of allowedUserIds) {
      try {
        await sendSlackMessage(botToken, userId, text);
      } catch (err) {
        console.error(`Failed to send to Slack user ${userId}: ${err}`);
      }
    }
    console.log("Sent to Slack.");
  }

  if (result.exitCode !== 0) process.exit(result.exitCode);
}
