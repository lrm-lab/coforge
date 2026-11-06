#!/usr/bin/env bun
/**
 * Release CI health (task #592, docs/release/github-actions.md): what a production
 * release may lean on when it skips staging evidence.
 *
 * Always records the latest completed web-e2e and web-integration runs on main in
 * the step summary — informational only; those suites never block a release.
 *
 * With --commit, finds the commit's ci.yml verdict: the earliest main push run whose
 * head_sha descends from the commit. A push run covers every commit it carried, so a
 * commit that was not a push tip has no run of its own; the covering run is the first
 * CI verdict on a tree containing it. `success` passes; any other completed
 * conclusion, or a run still in progress, refuses the release. A commit no scanned
 * run covers (docs-only, or older than the scan window) passes with a note.
 * `--allow-red --reason` bypasses a non-green verdict; the reason is required and
 * the bypass is announced by ::warning:: and the step summary.
 *
 *   bun scripts/release/release-health.ts [--commit <40-hex>] [--allow-red] [--reason <text>]
 *
 * env: GH_TOKEN or GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY. Git ancestry
 * is read from the checkout the calling job made (fetch-depth: 0).
 */
const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const CI_WORKFLOW = "ci.yml";
const INFO_WORKFLOWS = ["web-e2e.yml", "web-integration.yml"];
const RUN_WINDOW = 100;
const COMMIT_SHAPE = /^[0-9a-f]{40}$/;

