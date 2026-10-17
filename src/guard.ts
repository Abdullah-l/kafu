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
  currentBranch?: (dir: string) => string;
}

const PROTECTED_BRANCH = /^(develop|main|master)$/;
const MERGE_REASON = "Merging is done by people on GitHub after review; I can open and update PRs but not merge them.";
const SETTINGS_REASON = "I can't change repository or organization settings, secrets, workflows or releases; ask someone with access to do it on GitHub.";
const BRANCH_REASON = "I can't push to or delete develop, main or master; I push my own branch and open a PR instead.";
const ALLOWED_MUTATIONS = new Set([
  "addComment", "addPullRequestReview", "addPullRequestReviewComment", "addPullRequestReviewThread", "submitPullRequestReview",
  "createPullRequest", "updatePullRequest", "markPullRequestReadyForReview", "convertPullRequestToDraft", "requestReviews",
  "resolveReviewThread", "unresolveReviewThread", "updatePullRequestBranch", "addReaction", "removeReaction",
]);
const PR_WRITE_PATH = /^\/?repos\/[^/\s]+\/[^/\s]+\/(pulls|issues)(\/\d+)?(\/(comments|reviews|requested_reviewers|labels|assignees|reactions|replies)(\/[^\s]*)?)?$|^\/?repos\/[^/\s]+\/[^/\s]+\/(pulls|issues)\/comments\/\d+(\/(reactions|replies))?$/;

function splitCommands(command: string): string[] {
  return command.split(/&&|\|\||;|\n|\|/).map((s) => s.trim()).filter(Boolean);
}

function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function ghApiReason(segment: string): string | null {
  const w = words(segment);
  const at = w.findIndex((x, i) => x === "api" && w[i - 1]?.endsWith("gh"));
  if (at < 0) return null;
  const args = w.slice(at + 1);
  const valueFlags = new Set(["-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "--input", "--hostname", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);
  let method = "";
  let hasFields = false;
  let path = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") method = (args[i + 1] ?? "").toUpperCase();
    else if (/^--method=/.test(a)) method = a.split("=")[1].toUpperCase();
    else if (/^-X[A-Z]+$/.test(a)) method = a.slice(2).toUpperCase();
    if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(field|raw-field|input)=/.test(a)) hasFields = true;
    if (valueFlags.has(a)) { i++; continue; }
    if (!a.startsWith("-") && !path) path = a;
  }
  const effective = method || (hasFields ? "POST" : "GET");
  if (/^\/?graphql$/.test(path)) {
    if (!/mutation/i.test(segment)) return null;
    const names = [...segment.matchAll(/(?:mutation[^{]*\{|\}\s*)\s*(\w+)\s*\(/g)].map((m) => m[1]);
    if (names.length === 0 || names.some((n) => !ALLOWED_MUTATIONS.has(n))) return SETTINGS_REASON;
    return null;
  }
  if (effective === "GET") return null;
  if (/\/merge(\b|$)/.test(path)) return MERGE_REASON;
  if (PR_WRITE_PATH.test(path.replace(/\?.*$/, ""))) return null;
  return SETTINGS_REASON;
}

function gitPushReason(segment: string, cwd: string, ctx: GuardContext): string | null {
  const w = words(segment);
  const at = w.indexOf("push");
  if (at < 0 || !w.slice(0, at).some((x) => x === "git" || x.endsWith("/git"))) return null;
  const args = w.slice(at + 1);
  if (args.some((a) => ["--delete", "-d", "--mirror", "--all", "--tags", "--prune"].includes(a))) return BRANCH_REASON;
  const positional = args.filter((a) => !a.startsWith("-"));
  const refspecs = positional.slice(1);
  const branchOf = (spec: string): string => spec.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");
  for (const spec of refspecs) {
    if (spec.startsWith(":") || spec.startsWith("+:")) return BRANCH_REASON;
    const target = branchOf(spec);
    if (target === "HEAD") {
      for (const dir of candidateDirs(segment, cwd)) if (PROTECTED_BRANCH.test(ctx.currentBranch?.(dir) ?? "")) return BRANCH_REASON;
    } else if (PROTECTED_BRANCH.test(target)) return BRANCH_REASON;
  }
  if (refspecs.length === 0) {
    for (const dir of candidateDirs(segment, cwd)) {
      if (!existsSync(dir)) continue;
      if (PROTECTED_BRANCH.test(ctx.currentBranch?.(dir) ?? "")) return BRANCH_REASON;
    }
  }
  return null;
}

export function githubPolicy(command: string, cwd: string, ctx: GuardContext): string | null {
  for (const segment of splitCommands(command)) {
    if (/\bgh\s+pr\s+merge\b/.test(segment)) return MERGE_REASON;
    if (/\bgh\s+repo\s+(edit|delete|archive|unarchive|rename|deploy-key|set-default|sync|autolink)\b/.test(segment)) return SETTINGS_REASON;
    if (/\bgh\s+(secret|variable|ruleset|ssh-key|gpg-key|org|codespace|attestation)\b/.test(segment)) return SETTINGS_REASON;
    if (/\bgh\s+(workflow\s+(run|enable|disable)|run\s+(rerun|cancel|delete)|release\s+(create|delete|edit|upload|delete-asset)|cache\s+delete|label\s+(create|edit|delete|clone))\b/.test(segment)) return SETTINGS_REASON;
    const api = ghApiReason(segment);
    if (api) return api;
    if (/\b(curl|wget|http)\b/.test(segment) && /api\.github\.com|github\.com\/api/.test(segment) && /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|\s-d\s|--data|--method=(POST|PUT|PATCH|DELETE))/i.test(segment)) {
      return "Use gh for GitHub changes so the usual checks apply.";
    }
    const push = gitPushReason(segment, cwd, ctx);
    if (push) return push;
  }
  return null;
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
    const policy = githubPolicy(command, cwd, ctx);
    if (policy) return policy;
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

function gitBranch(dir: string): string {
  const out = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return out.exitCode === 0 ? out.stdout.toString().trim() : "";
}

async function main(argv: string[]): Promise<void> {
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--repo" && argv[i + 1]) repos.push(argv[++i]);
  let reason: string | null;
  try {
    const input = JSON.parse(await Bun.stdin.text()) as GuardInput;
    reason = decide(input, { repos, env: process.env, remotesOf: gitRemotes, currentBranch: gitBranch });
  } catch (err) {
    reason = `Safety check failed (${err instanceof Error ? err.message : err}), so this action was blocked.`;
  }
  if (reason) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  }
}

if (import.meta.main) await main(process.argv.slice(2));
