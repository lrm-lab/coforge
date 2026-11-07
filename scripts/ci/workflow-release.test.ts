import { expect, test } from "bun:test";

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
