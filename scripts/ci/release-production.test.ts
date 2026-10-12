import { expect, test } from "bun:test";

// The production publications (docs/release/staging-to-production.md): each rebuilds one approved
// commit that staging already published, against the production feed, and reaches only the
// production bucket through the production publisher role.

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
  strategy?: { matrix: { include: Record<string, string>[] } };
};
type Workflow = {
  on: Record<string, { inputs?: Record<string, { required?: boolean; type?: string }> }>;
  env?: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const load = async (name: string) =>
  Bun.YAML.parse(await Bun.file(`.github/workflows/${name}`).text()) as Workflow;

const ci = await load("ci.yml");
const computerStaging = await load("release-staging.yml");
const computer = await load("release-production.yml");
const installer = await load("release-installer-production.yml");
const workflows = { computer, installer };

const PRODUCTION_ROLE = "acs:ram::1085194890307801:role/coforge-release-publisher-production";
const PRODUCTION_BUCKET = "coforge-releases";
const PRODUCTION_FEED = "https://releases.coforge.cn";
const OIDC_STEP = "Request an OIDC token for Alibaba Cloud";

const steps = (workflow: Workflow) =>
  Object.entries(workflow.jobs).flatMap(([name, job]) =>
    (job.steps ?? []).map((step) => ({ name, job, step })),
  );
const roleOf = (workflow: Workflow, job: Job, step: Step) =>
  step.env?.ALIBABA_CLOUD_ROLE_ARN ??
  job.env?.ALIBABA_CLOUD_ROLE_ARN ??
  workflow.env?.ALIBABA_CLOUD_ROLE_ARN;

test("production publication is manual and names the approved commit and version", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    expect(Object.keys(workflow.on), name).toEqual(["workflow_dispatch"]);
    const inputs = workflow.on.workflow_dispatch!.inputs!;
    expect(inputs.commit?.type, name).toBe("string");
    expect(inputs.version?.type, name).toBe("string");
    expect(workflow.concurrency["cancel-in-progress"], name).toBe(false);
  }
  expect(computer.on.workflow_dispatch!.inputs!.commit!.required).toBe(true);
  expect(computer.on.workflow_dispatch!.inputs!.version!.required).toBe(true);
  expect(computer.concurrency.group).toBe("release-production");
  expect(installer.concurrency.group).toBe("release-installer-production");
});

test("only the production environment's jobs hold an OIDC token, and they assume the production role", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    let signedIn = 0;
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const reachesBucket = job.permissions?.["id-token"] === "write";
      expect(job.environment === "production", `${name}.${jobName}`).toBe(reachesBucket);
      if (!reachesBucket) continue;
      signedIn += 1;
      const publish = job.steps!.find((step) => /publish(-installer)?\.ts/.test(step.run ?? ""))!;
      expect(roleOf(workflow, job, publish), `${name}.${jobName}`).toBe(PRODUCTION_ROLE);
    }
    expect(signedIn, name).toBeGreaterThan(0);
    expect(JSON.stringify(workflow), name).not.toContain('role/coforge-release-publisher"');
    expect(JSON.stringify(workflow), name).not.toContain("coforge-releases-staging");
  }
});

test("every bucket call names the production bucket, and every build compiles in the production feed", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    const calls = steps(workflow).filter(({ step }) =>
      /scripts\/release\/publish(-installer)?\.ts/.test(step.run ?? ""),
    );
    expect(calls.length, name).toBeGreaterThan(0);
    for (const { name: jobName, step } of calls) {
      expect(step.run, `${name}.${jobName}`).toMatch(
        new RegExp(`--bucket ${PRODUCTION_BUCKET}\\s`),
      );
    }
  }
  const publish = computer.jobs.publish!.steps!.find((step) => step.run?.includes("publish.ts"))!;
  expect(publish.run).toContain(`--feed-url "${PRODUCTION_FEED}"`);
  expect(installer.jobs.build!.env!.COFORGE_RELEASE_FEED_URL).toBe(PRODUCTION_FEED);
});

test("publication waits for the staging evidence of the same commit and builds exactly that commit", () => {
  expect(computer.jobs.publish!.needs).toBe("candidate");
  expect(installer.jobs.plan!.needs).toBe("candidate");
  expect(installer.jobs.build!.needs).toEqual(["candidate", "plan"]);
  for (const [name, workflow] of Object.entries(workflows)) {
    const verify = workflow.jobs.candidate!.steps!.find((step) =>
      step.run?.includes("scripts/release/production-candidate.ts"),
    );
    expect(verify, name).toBeDefined();
    expect(workflow.jobs.candidate!.permissions, name).toEqual({ contents: "read" });
    expect(workflow.jobs.candidate!.if, name).toContain("github.ref == 'refs/heads/main'");
    expect(verify!.run, name).toContain('git merge-base --is-ancestor "$INPUT_COMMIT" HEAD');
    for (const { name: jobName, step } of steps(workflow)) {
      if (!step.uses?.startsWith("actions/checkout@")) continue;
      // The candidate job runs main's verifier against main's history; every build checks out the
      // approved commit itself.
      // A pointer-only move builds nothing and runs main's script.
      expect(step.with?.ref, `${name}.${jobName}`).toBe(
        jobName === "candidate" || jobName === "pointer" ? undefined : "${{ inputs.commit }}",
      );
      expect(step.with?.["persist-credentials"], `${name}.${jobName}`).toBe(false);
    }
  }
});

test("a job that compiles the installer holds no token, and the builds match installer-crate's targets", () => {
  const { build } = installer.jobs;
  expect(build!.permissions).toEqual({ contents: "read" });
  expect(build!.environment).toBeUndefined();
  const targets = (job: Job) =>
    job
      .strategy!.matrix.include.map((entry) => [
        entry.release_target,
        entry.rust_target,
        entry.runner,
      ])
      .sort();
  expect(targets(build!)).toEqual(targets(ci.jobs["installer-crate"]!));
  for (const [name, job] of Object.entries(installer.jobs)) {
    const compiles = (job.steps ?? []).some((step) => /\bcargo\b|\brustup\b/.test(step.run ?? ""));
    if (compiles) expect(job.permissions?.["id-token"], name).toBeUndefined();
  }
});

test("production signs in as staging does, pins every action, and keeps inputs out of scripts", () => {
  const stagingOidc = computerStaging.jobs.publish!.steps!.find((step) => step.name === OIDC_STEP)!;
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      if (job.permissions?.["id-token"] === "write") {
        const oidc = job.steps!.find((step) => step.name === OIDC_STEP);
        expect(oidc?.run, `${name}.${jobName}`).toBe(stagingOidc.run!);
        expect(oidc?.env, `${name}.${jobName}`).toEqual(stagingOidc.env!);
      }
    }
    for (const { name: jobName, step } of steps(workflow)) {
      if (step.uses) expect(step.uses, `${name}.${jobName}`).toMatch(/@[0-9a-f]{40}$/);
      expect(step.run ?? "", `${name}.${jobName}`).not.toContain("${{ inputs.");
    }
  }
});
