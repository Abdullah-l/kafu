import { join } from "node:path";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { getSettings } from "./config";
import { getUser } from "./users";

const STATE_FILE = join(process.cwd(), ".claude", "kafu", "pr-cards.json");
const POLL_MS = 2 * 60_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;
export const PR_ACTION_PREFIX = "kafu_pr_";

export interface PrCard {
  id: string;
  owner: string;
  repo: string;
  number: number;
  channel: string;
  ts: string;
  createdAt: number;
  lastHash: string;
  done: boolean;
}

export interface PrSummary {
  url: string;
  title: string;
  repo: string;
  number: number;
  state: "draft" | "open" | "merged" | "closed";
  head: string;
  base: string;
  author: string;
  additions: number;
  deletions: number;
  files: number;
  checks: { passed: number; failed: number; running: number; failedNames: string[] };
  approvedBy: string[];
  changesRequestedBy: string[];
  waitingOn: string[];
  nodeId: string;
}

let cards: PrCard[] | null = null;
let saveChain: Promise<void> = Promise.resolve();
let poller: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<PrCard[]> {
  if (cards) return cards;
  try {
    cards = JSON.parse(await readFile(STATE_FILE, "utf8")) as PrCard[];
  } catch {
    cards = [];
  }
  return cards;
}

function save(): Promise<void> {
  saveChain = saveChain.then(async () => {
    await mkdir(join(process.cwd(), ".claude", "kafu"), { recursive: true });
    await writeFile(`${STATE_FILE}.tmp`, JSON.stringify(cards ?? [], null, 2) + "\n", { mode: 0o600 });
    await rename(`${STATE_FILE}.tmp`, STATE_FILE);
  }).catch(() => {});
  return saveChain;
}

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = String(url ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "kafu", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function githubToken(userId: string): Promise<string> {
  const token = (await getUser(userId))?.secrets.github;
  if (!token) throw new Error("connect GitHub first");
  return token;
}

export async function fetchPrSummary(token: string, repo: string, number: number): Promise<PrSummary> {
  const pr = await gh<any>(token, `/repos/${repo}/pulls/${number}`);
  const [runs, statuses, reviews] = await Promise.all([
    gh<{ check_runs: any[] }>(token, `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })),
    gh<{ statuses: any[] }>(token, `/repos/${repo}/commits/${pr.head.sha}/status`).catch(() => ({ statuses: [] })),
    gh<any[]>(token, `/repos/${repo}/pulls/${number}/reviews?per_page=100`).catch(() => []),
  ]);
  const checks = { passed: 0, failed: 0, running: 0, failedNames: [] as string[] };
  for (const run of runs.check_runs) {
    if (run.status !== "completed") checks.running++;
    else if (["success", "neutral", "skipped"].includes(run.conclusion)) checks.passed++;
    else {
      checks.failed++;
      checks.failedNames.push(run.name);
    }
  }
  for (const status of statuses.statuses) {
    if (status.state === "pending") checks.running++;
    else if (status.state === "success") checks.passed++;
    else {
      checks.failed++;
      checks.failedNames.push(status.context);
    }
  }
  const latest = new Map<string, string>();
  for (const review of reviews) if (review.state !== "COMMENTED" && review.user?.login) latest.set(review.user.login, review.state);
  const approvedBy = [...latest].filter(([, s]) => s === "APPROVED").map(([u]) => u);
  const changesRequestedBy = [...latest].filter(([, s]) => s === "CHANGES_REQUESTED").map(([u]) => u);
  const waitingOn = [
    ...(pr.requested_reviewers ?? []).map((r: any) => r.login),
    ...(pr.requested_teams ?? []).map((t: any) => `@${t.slug}`),
  ];
  return {
    url: pr.html_url,
    title: pr.title,
    repo,
    number,
    state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open",
    head: pr.head.ref,
    base: pr.base.ref,
    author: pr.user?.login ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    files: pr.changed_files ?? 0,
    checks,
    approvedBy,
    changesRequestedBy,
    waitingOn,
    nodeId: pr.node_id,
  };
}

function stateLine(s: PrSummary): string {
  return { draft: "📝 Draft", open: "👀 Ready for review", merged: "🟣 Merged", closed: "⛔ Closed" }[s.state];
}

function checksLine(s: PrSummary): string {
  const { passed, failed, running } = s.checks;
  if (passed + failed + running === 0) return "⚪ No checks";
  if (failed) return `❌ ${failed} failing${s.checks.failedNames.length ? ` (${s.checks.failedNames.slice(0, 3).join(", ")})` : ""}`;
  if (running) return `⏳ Checks running (${passed}/${passed + running} passed)`;
  return `✅ Checks passed (${passed})`;
}

function reviewLine(s: PrSummary): string {
  if (s.changesRequestedBy.length) return `🛑 Changes requested by ${s.changesRequestedBy.join(", ")}`;
  if (s.approvedBy.length) return `✅ Approved by ${s.approvedBy.join(", ")}${s.waitingOn.length ? `; waiting on ${s.waitingOn.join(", ")}` : ""}`;
  if (s.waitingOn.length) return `⌛ Waiting on ${s.waitingOn.join(", ")}`;
  return "⌛ No reviewers yet";
}

export function cardBlocks(s: PrSummary, cardId: string): Record<string, unknown>[] {
  const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: getSettings().timezone || "UTC" });
  const buttons: Record<string, unknown>[] = [{ type: "button", text: { type: "plain_text", text: "Open PR" }, url: s.url, action_id: `${PR_ACTION_PREFIX}open` }];
  if (s.state === "draft") buttons.push({ type: "button", text: { type: "plain_text", text: "Mark ready for review" }, style: "primary", action_id: `${PR_ACTION_PREFIX}ready`, value: cardId });
  if (s.state === "draft" || s.state === "open") buttons.push({ type: "button", text: { type: "plain_text", text: "Refresh" }, action_id: `${PR_ACTION_PREFIX}refresh`, value: cardId });
  return [
    { type: "section", text: { type: "mrkdwn", text: `*<${s.url}|${s.title.replace(/[<>&]/g, "")}>*\n\`${s.repo}\` #${s.number}   \`${s.head}\` → \`${s.base}\`   +${s.additions} −${s.deletions} in ${s.files} file${s.files === 1 ? "" : "s"}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${stateLine(s)}     ${checksLine(s)}     ${reviewLine(s)}` }] },
    { type: "actions", elements: buttons },
    { type: "context", elements: [{ type: "mrkdwn", text: `Updated ${time}${s.state === "merged" || s.state === "closed" ? "" : ", refreshes every couple of minutes"}` }] },
  ];
}