export interface WorkflowRun {
  id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

export interface ReleaseHealthResult {
  ok: boolean;
  /** Whether a --commit verdict was produced at all. */
  commitChecked: boolean;
  /** green | red | running | none | error */
  verdict?: string;
  /** One-line human detail for the log. */
  detail: string;
  /** Bypass notices, each emitted as ::warning:: by the caller. */
  warnings: string[];
  /** Markdown lines appended to GITHUB_STEP_SUMMARY. */
  summary: string[];
}

export interface ReleaseHealthOptions {
  repo: string;
  token: string;
  commit?: string;
  allowRed?: boolean;
  reason?: string;
  fetchImpl?: typeof fetch;
  isAncestor?: (ancestor: string, descendant: string) => boolean;
}

async function listRuns(
  repo: string,
  workflow: string,
  query: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<WorkflowRun[]> {
  const response = await fetchImpl(
    `${API}/repos/${repo}/actions/workflows/${workflow}/runs?${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
      },
    },
  );
  if (!response.ok) throw new Error(`${workflow} runs: HTTP ${response.status}`);
  const body = (await response.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs ?? [];
}

/** The ci.yml run that first judged a tree containing `commit`: the match with the
 * oldest created_at among main push runs whose head_sha descends from it. */
export function coveringRun(
  runs: WorkflowRun[],
  commit: string,
  isAncestor: (ancestor: string, descendant: string) => boolean,
): WorkflowRun | undefined {
  const seen = new Map<string, boolean>();
  const descends = (head: string) => {
    const cached = seen.get(head);
    if (cached !== undefined) return cached;
    const result = isAncestor(commit, head);
    seen.set(head, result);
    return result;
  };
  let covering: WorkflowRun | undefined;
  for (const candidate of runs) {
    if (!descends(candidate.head_sha)) continue;
    if (!covering || candidate.created_at < covering.created_at) covering = candidate;
  }
  return covering;
}

const gitIsAncestor = (ancestor: string, descendant: string) =>
  Bun.spawnSync(["git", "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;

function ciVerdict(run: WorkflowRun | undefined): {
  ok: boolean;
  verdict: string;
  detail: string;
} {
  if (!run) {
    return {
      ok: true,
      verdict: "none",
      detail: "no ci.yml run on main covers this commit",
    };
  }
  if (run.status !== "completed") {
    return {
      ok: false,
      verdict: "running",
      detail: `ci.yml run ${run.id} is still ${run.status}: ${run.html_url}`,
    };
  }
  if (run.conclusion === "success") {
    return {
      ok: true,
      verdict: "green",
      detail: `ci.yml run ${run.id} succeeded: ${run.html_url}`,
    };
  }
  return {
    ok: false,
    verdict: "red",
    detail: `ci.yml run ${run.id} concluded ${run.conclusion}: ${run.html_url}`,
  };
}

const short = (shaText: string) => shaText.slice(0, 9);

async function suiteLine(
  repo: string,
  workflow: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  try {
    const runs = await listRuns(
      repo,
      workflow,
      "branch=main&status=completed&per_page=1",
      token,
      fetchImpl,
    );
    const latest = runs[0];
    if (!latest) return `- \`${workflow}\`: no completed run on main`;
    return `- \`${workflow}\`: ${latest.conclusion} at ${short(latest.head_sha)} (${latest.created_at}) — ${latest.html_url}`;
  } catch {
    return `- \`${workflow}\`: latest run unavailable`;
  }
}

export async function checkReleaseHealth(
  options: ReleaseHealthOptions,
): Promise<ReleaseHealthResult> {
  const { repo, token } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const isAncestor = options.isAncestor ?? gitIsAncestor;
  const summary: string[] = [];
  const warnings: string[] = [];

  if (options.commit !== undefined && !COMMIT_SHAPE.test(options.commit)) {
    throw new Error(`commit must be a full commit, 40 lowercase hex characters`);
  }

  let commitChecked = false;
  let ok = true;
  let verdict: string | undefined;
  let detail = "";

  if (options.commit !== undefined) {
    commitChecked = true;
    const runs = await listRuns(
      repo,
      CI_WORKFLOW,
      `branch=main&event=push&per_page=${RUN_WINDOW}`,
      token,
      fetchImpl,
    );
    const covering = coveringRun(runs, options.commit, isAncestor);
    const judged = ciVerdict(covering);
    verdict = judged.verdict;
    detail = judged.detail;
    ok = judged.ok;

    if (!judged.ok && options.allowRed) {
      const reason = options.reason?.trim();
      if (!reason) {
        ok = false;
        detail = "allow_red_main requires a non-empty ci_override_reason";
      } else {
        ok = true;
        warnings.push(
          `CI health bypassed for ${short(options.commit)}: ${reason} (ci.yml verdict: ${judged.detail})`,
        );
        summary.push(`- Bypass: ${reason}`);
      }
    }
    summary.push(
      `- Commit \`${short(options.commit)}\`: ci.yml ${verdict === "none" ? "has no covering run" : `run verdict ${verdict}`} — ${detail}`,
    );
  }

  const suites = await Promise.all(
    INFO_WORKFLOWS.map((workflow) => suiteLine(repo, workflow, token, fetchImpl)),
  );
  summary.push("", "## Scheduled suites (informational — they never block a release)", ...suites);

  return { ok, commitChecked, verdict, detail, warnings, summary };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const commit = take("--commit");
  const allowRed = args.includes("--allow-red");
  const reason = take("--reason");
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.error("release-health: GITHUB_REPOSITORY and GH_TOKEN/GITHUB_TOKEN are required");
    return 2;
  }

  let result: ReleaseHealthResult;
  try {
    result = await checkReleaseHealth({ repo, token, commit, allowRed, reason });
  } catch (error) {
    console.error(`release-health: ${error instanceof Error ? error.message : error}`);
    return 2;
  }

  for (const warning of result.warnings) console.log(`::warning::${warning}`);
  if (result.detail) console.log(result.detail);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath && result.summary.length > 0) {
    const existing = await Bun.file(summaryPath)
      .text()
      .catch(() => "");
    await Bun.write(summaryPath, `${existing}${result.summary.join("\n")}\n\n`).catch(() => {});
  }
  if (!result.ok) {
    console.error(`release-health: ${result.detail}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
