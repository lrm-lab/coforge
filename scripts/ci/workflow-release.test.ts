import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Step, parse } from "./workflow-helpers";

const release = await parse("release-staging.yml");

test("Computer withdrawal shares the publication lock and cannot publish a replacement", async () => {
  expect(release.on.workflow_dispatch.inputs.withdraw_version.type).toBe("string");
  expect(release.concurrency).toEqual({ group: "release-staging", "cancel-in-progress": false });
  const steps = release.jobs.publish.steps;
  const publish = steps.find((step: Step) => step.name?.startsWith("Build six platforms"));
  const summary = steps.find((step: Step) => step.name === "Summarize published release");
  const withdraw = steps.find((step: Step) => step.run?.includes("scripts/release/withdraw.ts"));
  expect(publish.if).toBe("inputs.withdraw_version == ''");
  expect(summary.if).toBe("inputs.withdraw_version == ''");
  expect(withdraw.if).toBe("inputs.withdraw_version != ''");
  expect(withdraw.env.INPUT_WITHDRAW_VERSION).toBe("${{ inputs.withdraw_version }}");
  expect(withdraw.env.INPUT_RESTORE_VERSION).toBe("${{ inputs.restore_version }}");
  expect(withdraw.env.INPUT_MANIFEST_SHA256).toBe("${{ inputs.manifest_sha256 }}");
  expect(withdraw.env.INPUT_RESTORE_MANIFEST_SHA256).toBe("${{ inputs.restore_manifest_sha256 }}");
  expect(withdraw.env.ALIBABA_CLOUD_ROLE_ARN).toBe(publish.env.ALIBABA_CLOUD_ROLE_ARN);
  expect(withdraw.run).not.toContain("${{ inputs.");
  expect(withdraw.run).not.toContain("publish.ts");
});

test("a staging publication is numbered against production's latest, never a hand-kept line", async () => {
  expect(release.on.workflow_dispatch.inputs.line).toMatchObject({
    required: false,
    type: "string",
  });
  const publish = release.jobs.publish.steps.find((step: Step) =>
    step.name?.startsWith("Build six platforms"),
  );
  expect(publish.env.INPUT_VERSION).toBe("${{ inputs.version }}");
  expect(publish.env.INPUT_LINE).toBe("${{ inputs.line }}");
  // Production's feed is public: reading its latest needs no credential beyond the staging role's.
  expect(publish.run).toContain('--production-feed-url "https://releases.coforge.cn"');
  expect(publish.run).toContain('--line "$INPUT_LINE"');
  expect(publish.run).not.toContain("${{ inputs.");
});

test("withdrawal inputs cannot accidentally fall through to a publication", async () => {
  const guard = release.jobs.publish.steps.find(
    (step: Step) => step.name === "Validate withdrawal inputs",
  );
  expect(guard).toBeDefined();
  for (const [inputs, allowed] of [
    [{}, true],
    [{ INPUT_RESTORE_VERSION: "0.1.3-dev.2" }, false],
    [{ INPUT_WITHDRAW_VERSION: "0.1.4-dev.1" }, false],
    [
      {
        INPUT_LINE: "0.2.0",
        INPUT_WITHDRAW_VERSION: "0.1.4-dev.1",
        INPUT_MANIFEST_SHA256: "a".repeat(64),
        INPUT_RESTORE_VERSION: "0.1.3-dev.2",
        INPUT_RESTORE_MANIFEST_SHA256: "b".repeat(64),
      },
      false,
    ],
    [
      {
        INPUT_WITHDRAW_VERSION: "0.1.4-dev.1",
        INPUT_MANIFEST_SHA256: "a".repeat(64),
        INPUT_RESTORE_VERSION: "0.1.3-dev.2",
        INPUT_RESTORE_MANIFEST_SHA256: "b".repeat(64),
      },
      true,
    ],
  ] as const) {
    const child = Bun.spawnSync(["bash", "-e", "-c", guard.run], {
      env: { PATH: process.env.PATH, ...inputs },
    });
    expect(child.exitCode).toBe(allowed ? 0 : 1);
  }
});

test("Computer staging reuses the push CI verdict for the exact dispatch commit and keeps validation as the fallback", async () => {
  expect(release.jobs.gates.with.track).toBe("local");
  expect(release.jobs.gates.needs).toBe("ci-status");
  expect(release.jobs["ci-status"].if).toBe("github.ref == 'refs/heads/main'");
  expect(release.jobs["ci-status"].permissions).toEqual({ contents: "read", actions: "read" });
  expect(release.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(release.jobs.gates.if).toBe(
    "github.ref == 'refs/heads/main' && (inputs.force_validate || needs.ci-status.outputs.passed != 'true')",
  );
  expect(release.on.workflow_dispatch.inputs.force_validate).toMatchObject({
    type: "boolean",
    default: false,
  });
  expect(release.jobs.publish.needs).toEqual(["ci-status", "gates", "notes-check"]);
  expect(release.jobs.publish.if).toBe(
    "always() && github.ref == 'refs/heads/main' && !cancelled() && needs.notes-check.result == 'success' && ((!inputs.force_validate && needs.ci-status.outputs.passed == 'true') || needs.gates.result == 'success')",
  );
});

test("the release staging CI check falls back to validation when the verdict is unavailable, never silently skipping", async () => {
  const script = await Bun.file("scripts/deploy/resolve-staging-source.sh").text();
  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-soft-"));
  try {
    await Bun.write(
      join(dir, "gh"),
      `#!/bin/bash
case "$GH_MODE" in
  green) jq -n '{workflow_runs: []}'; exit 0 ;;
  fail) exit 1 ;;
esac
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const run = (extra: Record<string, string>) => {
      const output = join(dir, `output-${Math.random()}`);
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          DISPATCH_SHA: "a".repeat(40),
          CANDIDATE_REF: "",
          REPOSITORY: "lrm-lab/coforge",
          GITHUB_OUTPUT: output,
          ...extra,
        },
      });
      return { code: result.exitCode, out: output };
    };
    // The API failing without soft mode is a hard error: no silent skip.
    expect(run({ GH_MODE: "fail" }).code).not.toBe(0);
    // With soft mode the same failure falls back: passed=false so the caller runs full validation.
    const soft = run({ GH_MODE: "fail", FALLBACK_TO_VALIDATION: "true" });
    expect(soft.code).toBe(0);
    expect(await Bun.file(soft.out).text()).toBe(`sha=${"a".repeat(40)}\npassed=false\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
