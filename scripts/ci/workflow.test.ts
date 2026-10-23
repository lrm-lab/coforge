import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Job, type Step, parse } from "./workflow-helpers";

const ci = await parse("ci.yml");
const deploy = await parse("deploy-staging.yml");
const release = await parse("release-staging.yml");

test("deployment readiness requires a successful WebSocket handshake, rejecting HTTP error pages", async () => {
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

test("deploy and release jobs restore nothing from the Actions cache", async () => {
  // Each setup action's input that turns its cache off; docs/release/github-actions.md.
  const cacheInputs: Record<string, string> = {
    "jdx/mise-action": "cache",
    "docker/setup-buildx-action": "cache-binary",
  };
  let checked = 0;
  for (const file of new Bun.Glob("*.{yml,yaml}").scanSync(".github/workflows")) {
    // CI holds no deploy or publish credentials and publishes nothing, so it keeps the cache.
    if (file === "ci.yml") continue;
    const { jobs } = Bun.YAML.parse(await Bun.file(`.github/workflows/${file}`).text()) as {
      jobs: Record<string, Job>;
    };
    for (const [name, job] of Object.entries(jobs)) {
      for (const step of job.steps ?? []) {
        const action = step.uses?.split("@")[0] ?? "";
        expect(action, `${file} ${name}`).not.toStartWith("actions/cache");
        if (!(action in cacheInputs)) continue;
        checked += 1;
        expect(step.with?.[cacheInputs[action]], `${file} ${name}`).toBe(false);
      }
    }
  }
  expect(checked).toBe(21);
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

test("CI validates every pull request and every push to main, and a newer run replaces a stale one", () => {
  // A push to main, a maintainer's or a merged PR's, is validated afterwards; docs/release/github-actions.md.
  expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push", "workflow_call"]);
  expect(ci.on.push).toEqual({ branches: ["main"] });
  // A superseded run is safe to cancel: a push diffs from the last successful push run, so the
  // cancelled push stays in scope. A caller's gates (workflow_dispatch) are never cancelled.
  expect(ci.concurrency).toEqual({
    group: "ci-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress":
      "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}",
  });
});

test("CI holds nothing that can deploy or publish", async () => {
  // No secret, environment, OIDC token, write permission, or nested workflow call: a CI run, a push
  // run included, can reach neither a deployment target nor a release feed. Uploading the
  // installer's third-party notices as a run artifact is not a publication.
  const text = await Bun.file(".github/workflows/ci.yml").text();
  expect(text).not.toMatch(/\bsecrets\b/);
  expect(Object.values(ci.permissions)).toEqual(["read"]);
  for (const [name, job] of Object.entries(ci.jobs as Record<string, Job & { uses?: string }>)) {
    expect(job.environment, name).toBeUndefined();
    expect(job.uses, name).toBeUndefined();
    for (const access of Object.values(job.permissions ?? {})) expect(access, name).toBe("read");
    for (const step of job.steps ?? []) {
      expect(step.uses ?? "", name).not.toMatch(/^(docker\/(login|build-push)-action|\.\/)/);
      expect(step.run ?? "", name).not.toMatch(/\b(publish|deploy)[^/\s]*\.(ts|sh)\b/);
    }
  }
});

test("a push to main starts no deployment or publication", async () => {
  // Only CI listens for a push; every deploy and release workflow is started by hand, and the one
  // that is also reusable (release-notes.yml) is otherwise called only by those.
  for (const file of new Bun.Glob("*.{yml,yaml}").scanSync(".github/workflows")) {
    if (file === "ci.yml") continue;
    const workflow = Bun.YAML.parse(await Bun.file(`.github/workflows/${file}`).text());
    const triggers = Object.keys(workflow.on).filter((trigger) => trigger !== "workflow_call");
    // Exemption: cdn-certificates.yml also runs on a schedule. It is scheduled certificate
    // maintenance, not a deployment (approved by Frank 2026-10-23).
    const expected =
      file === "cdn-certificates.yml" ? ["schedule", "workflow_dispatch"] : ["workflow_dispatch"];
    expect(triggers, file).toEqual(expected);
  }
});

test("release callers select separate tracks and the Web image waits for the main-only gates", async () => {
  expect(deploy.jobs.gates.with.track).toBe("web");
  // Web staging deploys only when an operator dispatches it from main; docs/release/github-actions.md.
  expect(Object.keys(deploy.on)).toEqual(["workflow_dispatch"]);
  expect(deploy.jobs.gates.if).toBe("github.ref == 'refs/heads/main'");
  // The newest pending dispatch replaces older pending ones; a running deployment is never cancelled.
  expect(deploy.concurrency.queue).toBeUndefined();
  expect(deploy.concurrency["cancel-in-progress"]).toBe(false);
  // Finding the base reads this repository's workflow runs.
  expect(ci.jobs.changes.permissions).toEqual({ contents: "read", actions: "read" });
  expect(deploy.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(release.jobs.gates.permissions).toEqual({ contents: "read", actions: "read" });
  expect(deploy.jobs.image.if).toBe("needs.gates.outputs.deploy == 'true'");
  expect(deploy.jobs.image.needs).toBe("gates");
  expect(release.jobs.gates.with.track).toBe("local");
  // The release-notes check runs beside the gates; publishing waits for both.
  expect(release.jobs.publish.needs).toEqual(["gates", "notes-check"]);
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
      'contracts=["cdn-certs","ci","deploy","docs-site","oss-cdn","reference-computer","release"]\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Plan checks runs the hard rules after the diff check", () => {
  const steps = ci.jobs.changes.steps as Step[];
  const select = steps.findIndex((step) => step.id === "select");
  const rules = steps[select + 1]!;
  expect(rules.name).toBe("Check hard rules");
  // The select step's env.
  expect(rules.env).toEqual(steps[select]!.env!);
  expect(rules.env!.BEFORE).toContain("'push' && github.event.before");
  expect(rules.run).toBe(
    'bun scripts/ci/hard-rules.ts --range "$BASE" "$HEAD" --authors-since "$BEFORE"',
  );
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
