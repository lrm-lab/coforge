import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Step, parse } from "./workflow-helpers";

const ci = await parse("ci.yml");

test("standalone CI dispatch plans from the requested branch's merge base", async () => {
  const inputs = ci.on.workflow_dispatch.inputs;
  expect(inputs.base_ref.default).toBe("main");
  expect(inputs.full.default).toBe(false);
  const steps = ci.jobs.changes.steps as Step[];
  const base = steps.find((step) => step.id === "dispatch-base")!;
  expect(base.if).toBe("github.event_name == 'workflow_dispatch' && !inputs.track");
  const select = steps.find((step) => step.id === "select")!;
  expect(select.env?.BASE).toContain("steps.dispatch-base.outputs.sha");

  const dir = await mkdtemp(join(tmpdir(), "coforge-ci-dispatch-"));
  const run = (args: string[], env = {}) =>
    Bun.spawnSync(args, { cwd: dir, env: { ...Bun.env, ...env } });
  const git = (...args: string[]) => {
    const result = run(["git", ...args]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  try {
    await mkdir(join(dir, "scripts/ci"), { recursive: true });
    await Bun.write(join(dir, "scripts/ci/selection.ts"), Bun.file("scripts/ci/selection.ts"));
    git("init", "-b", "main");
    git("config", "user.name", "me-frankan");
    git("config", "user.email", "me.frankan@gmail.com");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-m", "initial");
    const common = git("rev-parse", "HEAD");
    git("switch", "-c", "feature");
    await mkdir(join(dir, "apps/web"), { recursive: true });
    await Bun.write(join(dir, "apps/web/page.ts"), "export {};\n");
    git("add", ".");
    git("commit", "-m", "web change");
    const head = git("rev-parse", "HEAD");

    git("switch", "main");
    await Bun.write(join(dir, "Cargo.toml"), "[workspace]\n");
    git("add", ".");
    git("commit", "-m", "unrelated Rust change");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("update-ref", "refs/remotes/origin/feature", head);

    const output = join(dir, "output");
    const findBase = (ref: string) =>
      run(["bash", "-e", "-o", "pipefail", "-c", base.run!], {
        BASE_REF: ref,
        HEAD: head,
        GITHUB_OUTPUT: output,
      });
    expect(findBase("missing").exitCode).not.toBe(0);
    expect(findBase(inputs.base_ref.default).exitCode).toBe(0);
    expect(await Bun.file(output).text()).toBe(`sha=${common}\n`);

    const plan = (track: string, sha: string, full: boolean) => {
      const result = run(["bash", "-e", "-o", "pipefail", "-c", select.run!], {
        TRACK: track,
        EVENT: "workflow_dispatch",
        BASE: sha,
        HEAD: head,
        DISPATCH_FULL: String(full),
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
      });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    expect(plan("changes", common, false)).toContain('checks=["web"]\n');
    expect(plan("changes", common, true)).toContain('"installer-crate"');
    expect(plan("changes", head, false)).toContain('"installer-crate"');
    expect(plan("installer", "", false)).toContain('checks=["installer-crate"]\n');
    expect(plan("web", "", false)).toContain('checks=["ci","deploy","coforge-sdk","web"]\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
