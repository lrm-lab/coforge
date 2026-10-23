import { expect, test } from "bun:test";

import { type Job, parse } from "./workflow-helpers";

const ci = await parse("ci.yml");
const release = await parse("release-staging.yml");

const installerRelease = (await parse("release-installer-staging.yml")) as {
  on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> }>;
  env: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job & { uses?: string; with?: Record<string, string> }>;
};
const OIDC_STEP = "Request an OIDC token for Alibaba Cloud";

test("the installer release is manual, validates the installer track, and moves its pointer alone on request", () => {
  // A push trigger would publish an installer per merge; docs/release/installer-feed.md.
  expect(Object.keys(installerRelease.on)).toEqual(["workflow_dispatch"]);
  expect(installerRelease.on.workflow_dispatch?.inputs?.pointer_only).toMatchObject({
    required: false,
    type: "string",
  });
  expect(installerRelease.concurrency).toEqual({
    group: "release-installer-staging",
    "cancel-in-progress": false,
  });

  const { gates, plan, build, publish, pointer } = installerRelease.jobs;
  expect(gates?.uses).toBe("./.github/workflows/ci.yml");
  expect(gates?.with?.track).toBe("installer");
  expect(gates?.permissions).toEqual({ contents: "read", actions: "read" });
  // Building, planning and publishing wait for the gate and are skipped by a pointer-only run; the
  // pointer job is the only one that runs then, and it builds nothing.
  for (const job of [gates, plan]) {
    expect(job?.if).toContain("github.ref == 'refs/heads/main'");
    expect(job?.if).toContain("inputs.pointer_only == ''");
  }
  expect(build?.needs).toEqual(["gates", "plan"]);
  expect(publish?.needs).toEqual(["plan", "build"]);
  expect(pointer?.needs).toBeUndefined();
  expect(pointer?.if).toContain("github.ref == 'refs/heads/main'");
  expect(pointer?.if).toContain("inputs.pointer_only != ''");
  expect(pointer?.steps?.some((step) => step.run?.includes("publish-installer.ts pointer"))).toBe(
    true,
  );
});

test("only the installer release jobs that reach the bucket hold an OIDC token, and only through the staging environment", () => {
  for (const [name, job] of Object.entries(installerRelease.jobs)) {
    const reachesBucket = job.permissions?.["id-token"] === "write";
    // The RAM role trusts exactly the repository's `staging` environment.
    expect(job.environment === "staging", name).toBe(reachesBucket);
    if (job.uses) continue;
    expect(job.permissions, name).toEqual({
      contents: "read",
      ...(reachesBucket ? { "id-token": "write" } : {}),
    });
  }
  expect(
    Object.keys(installerRelease.jobs).filter((name) => installerRelease.jobs[name]?.environment),
  ).toEqual(["plan", "publish", "pointer"]);
});

test("a job that compiles the installer never holds an OIDC token, and a job that holds one compiles nothing", () => {
  // `cargo build` runs the build scripts and proc-macros of about sixty crates. Whatever they do,
  // they must not be able to reach the bucket: the builds hand their binary on as an artifact, and
  // only jobs that compile nothing hold the token.
  const compiles = (job: Job) =>
    (job.steps ?? []).some((step) => /\bcargo\b|\brustup\b/.test(step.run ?? ""));
  const { build } = installerRelease.jobs;
  expect(compiles(build!)).toBe(true);
  expect(build?.permissions).toEqual({ contents: "read" });
  expect(build?.environment).toBeUndefined();
  for (const [name, job] of Object.entries(installerRelease.jobs)) {
    if (compiles(job)) {
      expect(job.permissions?.["id-token"], name).toBeUndefined();
      expect(job.environment, name).toBeUndefined();
    }
    if (job.permissions?.["id-token"] === "write") expect(compiles(job), name).toBe(false);
  }
});

test("the installer release keeps each target's artifact apart and hands it to the publisher unmerged", () => {
  const { build, publish } = installerRelease.jobs;
  const upload = build!.steps!.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
  // The artifact's name is the directory the publisher reads (`installerArtifactName` in
  // scripts/release/publish-installer.ts, pinned by its tests): one artifact per target.
  expect(upload.with?.name).toBe("installer-${{ matrix.release_target }}");
  const download = publish!.steps!.filter((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  // Merging would put every target's files in one directory, where a compromised build job could
  // overwrite another target's binary; without it each artifact lands in a directory of its own.
  expect(download).toHaveLength(1);
  expect(download[0]?.with?.pattern).toBe("installer-*");
  expect(download[0]?.with?.["merge-multiple"]).toBeUndefined();
  const finalize = publish!.steps!.find((step) =>
    step.run?.includes("publish-installer.ts finalize"),
  )!;
  expect(finalize.run).toContain(`--binaries ${download[0]?.with?.path}`);
});

test("no installer release checkout leaves the workflow token in the repository", () => {
  let checkouts = 0;
  for (const [name, job] of Object.entries(installerRelease.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/checkout@")) continue;
      checkouts += 1;
      expect(step.with?.["persist-credentials"], name).toBe(false);
    }
  }
  expect(checkouts).toBe(4);
});

test("the installer release signs in exactly as Computer publication does", async () => {
  const computerSteps = (release as { jobs: { publish: { steps: Step[] } } }).jobs.publish.steps;
  const computerOidc = computerSteps.find((step) => step.name === OIDC_STEP)!;
  const computerEnv = computerSteps.find((step) =>
    step.name?.startsWith("Build six platforms"),
  )!.env!;

  for (const key of [
    "ALIBABA_CLOUD_ROLE_ARN",
    "ALIBABA_CLOUD_OIDC_PROVIDER_ARN",
    "ALIBABA_CLOUD_ECS_METADATA_DISABLED",
  ]) {
    expect(installerRelease.env[key], key).toBe(computerEnv[key]!);
  }
  let signedIn = 0;
  for (const [name, job] of Object.entries(installerRelease.jobs)) {
    if (job.permissions?.["id-token"] !== "write") continue;
    const step = job.steps!.find((candidate) => candidate.name === OIDC_STEP);
    expect(step, name).toBeDefined();
    expect(step!.run, name).toBe(computerOidc.run!);
    expect(step!.env, name).toEqual(computerOidc.env!);
    signedIn += 1;
  }
  expect(signedIn).toBe(3);
});

test("the installer release builds every release target on the runner installer-crate checks it on", () => {
  const targets = (job: Job | undefined) =>
    job!
      .strategy!.matrix.include.map((entry) => [
        entry.release_target,
        entry.rust_target,
        entry.runner,
      ])
      .sort();
  expect(targets(installerRelease.jobs.build)).toEqual(targets(ci.jobs["installer-crate"]));
  expect(targets(installerRelease.jobs.build)).toHaveLength(6);
});

test("the installer release pins every action, and caller-controlled input never enters a script body", () => {
  for (const [name, job] of Object.entries(installerRelease.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses) expect(step.uses, `${name}: ${step.uses}`).toMatch(/@[0-9a-f]{40}$/);
      // `inputs.pointer_only` is free text: it may reach a script only through an env var.
      expect(step.run ?? "", name).not.toContain("${{ inputs.");
    }
  }
});
