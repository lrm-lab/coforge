import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Step, parse } from "./workflow-helpers";

const deploy = await parse("deploy-staging.yml");

test("staging Web deploy skips Validate only when CI already succeeded on main for the exact commit", async () => {
  const step = (deploy.jobs["ci-status"].steps as Step[]).find((entry) => entry.id === "check")!;
  const dir = await mkdtemp(join(tmpdir(), "coforge-deploy-ci-status-"));
  try {
    const calls = join(dir, "calls");
    await Bun.write(
      join(dir, "gh"),
      `#!/bin/bash
printf '%s\\n' "$2" >> "${calls}"
[ "$3" = --jq ] && printf '%s' "$RUNS" | jq -r "$4"
`,
    );
    await chmod(join(dir, "gh"), 0o755);
    const check = async (name: string, runs: { event: string; conclusion: string }[]) => {
      const output = join(dir, `output-${name}`);
      const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", step.run!], {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          RUNS: JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
          REPOSITORY: "lrm-lab/coforge",
          SHA: "a".repeat(40),
          GITHUB_OUTPUT: output,
        },
      });
      expect(result.exitCode).toBe(0);
      return Bun.file(output).text();
    };
    expect(await check("push-ok", [{ event: "push", conclusion: "success" }])).toBe(
      "passed=true\n",
    );
    expect(
      await check("dispatch-ok", [{ event: "workflow_dispatch", conclusion: "success" }]),
    ).toBe("passed=true\n");
    expect(await check("pr-only", [{ event: "pull_request", conclusion: "success" }])).toBe(
      "passed=false\n",
    );
    expect(await check("push-fail", [{ event: "push", conclusion: "failure" }])).toBe(
      "passed=false\n",
    );
    expect(await check("empty", [])).toBe("passed=false\n");
    expect(await Bun.file(calls).text()).toContain(
      `repos/lrm-lab/coforge/actions/workflows/ci.yml/runs?branch=main&head_sha=${"a".repeat(40)}&status=completed&per_page=20\n`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
