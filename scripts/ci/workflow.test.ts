import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ci = Bun.YAML.parse(await Bun.file(".github/workflows/ci.yml").text());

test("deployment readiness requires a successful WebSocket handshake, rejecting HTTP error pages", async () => {
  const deploy = Bun.YAML.parse(await Bun.file(".github/workflows/deploy-staging.yml").text());
  const script = deploy.jobs.deploy.steps.find(
    (step: { name: string }) => step.name === "Check realtime endpoint responds",
  ).run;
  for (const status of [404, 502, 101]) {
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (status === 101 && server.upgrade(request)) return;
        return new Response("unavailable", { status });
      },
      websocket: { message() {} },
    });
    try {
      const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
        env: { ...Bun.env, REALTIME_URL: `ws://127.0.0.1:${server.port}/connection/websocket` },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(status === 101 ? 0 : 1);
    } finally {
      await server.stop(true);
    }
  }
});

test("the staging image build fixes file timestamps and reads no build cache", async () => {
  const deploy = Bun.YAML.parse(await Bun.file(".github/workflows/deploy-staging.yml").text());
  const build = deploy.jobs.image.steps.find(
    (step: { name: string }) => step.name === "Build and push Docker image",
  );
  // A constant epoch: the commit time would give every build's files a new timestamp.
  expect(String(build.env?.SOURCE_DATE_EPOCH)).toBe("0");
  expect(build.with.outputs.split(",")).toContain("rewrite-timestamp=true");
  // A build cache is writable from jobs other than this one, which could then supply its layers.
  expect(build.with["cache-from"]).toBeUndefined();
  expect(build.with["cache-to"]).toBeUndefined();
});

test("the aggregate gate executes even after failure and rejects missing, skipped, or cancelled required jobs", () => {
  const gate = ci.jobs["ci-passed"];
  expect(gate?.if).toBe("always()");
  expect([...gate.needs].sort()).toEqual(
    Object.keys(ci.jobs)
      .filter((id) => id !== "ci-passed")
      .sort(),
  );
  const script = gate.steps[0].run;
  for (const result of ["success", "failure", "cancelled", "skipped", undefined]) {
    const needs = {
      changes: { result: "success", outputs: { jobs: '["changes","web"]' } },
      web: { result },
      computer: { result: "skipped" },
    };
    const run = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
      env: { ...Bun.env, NEEDS: JSON.stringify(needs) },
    });
    expect(run.exitCode === 0).toBe(result === "success");
  }
  for (const result of ["failure", "cancelled", "skipped"]) {
    const run = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
      env: { ...Bun.env, NEEDS: JSON.stringify({ changes: { result, outputs: {} } }) },
    });
    expect(run.exitCode).not.toBe(0);
  }
});

