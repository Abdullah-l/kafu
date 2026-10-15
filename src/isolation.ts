import { existsSync, lstatSync } from "node:fs";
import { chmod, chown, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSettings } from "./config";

const PROJECT_DIR = process.cwd();
const KAFU_DIR = join(PROJECT_DIR, ".claude", "kafu");
const UID_FILE = join(KAFU_DIR, "uids.json");
const FIRST_UID = 20000;
const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
const MEMORY_ENTRIES = ["CLAUDE.md", "CLAUDE.local.md", "rules", "skills", "commands", "agents", "hooks", "output-styles", "settings.json", "settings.local.json"];

let uidLock: Promise<unknown> = Promise.resolve();

export function isolationEnabled(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0 && getSettings().multiUser.enabled;
}

export async function runUid(userId: string): Promise<number> {
  const next = uidLock.then(async () => {
    let map: Record<string, number> = {};
    try {
      map = JSON.parse(await readFile(UID_FILE, "utf8")) as Record<string, number>;
    } catch {}
    if (map[userId]) {
      await ensureAccount(userId, map[userId]);
      return map[userId];
    }
    const uid = Math.max(FIRST_UID - 1, ...Object.values(map)) + 1;
    map[userId] = uid;
    await mkdir(KAFU_DIR, { recursive: true });
    await writeFile(`${UID_FILE}.tmp`, JSON.stringify(map, null, 2) + "\n", { mode: 0o600 });
    await rename(`${UID_FILE}.tmp`, UID_FILE);
    await ensureAccount(userId, uid);
    return uid;
  });
  uidLock = next.catch(() => {});
  return next;
}

export function userHomeDir(userId: string): string {
  return join(KAFU_DIR, "users", userId, "home");
}

async function appendLine(file: string, prefix: string, line: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {}
  if (text.split("\n").some((l) => l.startsWith(prefix))) return;
  await writeFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
}

async function ensureAccount(userId: string, uid: number): Promise<void> {
  const name = `kafu${uid}`;
  await appendLine("/etc/group", `${name}:`, `${name}:x:${uid}:`);
  await appendLine("/etc/passwd", `${name}:`, `${name}:x:${uid}:${uid}:${userId}:${userHomeDir(userId)}:/bin/bash`);
}

async function ensureAllAccounts(): Promise<void> {
  let map: Record<string, number> = {};
  try {
    map = JSON.parse(await readFile(UID_FILE, "utf8")) as Record<string, number>;
  } catch {
    return;
  }
  for (const [userId, uid] of Object.entries(map)) await ensureAccount(userId, uid);
}

export async function pruneWorkDirs(maxAgeDays: number): Promise<number> {
  const root = join(PROJECT_DIR, "agents");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      const stat = await lstat(path);
      if (stat.uid < FIRST_UID || stat.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

async function chownTree(path: string, uid: number): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.uid !== uid || stat.gid !== uid) await chown(path, uid, uid);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await chownTree(join(path, entry), uid);
}

async function lockTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  await chown(path, 0, 0);
  await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
  if (!stat.isDirectory()) return;
  for (const entry of await readdir(path)) await lockTree(join(path, entry));
}

async function openPathTo(path: string): Promise<void> {
  let dir = dirname(path);
  while (dir.startsWith(KAFU_DIR + "/")) {
    await chmod(dir, 0o711).catch(() => {});
    dir = dirname(dir);
  }
}

async function ownedDir(path: string, uid: number, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true });
  await chown(path, uid, uid);
  await chmod(path, mode);
}

async function stripMemory(dir: string): Promise<void> {
  await Promise.all(MEMORY_ENTRIES.map((name) => rm(join(dir, name), { recursive: true, force: true })));
}

async function stripProjectMemory(configDir: string): Promise<void> {
  const projects = join(configDir, "projects");
  let dirs: string[] = [];
  try {
    dirs = await readdir(projects);
  } catch {
    return;
  }
  await Promise.all(dirs.map((d) => rm(join(projects, d, "memory"), { recursive: true, force: true })));
}

