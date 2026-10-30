// Downloads the latest production catalog snapshot with the GitHub CLI, in CI only: the newest
// unexpired `catalog-snapshot-production` artifact from a run on main (the Deploy workflows upload
// it after a healthy deploy). Returns the file's path, or undefined when there is none (no token, a
// fork's pull request, nothing uploaded yet or all expired).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "catalog-snapshot-production";
const NEWEST_ON_MAIN = `[.artifacts[] | select(.expired | not) | select(.workflow_run.head_branch == "main")] | sort_by(.created_at) | reverse | .[0].workflow_run.id // empty`;

export function downloadLatestSnapshot(env: NodeJS.ProcessEnv): string | undefined {
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !env.GH_TOKEN) return undefined;
  const found = Bun.spawnSync(
    [
      "gh",
      "api",
      `repos/${repository}/actions/artifacts?name=${NAME}&per_page=100`,
      "--jq",
      NEWEST_ON_MAIN,
    ],
    { env, stdout: "pipe", stderr: "ignore" },
  );
  const run = found.stdout.toString().trim();
  if (found.exitCode !== 0 || !run) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "catalog-snapshot-"));
  const downloaded = Bun.spawnSync(
    ["gh", "run", "download", run, "--repo", repository, "--name", NAME, "--dir", dir],
    {
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return downloaded.exitCode === 0 ? join(dir, "catalog-snapshot.json") : undefined;
}
