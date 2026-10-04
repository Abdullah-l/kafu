import { join } from "path";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { loadSettings } from "../config";

const CLAUDE_DIR = join(process.cwd(), ".claude");
const KAFU_DIR = join(CLAUDE_DIR, "kafu");
const PID_FILE = join(KAFU_DIR, "daemon.pid");
const SETTINGS_FILE = join(KAFU_DIR, "settings.json");

function decodePath(encoded: string): string {
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

async function findAllDaemons(): Promise<{ path: string; pid: string }[]> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const results: { path: string; pid: string }[] = [];

  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return results;
  }

  for (const dir of dirs) {
    const candidatePath = decodePath(dir);
    const pidFile = join(candidatePath, ".claude", "kafu", "daemon.pid");

    try {
      const pid = (await readFile(pidFile, "utf-8")).trim();
      process.kill(Number(pid), 0);
      results.push({ path: candidatePath, pid });
    } catch {
    }
  }

  return results;
}

async function showAll(): Promise<void> {
  const daemons = await findAllDaemons();

  if (daemons.length === 0) {
    console.log(`\x1b[31m○ No running daemons found\x1b[0m`);
    return;
  }

  console.log(`Found ${daemons.length} running daemon(s):\n`);
  for (const d of daemons) {
    console.log(`\x1b[32m● Running\x1b[0m PID ${d.pid} — ${d.path}`);
  }
}

async function showStatus(): Promise<boolean> {
  let daemonRunning = false;
  let pid = "";
  try {
    pid = (await Bun.file(PID_FILE).text()).trim();
    process.kill(Number(pid), 0);
    daemonRunning = true;
  } catch {
  }

  if (!daemonRunning) {
    console.log(`\x1b[31m○ Daemon is not running\x1b[0m`);
    return false;
  }

  console.log(`\x1b[32m● Daemon is running\x1b[0m (PID ${pid})`);

  try {
    const settings = await Bun.file(SETTINGS_FILE).json();
    console.log(`  Model: ${settings.model || "default"}`);
    console.log(`  Telegram: ${settings.telegram?.token ? "enabled" : "disabled"}`);
    console.log(`  Slack: ${settings.slack?.botToken ? "enabled" : "disabled"}`);
  } catch {}

  return true;
}

export async function status(args: string[]) {
  try { await loadSettings(); } catch {}

  if (args.includes("--all")) {
    await showAll();
  } else {
    await showStatus();
  }
}
