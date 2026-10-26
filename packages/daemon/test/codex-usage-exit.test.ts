import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";

const runner = new URL("./fixtures/codex-usage-exit.ts", import.meta.url).pathname;

for (const [scenario, expected] of [
  ["usage", { kind: "snapshot", health: "ok" }],
  ["usage-legacy", { kind: "snapshot", health: "ok" }],
  ["usage-auth", { kind: "null" }],
  ["usage-apikey", { kind: "error", message: "Usage scanning is unsupported for this account" }],
] as const) {
  test(
    "Codex usage caller naturally exits after " + scenario,
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "codex-usage-exit-"));
      try {
        const child = Bun.spawn([process.execPath, runner, scenario], {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const [output, errors, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(JSON.parse(output)).toEqual(expected);
        expect(errors).toBe("");
        expect(exitCode).toBe(0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
    3 * 30_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS + 2_000,
  );
}
