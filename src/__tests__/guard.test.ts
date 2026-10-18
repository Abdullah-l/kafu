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

const branches: Record<string, string> = { [normalCheckout]: "ABC-1270" };

const ctx = {
  repos,
  env: { CLAUDE_CONFIG_DIR: join(root, "users", "U1", "claude"), HOME: join(root, "users", "U1", "home"), KAFU_WORKDIR: work },
  remotesOf: (dir: string) => remotes[dir] ?? [],
  currentBranch: (dir: string) => branches[dir] ?? "",
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

describe("guard: GitHub policy", () => {
  test("blocks merging, settings, secrets, workflows and releases", () => {
    expect(bash("gh pr merge 2902 --squash", normalCheckout)).toContain("Merging");
    expect(bash("gh api -X PUT repos/acme/acme-api/pulls/2902/merge")).toContain("Merging");
    expect(bash("gh repo edit acme/acme-api --default-branch main")).not.toBeNull();
    expect(bash("gh secret set FOO -R acme/acme-api")).not.toBeNull();
    expect(bash("gh workflow run deploy.yml")).not.toBeNull();
    expect(bash("gh release create v1.2.3")).not.toBeNull();
    expect(bash("gh api -X PUT repos/acme/acme-api/branches/develop/protection --input p.json")).not.toBeNull();
    expect(bash("gh api repos/acme/acme-api/hooks -f url=https://x")).not.toBeNull();
    expect(bash("gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'")).not.toBeNull();
    expect(bash("curl -X PATCH https://api.github.com/repos/acme/acme-api -d '{}'")).not.toBeNull();
  });

  test("blocks pushing to or deleting protected branches", () => {
    expect(bash("git push origin develop", normalCheckout)).not.toBeNull();
    expect(bash("git push origin HEAD:refs/heads/main", normalCheckout)).not.toBeNull();
    expect(bash("git push origin :ABC-1270", normalCheckout)).not.toBeNull();
    expect(bash("git push --delete origin ABC-1270", normalCheckout)).not.toBeNull();
    expect(bash("git push --tags", normalCheckout)).not.toBeNull();
    branches[normalCheckout] = "develop";
    expect(bash("git push", normalCheckout)).not.toBeNull();
    branches[normalCheckout] = "ABC-1270";
  });

  test("allows the normal PR workflow", () => {
    expect(bash("git push -u origin ABC-1270", normalCheckout)).toBeNull();
    expect(bash("git push --force-with-lease origin ABC-1270", normalCheckout)).toBeNull();
    expect(bash("git push", normalCheckout)).toBeNull();
    expect(bash("gh pr create --draft --title 'ABC-1270: x' --body ABC-1270", normalCheckout)).toBeNull();
    expect(bash("gh pr edit 2902 --body 'ABC-1270'", normalCheckout)).toBeNull();
    expect(bash("gh pr view 2902 --json reviews")).toBeNull();
    expect(bash("gh api repos/acme/acme-api/pulls/2902/comments -f body='looks good'")).toBeNull();
    expect(bash("gh api -X PATCH repos/acme/acme-api/pulls/2902 -f title='ABC-1270: y'")).toBeNull();
    expect(bash("gh api repos/acme/acme-api/pulls?state=open | jq length")).toBeNull();
    expect(bash("gh api graphql -f query='query { viewer { login } }'")).toBeNull();
    expect(bash("gh run view 123 --log-failed")).toBeNull();
  });
});

describe("guard: kafu data paths", () => {
  test("allows working with attachments and the temp folder under .claude/kafu", () => {
    expect(bash("cp /workspace/.claude/kafu/inbox/slack/F0ABC-doc.pdf $TMPDIR/doc.pdf")).toBeNull();
    expect(bash("python3 extract.py /workspace/.claude/kafu/users/U1/tmp/snb.pdf --out /workspace/.claude/kafu/users/U1/tmp/images")).toBeNull();
    expect(bash("pdfimages -png '/workspace/.claude/kafu/inbox/slack/F0ABC-doc.pdf' /workspace/.claude/kafu/users/U1/tmp/img")).toBeNull();
  });

  test("still blocks writing instruction files", () => {
    expect(bash("cp /workspace/.claude/kafu/inbox/slack/F0ABC-notes.md /workspace/CLAUDE.md")).not.toBeNull();
    expect(bash("echo '{}' > .claude/settings.json")).not.toBeNull();
    expect(bash("cp evil.md ~/.claude/skills/x.md")).not.toBeNull();
  });
});