function hashOf(s: PrSummary): string {
  return JSON.stringify([s.state, s.title, s.checks, s.approvedBy, s.changesRequestedBy, s.waitingOn, s.additions, s.deletions, s.files]);
}

async function slack(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getSettings().slack.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as any;
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

export async function postPrCard(owner: string, prUrl: string, channel: string, threadTs?: string): Promise<{ channel: string; ts: string; state: string }> {
  const parsed = parsePrUrl(prUrl);
  if (!parsed) throw new Error("that isn't a GitHub pull request URL");
  if (getSettings().multiUser.protectedRepos.some((r) => r.toLowerCase() === parsed.repo.toLowerCase())) throw new Error(`${parsed.repo} is protected`);
  const summary = await fetchPrSummary(await githubToken(owner), parsed.repo, parsed.number);
  const id = `${parsed.repo}#${parsed.number}@${channel}:${Date.now().toString(36)}`;
  const sent = await slack("chat.postMessage", {
    channel,
    text: `${summary.title} (${summary.repo}#${summary.number})`,
    blocks: cardBlocks(summary, id),
    unfurl_links: false,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  const all = await load();
  all.push({ id, owner, repo: parsed.repo, number: parsed.number, channel: sent.channel, ts: sent.ts, createdAt: Date.now(), lastHash: hashOf(summary), done: summary.state === "merged" || summary.state === "closed" });
  await save();
  ensurePrCardPoller();
  return { channel: sent.channel, ts: sent.ts, state: summary.state };
}

async function refresh(card: PrCard, force = false): Promise<void> {
  const summary = await fetchPrSummary(await githubToken(card.owner), card.repo, card.number);
  const hash = hashOf(summary);
  if (force || hash !== card.lastHash) {
    await slack("chat.update", { channel: card.channel, ts: card.ts, text: `${summary.title} (${summary.repo}#${summary.number})`, blocks: cardBlocks(summary, card.id) });
    card.lastHash = hash;
  }
  card.done = summary.state === "merged" || summary.state === "closed";
}

export async function pollPrCards(): Promise<void> {
  const all = await load();
  for (const card of all) {
    if (card.done) continue;
    if (Date.now() - card.createdAt > MAX_AGE_MS) {
      card.done = true;
      continue;
    }
    await refresh(card).catch((err) => console.error(`[PR cards] ${card.repo}#${card.number}: ${err instanceof Error ? err.message : err}`));
  }
  cards = all.filter((c) => !c.done || Date.now() - c.createdAt < MAX_AGE_MS);
  await save();
}

export function ensurePrCardPoller(): void {
  if (poller) return;
  poller = setInterval(() => { void pollPrCards(); }, POLL_MS);
}

export async function handlePrCardAction(actionId: string, cardId: string, userId: string): Promise<string | null> {
  const card = (await load()).find((c) => c.id === cardId);
  if (!card) return "This card isn't tracked anymore.";
  if (actionId === `${PR_ACTION_PREFIX}refresh`) {
    await refresh(card, true);
    await save();
    return null;
  }
  if (actionId === `${PR_ACTION_PREFIX}ready`) {
    if (userId !== card.owner) return "Only the person who opened this PR through me can mark it ready.";
    const token = await githubToken(card.owner);
    const summary = await fetchPrSummary(token, card.repo, card.number);
    await gh(token, "/graphql", { method: "POST", body: JSON.stringify({ query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }", variables: { id: summary.nodeId } }) });
    await refresh(card, true);
    await save();
    console.log(`[${new Date().toLocaleTimeString()}] PR cards: ${userId} marked ${card.repo}#${card.number} ready`);
    return null;
  }
  return null;
}
