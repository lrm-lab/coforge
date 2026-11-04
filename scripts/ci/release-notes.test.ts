import { expect, test } from "bun:test";

// Release notes (docs/release/release-notes.md): every Computer publication carries English and
// Simplified Chinese notes, checked before the build and registered in the environment's release
// catalog once `latest` has moved by calling release-notes.yml, which also rewrites them for a
// published version when dispatched by hand.

type Step = {
  name?: string;
  if?: string;
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
  outputs?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
  secrets?: unknown;
  steps?: Step[];
};
type Input = { required?: boolean; type?: string; options?: string[] };
type Workflow = {
  on: Record<string, { inputs?: Record<string, Input>; secrets?: Record<string, Input> }>;
  permissions?: Record<string, string>;
  concurrency: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const load = async (name: string) =>
  Bun.YAML.parse(await Bun.file(`.github/workflows/${name}`).text()) as Workflow;

const staging = await load("release-staging.yml");
const production = await load("release-production.yml");
const edit = await load("release-notes.yml");
const workflows = { staging, production, edit };

const SCRIPT = "scripts/release/release-notes.ts";
const NOTES_ENV = {
  RELEASE_NOTES_EN: "${{ inputs.notes_en }}",
  RELEASE_NOTES_ZH_CN: "${{ inputs.notes_zh_cn }}",
};

const scriptSteps = (workflow: Workflow) =>
  Object.entries(workflow.jobs).flatMap(([job, definition]) =>
    (definition.steps ?? [])
      .filter((step) => step.run?.includes(SCRIPT))
      .map((step) => ({ job, definition, step })),
  );
const checkStep = (workflow: Workflow) => {
  const found = scriptSteps(workflow).filter(({ step }) => step.run!.includes("--check"));
  expect(found).toHaveLength(1);
  return found[0]!;
};
/** The job that registers the notes: the publication's one call of release-notes.yml. */
const registerJob = (workflow: Workflow) => {
  const found = Object.entries(workflow.jobs).filter(
    ([, job]) => job.uses === "./.github/workflows/release-notes.yml",
  );
  expect(found).toHaveLength(1);
  // Registering is the called workflow's alone: the publication runs no publishing step itself.
  expect(scriptSteps(workflow).filter(({ step }) => !step.run!.includes("--check"))).toEqual([]);
  const [name, job] = found[0]!;
  return { name, job };
};

test("each workflow takes both languages as string inputs", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    const inputs = workflow.on.workflow_dispatch!.inputs!;
    for (const input of ["notes_en", "notes_zh_cn"])
      expect(inputs[input]?.type, name).toBe("string");
  }
  for (const input of ["environment", "version", "notes_en", "notes_zh_cn"])
    expect(edit.on.workflow_call!.inputs![input], input).toMatchObject({
      required: true,
      type: "string",
    });
  // A caller passes only its own catalog's token, so each is optional to the call.
  expect(edit.on.workflow_call!.secrets).toEqual({
    COFORGE_RELEASE_CATALOG_TOKEN_STAGING: { required: false },
    COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION: { required: false },
  });
  // Production and the edit always need notes. A staging withdrawal publishes nothing, so staging
  // leaves them optional and its check step requires them for a publication.
  for (const workflow of [production, edit]) {
    expect(workflow.on.workflow_dispatch!.inputs!.notes_en!.required).toBe(true);
    expect(workflow.on.workflow_dispatch!.inputs!.notes_zh_cn!.required).toBe(true);
  }
});

test("notes reach the script only through env vars, and so does the token", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const { job, step } of scriptSteps(workflow)) {
      expect(step.env, `${name}.${job}`).toMatchObject(NOTES_ENV);
      expect(step.run, `${name}.${job}`).not.toContain("${{");
    }
    for (const { definition } of scriptSteps(workflow))
      for (const step of definition.steps ?? []) {
        expect(step.run ?? "", name).not.toContain("${{ inputs.");
        expect(step.run ?? "", name).not.toContain("secrets.");
        if (step.uses) expect(step.uses, name).toMatch(/@[0-9a-f]{40}$/);
        if (step.uses?.startsWith("actions/checkout@"))
          expect(step.with?.["persist-credentials"], name).toBe(false);
      }
  }
});