test("release callers select separate tracks and a no-op Web change cannot build an image", async () => {
  const deploy = Bun.YAML.parse(await Bun.file(".github/workflows/deploy-staging.yml").text());
  const release = Bun.YAML.parse(await Bun.file(".github/workflows/release-staging.yml").text());
  expect(deploy.jobs.gates.with.track).toBe("web");
  // The newest pending push replaces older pending ones; a running deployment is never cancelled.
  expect(deploy.concurrency.queue).toBeUndefined();
  expect(deploy.concurrency["cancel-in-progress"]).toBe(false);
  // Finding the base reads this repository's workflow runs.
  expect(ci.jobs.changes.permissions).toEqual({ contents: "read", actions: "read" });
  expect(deploy.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(release.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(deploy.jobs.image.if).toBe("needs.gates.outputs.deploy == 'true'");
  expect(deploy.jobs.image.needs).toBe("gates");
  expect(release.jobs.gates.with.track).toBe("local");
  expect(release.jobs.publish.needs).toBe("gates");
});

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
  steps?: Step[];
  strategy?: { matrix: { include: Record<string, string>[] } };
};

const installerRelease = Bun.YAML.parse(
  await Bun.file(".github/workflows/release-installer-staging.yml").text(),
) as {
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
  const computer = Bun.YAML.parse(
    await Bun.file(".github/workflows/release-staging.yml").text(),
  ) as { jobs: { publish: { steps: Step[] } } };
  const computerSteps = computer.jobs.publish.steps;
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

test("the workflow diffs PRs from their merge base and includes both sides of a rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: dir });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(join(dir, "scripts/ci"), { recursive: true });
    await Bun.write(join(dir, "scripts/ci/selection.ts"), Bun.file("scripts/ci/selection.ts"));
    await Bun.write(join(dir, "README.md"), "initial\n");
    git("init", "-b", "main");
    git("config", "user.name", "me-frankan");
    git("config", "user.email", "me.frankan@gmail.com");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "initial");
    git("switch", "-c", "feature");
    await mkdir(join(dir, "apps/web"), { recursive: true });
    await Bun.write(join(dir, "apps/web/page.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-m", "web change");
    const head = git("rev-parse", "HEAD");
    git("switch", "main");
    await mkdir(join(dir, "packages/daemon"), { recursive: true });
    await Bun.write(join(dir, "packages/daemon/runtime.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-m", "unrelated main change");
    const base = git("rev-parse", "HEAD");
    const script = ci.jobs.changes.steps.find((step: { id?: string }) => step.id === "select").run;
    const select = (event: string, before: string, after: string) => {
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", script], {
        cwd: dir,
        env: {
          ...Bun.env,
          TRACK: "changes",
          EVENT: event,
          BASE: before,
          HEAD: after,
          RUNNER_TEMP: dir,
          GITHUB_OUTPUT: join(dir, "output"),
        },
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    expect(select("pull_request", base, head)).toContain('checks=["web"]\n');
    git("switch", "feature");
    git("mv", "apps/web/page.ts", "docs.md");
    git("commit", "-m", "move web source to documentation");
    expect(select("push", head, git("rev-parse", "HEAD"))).toContain('checks=["web"]\n');
    expect(select("push", "0".repeat(40), head)).toContain(
      'contracts=["cdn-certs","ci","deploy","oss-cdn","release"]\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a push diffs from the last successful run of its workflow, so superseded pushes stay in scope", async () => {
  const steps = ci.jobs.changes.steps as {
    id?: string;
    if?: string;
    env?: Record<string, string>;
    run: string;
  }[];
  const base = steps.find((step) => step.id === "base")!;
  expect(base.if).toBe("github.event_name == 'push'");
  expect(base.env).toEqual({
    GH_TOKEN: "${{ github.token }}",
    REPOSITORY: "${{ github.repository }}",
    RUN_ID: "${{ github.run_id }}",
    BRANCH: "${{ github.ref_name }}",
  });
  expect(steps.find((step) => step.id === "select")!.env!.BASE).toBe(
    "${{ github.event.pull_request.base.sha || steps.base.outputs.sha }}",
  );
  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-base-"));
  try {
    const calls = join(dir, "calls");
    await Bun.write(
      join(dir, "gh"),
      `#!/bin/bash
printf '%s\\n' "$2" >> "${calls}"
case "$2" in
  repos/lrm-lab/coforge/actions/runs/42) body='{"id":42,"workflow_id":7}' ;;
  repos/lrm-lab/coforge/actions/workflows/7/runs*) body="$RUNS" ;;
  *) exit 1 ;;
esac
# gh applies --jq and prints strings raw.
[ "$3" = --jq ] && printf '%s' "$body" | jq -r "$4"
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const findBase = (lastSuccess: string) => {
      const output = join(dir, `output-${lastSuccess || "none"}`);
      const runs = lastSuccess ? [{ id: 41, head_sha: lastSuccess }] : [];
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", base.run], {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          RUNS: JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
          REPOSITORY: "lrm-lab/coforge",
          RUN_ID: "42",
          BRANCH: "main",
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.exitCode).toBe(0);
      return Bun.file(output).text();
    };
    expect(await findBase("a".repeat(40))).toBe(`sha=${"a".repeat(40)}\n`);
    expect(await Bun.file(calls).text()).toContain(
      "repos/lrm-lab/coforge/actions/workflows/7/runs?branch=main&event=push&status=success&per_page=1\n",
    );
    // No successful run yet: an empty base makes the select step cover everything.
    expect(await findBase("")).toBe("sha=\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Computer withdrawal shares the publication lock and cannot publish a replacement", async () => {
  const release = Bun.YAML.parse(await Bun.file(".github/workflows/release-staging.yml").text());
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

test("withdrawal inputs cannot accidentally fall through to a publication", async () => {
  const release = Bun.YAML.parse(await Bun.file(".github/workflows/release-staging.yml").text());
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
