import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// infra-rerun.sh decides from `gh api` output whether a failed run was purely
// infrastructure and then calls `gh run rerun --failed`. The stub gh answers
// the two api calls from fixtures and records rerun attempts.

const runFixture = (conclusion: string, attempt: number) =>
  JSON.stringify({ conclusion, run_attempt: attempt });

const jobsFixture = (failedSteps: string[], extraJobs: object[] = []) =>
  JSON.stringify({
    jobs: [
      {
        conclusion: "failure",
        steps: failedSteps.map((name, index) => ({
          name,
          conclusion: index === 0 ? "failure" : "skipped",
        })),
      },
      ...extraJobs,
    ],
  });

const decide = async (
  run: string,
  jobs: string,
): Promise<{ code: number; out: string; reruns: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-rerun-"));
  try {
    const calls = join(dir, "calls");
    await Bun.write(
      join(dir, "gh"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "${calls}"
if [ "$1" = "run" ] && [ "$2" = "rerun" ]; then exit 0; fi
case "$2" in
  repos/test/repo/actions/runs/42) printf '%s' "$RUN_JSON" ;;
  repos/test/repo/actions/runs/42/jobs*) printf '%s' "$JOBS_JSON" ;;
  *) exit 1 ;;
esac
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const result = Bun.spawnSync(["bash", "scripts/ci/infra-rerun.sh", "42"], {
      env: {
        ...Bun.env,
        PATH: `${dir}:${Bun.env.PATH}`,
        GH_TOKEN: "test-token",
        REPO: "test/repo",
        RUN_JSON: run,
        JOBS_JSON: jobs,
      },
    });
    const reruns = await Bun.file(calls)
      .text()
      .catch(() => "");
    return {
      code: result.exitCode,
      out: result.stdout.toString() + result.stderr.toString(),
      reruns: reruns
        .split("\n")
        .filter((line) => line.startsWith("run rerun"))
        .join("\n"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("infra-rerun reruns a first-attempt failure whose failed steps are all infrastructure", async () => {
  const { code, reruns } = await decide(
    runFixture("failure", 1),
    jobsFixture(["Set up mise", "Install toolchain"]),
  );
  expect(code).toBe(0);
  expect(reruns).toBe("run rerun 42 --repo test/repo --failed");
});

test("infra-rerun leaves a real check failure alone", async () => {
  const { code, reruns } = await decide(
    runFixture("failure", 1),
    jobsFixture(
      ["Set up mise"],
      [{ conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }],
    ),
  );
  expect(code).toBe(0);
  expect(reruns).toBe("");
});

test("infra-rerun does not rerun a second attempt", async () => {
  const { code, reruns } = await decide(runFixture("failure", 2), jobsFixture(["Set up mise"]));
  expect(code).toBe(0);
  expect(reruns).toBe("");
});

test("infra-rerun ignores runs that did not fail", async () => {
  const { code, reruns } = await decide(runFixture("success", 1), jobsFixture(["Set up mise"]));
  expect(code).toBe(0);
  expect(reruns).toBe("");
});

test("infra-rerun treats registry logins and browser installs as infrastructure", async () => {
  const { code, reruns } = await decide(
    runFixture("failure", 1),
    jobsFixture(["Log in to the image registry"]),
  );
  expect(code).toBe(0);
  expect(reruns).toContain("--failed");
});
