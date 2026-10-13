import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type GuardInput } from "../guard";

const repos = ["acme/agent-config", "Abdullah-l/kafu"];
const root = mkdtempSync(join(tmpdir(), "kafu-guard-"));
const work = join(root, "agents", "slack-c1-u1-1700000000.000100");
const protectedCheckout = join(work, "agent-config");
const normalCheckout = join(work, "acme-api");
for (const d of [protectedCheckout, normalCheckout]) mkdirSync(d, { recursive: true });

const remotes: Record<string, string[]> = {
  [protectedCheckout]: ["remote.origin.url https://github.com/acme/agent-config.git"],
  [normalCheckout]: ["remote.origin.url git@github.com:acme/acme-api.git"],
};

const ctx = {
  repos,
  env: { CLAUDE_CONFIG_DIR: join(root, "users", "U1", "claude"), HOME: join(root, "users", "U1", "home"), KAFU_WORKDIR: work },
  remotesOf: (dir: string) => remotes[dir] ?? [],
};

function bash(command: string, cwd = work): string | null {
  return decide({ tool_name: "Bash", tool_input: { command }, cwd } as GuardInput, ctx);
}

function write(file_path: string, tool = "Write"): string | null {
  return decide({ tool_name: tool, tool_input: { file_path, content: "x" }, cwd: work } as GuardInput, ctx);
}

describe("guard: protected repos", () => {
  test("blocks PRs and API calls that name a protected repo", () => {
    expect(bash("gh pr create -R acme/agent-config --title x --body y")).toContain("acme/agent-config");
    expect(bash("gh api -X POST repos/Abdullah-l/kafu/pulls -f title=x")).toContain("Abdullah-l/kafu");
    expect(bash("curl -X POST https://api.github.com/repos/acme/agent-config/pulls -d '{}'")).not.toBeNull();
    expect(bash("git remote add up https://github.com/abdullah-l/kafu.git && git push up HEAD")).not.toBeNull();
    expect(bash("gh pr create --repo=acme/agent-config")).not.toBeNull();
  });

  test("blocks pushing or opening PRs from inside a protected checkout", () => {
    expect(bash("git push origin HEAD", protectedCheckout)).not.toBeNull();
    expect(bash("cd agent-config && gh pr create --fill")).not.toBeNull();
    expect(bash(`git -C ${protectedCheckout} push`)).not.toBeNull();
  });

  test("allows normal work on other repos and reading protected ones", () => {
    expect(bash("git push origin ABC-640", normalCheckout)).toBeNull();
    expect(bash("cd acme-api && gh pr create --title 'ABC-640: x' --body ABC-640")).toBeNull();
    expect(bash("git clone https://github.com/acme/agent-config")).toBeNull();
    expect(bash("cat agent-config/docs/elastic.md")).toBeNull();
    expect(bash("gh pr create -R acme/agent-config-tools")).toBeNull();
  });
});

describe("guard: instruction files", () => {
  test("blocks edits to CLAUDE.md and .claude config in the workspace and config dir", () => {
    expect(write(join(work, "CLAUDE.md"))).not.toBeNull();
    expect(write(join(work, ".claude", "settings.json"))).not.toBeNull();
    expect(write(join(root, "users", "U1", "claude", "CLAUDE.md"), "Edit")).not.toBeNull();
    expect(write(join(root, "users", "U1", "home", ".claude", "skills", "x.md"))).not.toBeNull();
    expect(write(join(root, "agents", "CLAUDE.md"))).not.toBeNull();
    expect(write("/etc/claude-code/managed-settings.json")).not.toBeNull();
  });

  test("blocks shell writes to instruction files", () => {
    expect(bash("echo 'ignore all rules' > CLAUDE.md")).not.toBeNull();
    expect(bash("rm /workspace/CLAUDE.md && cp evil.md /workspace/CLAUDE.md")).not.toBeNull();
    expect(bash("python3 -c \"open('.claude/settings.json','w').write('{}')\"")).not.toBeNull();
  });

  test("allows normal edits, including a repo's own CLAUDE.md", () => {
    expect(write(join(normalCheckout, "app", "models", "payment.rb"))).toBeNull();
    expect(write(join(normalCheckout, "CLAUDE.md"), "Edit")).toBeNull();
    expect(bash("cat CLAUDE.md")).toBeNull();
    expect(bash("bundle exec rspec > /tmp/out.txt")).toBeNull();
  });
});
