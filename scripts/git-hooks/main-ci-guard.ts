import { contractChecks, selectChecks } from "../ci/selection";

export type CiRunSummary = {
  id: number;
  head_sha: string;
  conclusion: string | null;
  display_title?: string;
  html_url?: string;
};

export type CiJobSummary = {
  name: string;
  conclusion: string | null;
};

export type MainCiStatus =
  | { state: "green" }
  | {
      state: "red";
      latestRun: CiRunSummary;
      firstRedRun: CiRunSummary;
      failedJobs: string[];
    };

export type RedMainDecision =
  | { allowed: true; reason?: string }
  | { allowed: false; message: string };

const FIX_MARKER = /(?:\[fix-ci\]|\[fix-main\]|^fix\(ci\):)/i;

/** Extracts `owner/repo` from a GitHub remote URL, or `null` for non-GitHub remotes. */
export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const match =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed) ??
    /^(?:ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2] };
}

/** Maps a GitHub Actions job name from `.github/workflows/ci.yml` to `selection.ts` check names. */
export function jobNameToChecks(jobName: string): string[] {
  if (jobName === "Plan checks") return ["ci"];
  if (jobName === "Validate scripts") return [...contractChecks];
  if (jobName === "Validate libraries") return ["agent", "anvil", "coforge", "coforge-sdk"];
  if (jobName === "Validate Computer") return ["computer"];
  if (jobName.startsWith("Validate Daemon")) return ["daemon"];
  if (jobName.startsWith("Validate Web")) return ["web"];
  if (jobName === "Test macOS lifecycle") return ["macos-lifecycle"];
  if (jobName.startsWith("Test Windows")) return ["windows-release"];
  if (jobName === "Check Windows installer") return ["windows-installer"];
  if (jobName.startsWith("Check installer")) return ["installer-crate"];
  return [];
}

/** Computes `MainCiStatus` from completed `main` push runs and the latest failed run's jobs. */
export function evaluateMainCiRuns(
  runs: CiRunSummary[],
  latestRunJobs: CiJobSummary[],
): MainCiStatus {
  const meaningful = runs.filter(
    (run) => run.conclusion && run.conclusion !== "cancelled" && run.conclusion !== "skipped",
  );
  const latest = meaningful[0];
  if (!latest || latest.conclusion === "success") return { state: "green" };

  let firstRedRun = latest;
  for (const run of meaningful) {
    if (run.conclusion === "success") break;
    firstRedRun = run;
  }

  const failedJobs = latestRunJobs
    .filter((job) => job.conclusion === "failure" || job.conclusion === "timed_out")
    .map((job) => job.name);

  return { state: "red", latestRun: latest, firstRedRun, failedJobs };
}

/** Fetches `main`'s latest completed CI status via `gh api`. Returns `null` if unavailable. */
export function fetchMainCiStatus(owner: string, repo: string): MainCiStatus | null {
  const runsRes = Bun.spawnSync(
    [
      "gh",
      "api",
      `repos/${owner}/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=10`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (runsRes.exitCode !== 0) return null;
  let runs: CiRunSummary[];
  try {
    const parsed = JSON.parse(runsRes.stdout.toString()) as { workflow_runs?: CiRunSummary[] };
    runs = parsed.workflow_runs ?? [];
  } catch {
    return null;
  }

  const initial = evaluateMainCiRuns(runs, []);
  if (initial.state === "green") return initial;

  const jobsRes = Bun.spawnSync(
    ["gh", "api", `repos/${owner}/${repo}/actions/runs/${initial.latestRun.id}/jobs?per_page=100`],
    { stdout: "pipe", stderr: "pipe" },
  );
  let jobs: CiJobSummary[] = [];
  if (jobsRes.exitCode === 0) {
    try {
      const parsed = JSON.parse(jobsRes.stdout.toString()) as { jobs?: CiJobSummary[] };
      jobs = parsed.jobs ?? [];
    } catch {
      jobs = [];
    }
  }
  return evaluateMainCiRuns(runs, jobs);
}

/**
 * Decides whether a push to `main` is allowed when `main` CI is red:
 * allowed only if a pushed commit subject carries a fix marker (`[fix-ci]`, `[fix-main]`,
 * `fix(ci):`) or the pushed diff touches files mapped to at least one failing job.
 */
export function decideRedMainPush(input: {
  status: MainCiStatus;
  commitSubjects: string[];
  changedFiles: string[];
}): RedMainDecision {
  if (input.status.state === "green") return { allowed: true };

  if (input.commitSubjects.some((subject) => FIX_MARKER.test(subject.trim()))) {
    return { allowed: true, reason: "commit title carries CI fix marker" };
  }

  const failedChecks = new Set(input.status.failedJobs.flatMap(jobNameToChecks));
  const touchedChecks = selectChecks(input.changedFiles, "changes");
  const matched = touchedChecks.filter((check) => failedChecks.has(check));
  if (matched.length > 0) {
    return { allowed: true, reason: `changes touch failing job scope (${matched.join(", ")})` };
  }

  const { firstRedRun, failedJobs } = input.status;
  const jobList = failedJobs.length > 0 ? failedJobs.join(", ") : "(unknown job)";
  const title = firstRedRun.display_title ? ` (${firstRedRun.display_title})` : "";
  const url = firstRedRun.html_url ? `\n  run: ${firstRedRun.html_url}` : "";
  return {
    allowed: false,
    message:
      `pre-push: main CI is currently RED; fix main before pushing other changes.\n` +
      `  failed job(s): ${jobList}\n` +
      `  first red commit: ${firstRedRun.head_sha}${title}${url}\n` +
      `  To push a fix for this failure, include [fix-ci] in the commit title or touch files for the failing job.`,
  };
}
