import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, type GuardInput } from "../guard";

const repos = ["acme/agent-config", "Abdullah-l/kafu"];
const root = mkdtempSync(join(tmpdir(), "kafu-guard-"));
const work = join(root, "agents", "slack-c1-u1-1700000000.000100");
const protectedCheckout = join(work, "agent-config");
const normalCheckout = join(work, "acme-api");
const tmp = join(root, "users", "U1", "tmp");
const tmpCheckout = join(tmp, "acme-api");
for (const d of [protectedCheckout, normalCheckout, join(tmpCheckout, ".git"), join(root, "users", "U1", "home", ".claude")]) mkdirSync(d, { recursive: true });
symlinkSync(work, join(tmpCheckout, "thread"));
symlinkSync(join(root, "users", "U1", "home"), join(tmpCheckout, "home"));

const remotes: Record<string, string[]> = {
  [protectedCheckout]: ["remote.origin.url https://github.com/acme/agent-config.git"],
  [normalCheckout]: ["remote.origin.url git@github.com:acme/acme-api.git"],
};

const branches: Record<string, string> = { [normalCheckout]: "ABC-1270" };

const ctx = {
  repos,
  env: { CLAUDE_CONFIG_DIR: join(root, "users", "U1", "claude"), HOME: join(root, "users", "U1", "home"), KAFU_WORKDIR: work, TMPDIR: tmp },
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

  test("allows a repo's CLAUDE.md in a checkout under the temp folder", () => {
    expect(write(join(tmpCheckout, "CLAUDE.md"), "Edit")).toBeNull();
    expect(write(join(tmpCheckout, "docs", "CLAUDE.md"))).toBeNull();
  });

  test("blocks CLAUDE.md in the temp folder outside a checkout, and through symlinks", () => {
    expect(write(join(tmp, "CLAUDE.md"))).not.toBeNull();
    expect(write(join(tmpCheckout, "thread", "CLAUDE.md"))).not.toBeNull();
    expect(write(join(tmpCheckout, "thread", ".claude", "settings.json"))).not.toBeNull();
    expect(write(join(tmpCheckout, "home", ".claude", "CLAUDE.md"))).not.toBeNull();
    expect(write(join(root, "agents", "other-thread", "CLAUDE.md"))).not.toBeNull();
  });

  test("allows committing and opening PRs that mention instruction files", () => {
    expect(bash('git add CLAUDE.md && git commit -m "ABC-1: Update CLAUDE.md" 2>&1')).toBeNull();
    expect(bash('gh pr create --title "ABC-1: Tell the bot to write tests in CLAUDE.md" --body "ABC-1" 2>&1')).toBeNull();
    expect(bash("git commit -m \"$(cat <<'EOF'\nABC-1: Install hooks from .claude settings\nEOF\n)\" > /dev/null")).toBeNull();
  });

  test("still blocks writes hidden next to commit messages", () => {
    expect(bash('git commit -m "$(echo x > CLAUDE.md)"')).not.toBeNull();
    expect(bash("git commit -m 'x' && echo y > CLAUDE.md 2>&1")).not.toBeNull();
    expect(bash("cp -t '.claude' evil.json")).not.toBeNull();
    expect(bash("bash <<'EOF'\necho x > CLAUDE.md\nEOF")).not.toBeNull();
    expect(bash("echo x > /dev/null/../../CLAUDE.md")).not.toBeNull();
    expect(bash("git commit -m \"$(cat <<EOF\n$(cp evil.md CLAUDE.md)\nEOF\n)\"")).not.toBeNull();
  });
});

describe("guard: a cloned repo's CLAUDE.md", () => {
  test("allows shell edits to CLAUDE.md inside a checkout", () => {
    expect(bash("sed -i 's/Bobby/Alice/' CLAUDE.md", normalCheckout)).toBeNull();
    expect(bash("cd acme-api && sed -i 's/Bobby/Alice/' CLAUDE.md")).toBeNull();
    expect(bash(`sed -i 's/Bobby/Alice/' ${join(normalCheckout, "CLAUDE.md")}`)).toBeNull();
    expect(bash("python3 fix.py docs/CLAUDE.md", normalCheckout)).toBeNull();
    expect(bash("cp notes.md CLAUDE.md", tmpCheckout)).toBeNull();
  });

  test("still blocks the live files and anything it can't follow", () => {
    expect(bash("sed -i 's/Bobby/Alice/' CLAUDE.md")).not.toBeNull();
    expect(bash("sed -i 's/x/y/' ../CLAUDE.md", normalCheckout)).not.toBeNull();
    expect(bash("cd acme-api && cd .. && echo x > CLAUDE.md")).not.toBeNull();
    expect(bash("(cd acme-api) && echo x > CLAUDE.md")).not.toBeNull();
    expect(bash("cd $HOME && echo x > CLAUDE.md", normalCheckout)).not.toBeNull();
    expect(bash("bash -c 'cd .. && echo x > CLAUDE.md'", normalCheckout)).not.toBeNull();
    expect(bash("echo x > .claude/settings.json", normalCheckout)).not.toBeNull();
    expect(bash(`cp CLAUDE.md ${join(work, "CLAUDE.md")}`, normalCheckout)).not.toBeNull();
    expect(bash(`echo x > ${join(root, "users", "U1", "claude", "CLAUDE.md")}`, normalCheckout)).not.toBeNull();
    expect(bash("echo x > thread/CLAUDE.md", tmpCheckout)).not.toBeNull();
    expect(bash("git -C .. commit -m x && echo x > CLAUDE.md", normalCheckout)).not.toBeNull();
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

  test("blocks skipping the pre-push hook", () => {
    expect(bash("git push --no-verify origin ABC-1270", normalCheckout)).toContain("git hooks");
    expect(bash("git -c core.hooksPath=/dev/null push origin ABC-1270", normalCheckout)).not.toBeNull();
    expect(bash("git config --global core.hooksPath ~/hooks")).not.toBeNull();
    expect(bash("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp git push", normalCheckout)).not.toBeNull();
    expect(bash("git push -n origin ABC-1270", normalCheckout)).toBeNull();
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

describe("guard: quoted commands", () => {
  test("sees through quotes and escapes", () => {
    expect(bash("git push origin ma''in", normalCheckout)).not.toBeNull();
    expect(bash('git push origin "$(echo main)"', normalCheckout)).not.toBeNull();
    expect(bash("gh pr mer''ge 5")).not.toBeNull();
    expect(bash("cd agent-config && g''it pu''sh origin feature")).not.toBeNull();
    expect(bash("git push origin m\\ain", normalCheckout)).not.toBeNull();
  });

  test("still allows normal pushes and messages that mention pushing", () => {
    expect(bash("git push -u origin ABC-1270", normalCheckout)).toBeNull();
    expect(bash('git commit -m "ABC-1270: Don\'t push on retries"', normalCheckout)).toBeNull();
    expect(bash("git -C . push origin HEAD", normalCheckout)).toBeNull();
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
