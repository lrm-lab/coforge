import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Step, parse } from "./workflow-helpers";

const deploy = await parse("deploy-staging.yml");
const checker = await parse("artifact-checker-image.yml");
const repo = "lrm-lab/coforge";
const dispatchSha = "a".repeat(40);
const candidateSha = "b".repeat(40);

function ciRun(sha: string, overrides: Record<string, unknown> = {}) {
  return {
    head_sha: sha,
    head_branch: "main",
    head_repository: { full_name: repo },
    event: "push",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

async function runGate(input: {
  ref?: string;
  resolved?: string;
  runs?: ReturnType<typeof ciRun>[];
  ciUnavailable?: boolean;
}) {
  const step = (deploy.jobs["ci-status"].steps as Step[]).find((entry) => entry.id === "check")!;
  const directory = await mkdtemp(join(tmpdir(), "coforge-deploy-candidate-"));
  try {
    const calls = join(directory, "calls");
    const output = join(directory, "output");
    await Bun.write(
      join(directory, "gh"),
      `#!/bin/bash
printf '%s\\n' "$2" >> "$CALLS"
case "$2" in
  */commits/*)
    [ -n "$RESOLVED" ] || exit 1
    jq -rn --arg sha "$RESOLVED" '$sha'
    ;;
  */actions/workflows/ci.yml/runs*)
    [ "$CI_UNAVAILABLE" != true ] || exit 1
    printf '%s' "$RUNS"
    ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(join(directory, "gh"), 0o755);
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", step.run!], {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        CALLS: calls,
        CANDIDATE_REF: input.ref ?? "",
        DISPATCH_SHA: dispatchSha,
        CI_UNAVAILABLE: String(input.ciUnavailable ?? false),
        RESOLVED: input.resolved ?? "",
        RUNS: JSON.stringify({ workflow_runs: input.runs ?? [] }),
        REPOSITORY: repo,
        GITHUB_OUTPUT: output,
      },
    });
    return {
      exitCode: result.exitCode,
      calls: (await Bun.file(calls).text()).trim().split("\n"),
      output: (await Bun.file(output).exists()) ? await Bun.file(output).text() : "",
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function ciEndpoint(sha: string) {
  return `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&head_sha=${sha}&status=completed&per_page=20`;
}

test("an explicit branch ref resolves once and reuses passing main CI for the resolved SHA", async () => {
  const result = await runGate({
    ref: "refs/heads/release/green",
    resolved: candidateSha,
    runs: [ciRun(candidateSha)],
  });
  expect(result).toEqual({
    exitCode: 0,
    calls: [`repos/${repo}/commits/refs%2Fheads%2Frelease%2Fgreen`, ciEndpoint(candidateSha)],
    output: `sha=${candidateSha}\npassed=true\n`,
  });
});

test("an explicit exact SHA exists before its manual main CI is eligible", async () => {
  const result = await runGate({
    ref: candidateSha,
    resolved: candidateSha,
    runs: [ciRun(candidateSha, { event: "workflow_dispatch" })],
  });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual([`repos/${repo}/commits/${candidateSha}`, ciEndpoint(candidateSha)]);
  expect(result.output).toBe(`sha=${candidateSha}\npassed=true\n`);
});

test("a missing ref or invalid resolved commit fails before CI is queried", async () => {
  for (const resolved of [undefined, "not-a-sha"]) {
    const result = await runGate({ ref: "missing", resolved });
    expect(result).toEqual({
      exitCode: 1,
      calls: [`repos/${repo}/commits/missing`],
      output: "",
    });
  }
});

test("an explicit candidate requires completed successful CI for its exact SHA on repository main", async () => {
  const runs = [
    ciRun(dispatchSha),
    ciRun(candidateSha, { event: "pull_request" }),
    ciRun(candidateSha, { conclusion: "failure" }),
    ciRun(candidateSha, { status: "in_progress" }),
    ciRun(candidateSha, { head_branch: "feature" }),
    ciRun(candidateSha, { head_repository: { full_name: "fork/coforge" } }),
  ];
  for (const evidence of [runs, []]) {
    const result = await runGate({ ref: "v1", resolved: candidateSha, runs: evidence });
    expect(result.exitCode).toBe(1);
    expect(result.calls).toEqual([`repos/${repo}/commits/v1`, ciEndpoint(candidateSha)]);
    expect(result.output).toBe("");
  }
});

test("omitting the ref preserves main's exact CI lookup and Web-track fallback", async () => {
  expect(await runGate({ runs: [] })).toEqual({
    exitCode: 0,
    calls: [ciEndpoint(dispatchSha)],
    output: `sha=${dispatchSha}\npassed=false\n`,
  });
  expect(deploy.jobs.gates.if).toContain("inputs.candidate_ref == ''");
  expect(deploy.jobs.gates.with.track).toBe("web");
});

test("a failed CI lookup cannot select the dispatch commit for deployment", async () => {
  expect(await runGate({ ciUnavailable: true })).toEqual({
    exitCode: 1,
    calls: [ciEndpoint(dispatchSha)],
    output: "",
  });
});

test("the resolved SHA pins both image trees, deployment assets, tags, and the release record", () => {
  const selected = "${{ needs.ci-status.outputs.sha }}";
  const checkout = (steps: Step[]) =>
    steps.find(({ uses }) => uses?.startsWith("actions/checkout@"));
  expect(deploy.on.workflow_dispatch.inputs.candidate_ref).toMatchObject({ type: "string" });
  expect(deploy.jobs.image.env.SOURCE_COMMIT).toBe(selected);
  expect(checkout(deploy.jobs.image.steps)?.with?.ref).toBe(selected);
  expect(
    deploy.jobs.image.steps.find(({ id }: Step) => id === "push").with["build-args"],
  ).toContain("COFORGE_BUILD_ID=${{ env.SOURCE_COMMIT }}");
  expect(
    deploy.jobs.image.steps.find(({ name }: Step) => name === "Tag image with source commit").run,
  ).toContain(":sha-$SOURCE_COMMIT");
  expect(deploy.jobs["checker-image"].with.source_sha).toBe(selected);
  expect(checkout(checker.jobs.image.steps)?.with?.ref).toBe(
    "${{ inputs.source_sha || github.sha }}",
  );
  expect(
    checker.jobs.image.steps.find(
      ({ name }: Step) => name === "Tag image with checker tree commit and source commit",
    ).env.SOURCE_SHA,
  ).toBe("${{ inputs.source_sha || github.sha }}");
  expect(deploy.jobs.deploy.needs).toContain("ci-status");
  expect(checkout(deploy.jobs.deploy.steps)?.with?.ref).toBe(selected);
  expect(deploy.jobs.deploy.env.SOURCE_COMMIT).toBe(selected);
  expect(
    deploy.jobs.deploy.steps.find(({ name }: Step) => name === "Record deployment result").run,
  ).toContain('--source-commit "$SOURCE_COMMIT"');
});