export async function prepareSandbox(opts: {
  uid: number;
  userDir: string;
  configDir: string;
  homeDir: string;
  workDir?: string;
  readable: string[];
}): Promise<void> {
  await mkdir(opts.userDir, { recursive: true });
  await chown(opts.userDir, 0, 0);
  await chmod(opts.userDir, 0o711);
  await ownedDir(opts.configDir, opts.uid);
  await stripMemory(opts.configDir);
  await stripProjectMemory(opts.configDir);
  await chownTree(opts.configDir, opts.uid);
  await ownedDir(opts.homeDir, opts.uid);
  await stripMemory(join(opts.homeDir, ".claude"));
  if (opts.workDir) {
    await ownedDir(opts.workDir, opts.uid);
    const now = new Date();
    await utimes(opts.workDir, now, now).catch(() => {});
    await stripMemory(opts.workDir);
    await rm(join(opts.workDir, ".claude"), { recursive: true, force: true });
    await chownTree(opts.workDir, opts.uid);
  }
  for (const path of opts.readable) {
    try {
      await chown(path, opts.uid, opts.uid);
      await chmod(path, 0o600);
      await openPathTo(path);
    } catch {}
  }
}

export function sandboxCommand(args: string[], uid: number): string[] {
  return ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--inh-caps=-all", "--bounding-set=-all", ...args];
}

async function rootOnly(path: string, mode: number): Promise<void> {
  if (!existsSync(path)) return;
  await chown(path, 0, 0);
  await chmod(path, mode);
}

async function rootSymlink(path: string, target: string): Promise<void> {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && stat.uid === 0) return;
  } catch {}
  await rm(path, { recursive: true, force: true });
  await symlink(target, path);
  await chown(path, 0, 0).catch(() => {});
}

export async function hardenWorkspace(): Promise<void> {
  process.umask(0o077);
  await ensureAllAccounts();
  await rootOnly(PROJECT_DIR, 0o755);
  for (const entry of await readdir(PROJECT_DIR)) {
    const path = join(PROJECT_DIR, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && stat.uid !== 0) await rootSymlink(path, await readlink(path));
  }
  await mkdir(join(PROJECT_DIR, ".claude"), { recursive: true });
  await rootOnly(join(PROJECT_DIR, ".claude"), 0o711);
  await stripMemory(join(PROJECT_DIR, ".claude"));
  await mkdir(join(PROJECT_DIR, "agents"), { recursive: true });
  await rootOnly(join(PROJECT_DIR, "agents"), 0o711);
  for (const entry of await readdir(join(PROJECT_DIR, "agents"))) {
    const path = join(PROJECT_DIR, "agents", entry);
    const stat = await lstat(path);
    if (stat.uid < FIRST_UID) await lockTree(path);
  }
  await Promise.all(["CLAUDE.local.md", ".mcp.json"].map((n) => rm(join(PROJECT_DIR, n), { force: true })));
  await Promise.all(["CLAUDE.md", "CLAUDE.local.md", ".claude"].map((n) => rm(join(PROJECT_DIR, "agents", n), { recursive: true, force: true })));
  await rootOnly(KAFU_DIR, 0o711);
  for (const entry of await readdir(KAFU_DIR)) {
    if (entry === "users" || entry === "settings.json") continue;
    await lockTree(join(KAFU_DIR, entry));
  }
  const users = join(KAFU_DIR, "users");
  await mkdir(users, { recursive: true });
  await rootOnly(users, 0o711);
  for (const id of await readdir(users)) {
    const dir = join(users, id);
    await rootOnly(dir, 0o711);
    for (const entry of await readdir(dir)) {
      if (entry === "claude" || entry === "home") continue;
      await lockTree(join(dir, entry));
    }
  }
}

export function protectedRepos(): string[] {
  return getSettings().multiUser.protectedRepos;
}

export function guardHookCommand(repos: string[], runtime = process.execPath, script = join(import.meta.dir, "guard.ts")): string {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return [runtime, script, "guard", ...repos.flatMap((r) => ["--repo", r])].map(quote).join(" ");
}

export function guardSettings(repos: string[], runtime?: string, script?: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: guardHookCommand(repos, runtime, script), timeout: 15 }] }],
    },
  };
}

export async function writeManagedSettings(repos: string[]): Promise<void> {
  const settings = { ...guardSettings(repos), allowManagedHooksOnly: true };
  await mkdir(dirname(MANAGED_SETTINGS), { recursive: true });
  await writeFile(MANAGED_SETTINGS, JSON.stringify(settings, null, 2) + "\n", { mode: 0o644 });
  await chown(MANAGED_SETTINGS, 0, 0);
  await chmod(MANAGED_SETTINGS, 0o644);
  await chown(dirname(MANAGED_SETTINGS), 0, 0);
  await chmod(dirname(MANAGED_SETTINGS), 0o755);
}