test("staging checks the notes beside its gates and registers them after publishing", () => {
  const check = checkStep(staging);
  // Off the gates' critical path, but the publish job needs both, so bad notes still fail before
  // anything is published.
  expect(staging.jobs.gates!.needs).toBeUndefined();
  expect(staging.jobs.publish!.needs).toEqual(["gates", check.job]);
  expect(check.definition.if).toBe("github.ref == 'refs/heads/main'");
  expect(check.definition.permissions).toEqual({ contents: "read" });
  // A withdrawal publishes no version and needs no notes: the step skips and the job still
  // succeeds, so the publish job that withdraws is not skipped with it.
  expect(check.step.if).toBe("inputs.withdraw_version == ''");

  const { job } = registerJob(staging);
  expect(job.needs).toBe("publish");
  expect(job.if).toBe("inputs.withdraw_version == ''");
  expect(job.permissions).toEqual({ contents: "read" });
  expect(staging.jobs.publish!.outputs?.version).toBe("${{ steps.publish.outputs.version }}");
  expect(job.with).toEqual({
    environment: "staging",
    version: "${{ needs.publish.outputs.version }}",
    notes_en: "${{ inputs.notes_en }}",
    notes_zh_cn: "${{ inputs.notes_zh_cn }}",
  });
  // Only its own catalog's token reaches the called workflow, never every repository secret.
  expect(job.secrets).toEqual({
    COFORGE_RELEASE_CATALOG_TOKEN_STAGING: "${{ secrets.COFORGE_RELEASE_CATALOG_TOKEN_STAGING }}",
  });
});

test("production checks the notes before the build and registers them after publishing", () => {
  const check = checkStep(production);
  expect(check.job).toBe("candidate");
  expect(check.step.env?.INPUT_VERSION).toBe("${{ inputs.version }}");
  expect(check.step.run).toContain('--version "$INPUT_VERSION"');

  const { job } = registerJob(production);
  expect(job.needs).toBe("publish");
  // Neither the `production` environment nor the publisher role: the job changes notes text, not artifacts.
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job.environment).toBeUndefined();
  expect(job.with).toEqual({
    environment: "production",
    version: "${{ inputs.version }}",
    notes_en: "${{ inputs.notes_en }}",
    notes_zh_cn: "${{ inputs.notes_zh_cn }}",
  });
  expect(job.secrets).toEqual({
    COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION:
      "${{ secrets.COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION }}",
  });
});

test("the notes workflow runs from main without publisher credentials and alone picks the catalog", () => {
  expect(Object.keys(edit.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
  const inputs = edit.on.workflow_dispatch!.inputs!;
  expect(inputs.environment).toMatchObject({
    required: true,
    type: "choice",
    options: ["staging", "production"],
  });
  expect(inputs.version).toMatchObject({ required: true, type: "string" });
  expect(edit.permissions).toEqual({ contents: "read" });
  // A manual edit and a publication's registration of the same catalog run one at a time.
  expect(edit.concurrency).toEqual({
    group: "release-notes-${{ inputs.environment }}",
    "cancel-in-progress": false,
  });
  for (const [name, job] of Object.entries(edit.jobs)) {
    expect(job.environment, name).toBeUndefined();
    expect(job.permissions, name).toEqual({ contents: "read" });
    // Called, `github.ref` is the caller's, which publishes only from main.
    expect(job.if, name).toBe("github.ref == 'refs/heads/main'");
  }
  expect(JSON.stringify(edit)).not.toContain("ALIBABA_CLOUD");
  // A caller never names the other environment's catalog token.
  expect(JSON.stringify(registerJob(staging).job)).not.toContain(
    "COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION",
  );
  expect(JSON.stringify(registerJob(production).job)).not.toContain(
    "COFORGE_RELEASE_CATALOG_TOKEN_STAGING",
  );

  // One step per environment, each naming only its own secret: an `a && b || c` expression would
  // fall through to the other environment's token whenever the selected secret is unset.
  const steps = scriptSteps(edit);
  expect(steps.map(({ step }) => step.if)).toEqual([
    "inputs.environment == 'staging'",
    "inputs.environment == 'production'",
  ]);
  for (const [{ step }, origin, secret] of [
    [steps[0]!, "https://staging.coforge.cn", "COFORGE_RELEASE_CATALOG_TOKEN_STAGING"],
    [steps[1]!, "https://coforge.cn", "COFORGE_RELEASE_CATALOG_TOKEN_PRODUCTION"],
  ] as const) {
    expect(step.env).toMatchObject({
      INPUT_VERSION: "${{ inputs.version }}",
      COFORGE_RELEASE_CATALOG_TOKEN: `\${{ secrets.${secret} }}`,
    });
    expect(step.run).toContain(`--origin "${origin}"`);
    expect(step.run).toContain('--version "$INPUT_VERSION"');
  }
  // It checks out the caller's commit, main, never an approved release commit.
  const checkout = edit.jobs[steps[0]!.job]!.steps!.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  expect(checkout?.with?.ref).toBeUndefined();
});
