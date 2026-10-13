import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export interface GuardInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface GuardContext {
  repos: string[];
  env: Record<string, string | undefined>;
  remotesOf: (dir: string) => string[];
}

const MEMORY_NAME = /(^|\/)(CLAUDE|CLAUDE\.local)\.md$/i;
const PUBLISH = /\bgit\b[^;&|\n]*\bpush\b|\bgh\s+(pr|api|release|issue|workflow|run)\b|\bgh\s+repo\s+(edit|delete|rename|archive|sync|fork|set-default)\b/i;
const NETWORK_WRITE = /\bgit\b[^;&|\n]*\bpush\b|\bgh\b|\bcurl\b|\bwget\b|\bhttpie?\b|\bfetch\s*\(|\brequests\.|\burllib\b|\baxios\b|\bgraphql\b/i;
const FILE_WRITE = />>?|\btee\b|\bcp\b|\bmv\b|\brm\b|\bln\b|\bsed\s+-i|\bperl\s+-[a-z]*i|\btruncate\b|\binstall\b|\brsync\b|\bdd\b|\bchmod\b|\bchown\b|\btouch\b|\bpython3?\b|\bnode\b|\bbun\b|\bruby\b|\bperl\b|\bwrite/i;
const MEMORY_REF = /CLAUDE(\.local)?\.md|\/\.claude\/|\.claude\b|CLAUDE_CONFIG_DIR|managed-settings/i;

function slugPattern(repo: string): RegExp {
  const [owner, name] = repo.split("/").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|[^\\w.-])${owner}(/|%2f|\\s*[,:]\\s*["']?)${name}(\\.git)?([^\\w.-]|$)`, "i");
}

function mentionsRepo(text: string, repos: string[]): string | null {
  return repos.find((r) => slugPattern(r).test(text)) ?? null;
}

function candidateDirs(command: string, cwd: string): string[] {
  const dirs = new Set<string>([cwd]);
  for (const m of command.matchAll(/\bcd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) dirs.add(m[2] ?? m[3] ?? m[4]);
  for (const m of command.matchAll(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) dirs.add(m[2] ?? m[3] ?? m[4]);
  for (const m of command.matchAll(/(?:--dir|--cwd|--git-dir|--work-tree)[=\s]+("([^"]+)"|'([^']+)'|([^\s;&|]+))/g)) dirs.add(m[2] ?? m[3] ?? m[4]);
  return [...dirs].map((d) => (isAbsolute(d) ? d : resolve(cwd, d.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))));
}

function protectedRoots(env: Record<string, string | undefined>): string[] {
  const roots: string[] = [];
  if (env.CLAUDE_CONFIG_DIR) roots.push(resolve(env.CLAUDE_CONFIG_DIR));
  if (env.HOME) roots.push(resolve(env.HOME, ".claude"));
  roots.push("/etc/claude-code");
  return roots;
}

function isMemoryPath(path: string, cwd: string, env: Record<string, string | undefined>): boolean {
  const full = resolve(cwd, path);
  if (protectedRoots(env).some((root) => full === root || full.startsWith(root + sep))) return true;
  const workDir = env.KAFU_WORKDIR ? resolve(env.KAFU_WORKDIR) : null;
  if (workDir) {
    const rel = full.startsWith(workDir + sep) ? full.slice(workDir.length + 1) : null;
    if (rel !== null && (/^(CLAUDE|CLAUDE\.local)\.md$/i.test(rel) || rel === ".claude" || rel.startsWith(".claude/") || rel === ".mcp.json")) return true;
    if (!full.startsWith(workDir + sep) && MEMORY_NAME.test(full)) return true;
  }
  return false;
}

export function decide(input: GuardInput, ctx: GuardContext): string | null {
  const tool = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const cwd = input.cwd || process.cwd();
  const serialized = JSON.stringify(toolInput);

  if (tool === "Bash") {
    const command = String(toolInput.command ?? "");
    const repo = mentionsRepo(command, ctx.repos);
    if (repo && NETWORK_WRITE.test(command)) return `${repo} is protected: I can't push, open PRs, or call GitHub for it.`;
    if (PUBLISH.test(command)) {
      for (const dir of candidateDirs(command, cwd)) {
        if (!existsSync(dir)) continue;
        const hit = ctx.remotesOf(dir).map((url) => mentionsRepo(url, ctx.repos)).find(Boolean);
        if (hit) return `${hit} is protected: I can't push or open PRs for it.`;
      }
    }
    if (MEMORY_REF.test(command) && FILE_WRITE.test(command)) {
      return "My instruction files (CLAUDE.md, .claude settings) can't be changed from a chat.";
    }
    return null;
  }

  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const path = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
    if (path && isMemoryPath(path, cwd, ctx.env)) return "My instruction files (CLAUDE.md, .claude settings) can't be changed from a chat.";
    return null;
  }

  if (/github/i.test(tool)) {
    const repo = mentionsRepo(serialized, ctx.repos);
    if (repo) return `${repo} is protected: I can't change it.`;
  }
  return null;
}

function gitRemotes(dir: string): string[] {
  const out = Bun.spawnSync(["git", "-C", dir, "config", "--get-regexp", "^(remote\\..*\\.(url|pushurl)|url\\..*\\.(insteadof|pushinsteadof))$"], { stdout: "pipe", stderr: "ignore" });
  return out.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean);
}

async function main(argv: string[]): Promise<void> {
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--repo" && argv[i + 1]) repos.push(argv[++i]);
  let reason: string | null;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as GuardInput;
    reason = decide(input, { repos, env: process.env, remotesOf: gitRemotes });
  } catch (err) {
    reason = `Safety check failed (${err instanceof Error ? err.message : err}), so this action was blocked.`;
  }
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  }
}

if (import.meta.main) await main(process.argv.slice(2));
