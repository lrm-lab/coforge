import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cases = [
  ["index.ts", "./src/grok/provider", false],
  ["src/neutral.ts", "#src/kiro/provider", false],
  ["index.ts", "@lrm/coforge-anvil/grok", false],
  ["index.ts", "@lrm/coforge-anvil/dsh", false],
  ["src/neutral.ts", "#src/dsh/provider", false],
  ["src/dsh/provider.ts", "#src/jsonl-process", true],
  ["index.ts", "./src/execution", false],
  ["src/neutral.ts", "#src/jsonl-process", false],
  ["index.ts", "@lrm/coforge-anvil/execution", false],
  ["index.ts", "./src/per-turn/session", false],
  ["src/neutral.ts", "./process-tree-cleanup", false],
  ["src/grok/provider.ts", "#src/jsonl-process", true],
  ["index.ts", "./src/jsonl-error", true],
] as const;

for (const [file, specifier, allowed] of cases) {
  test(
    "Anvil dependency scan " + (allowed ? "accepts " : "rejects ") + file + " -> " + specifier,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "anvil-boundary-"));
      try {
        const guard = join(directory, "scripts/ci/anvil-boundary.test.ts");
        await mkdir(join(directory, "scripts/ci"), { recursive: true });
        await Bun.write(guard, Bun.file(new URL("./anvil-boundary.test.ts", import.meta.url)));
        const sourceRoot = join(directory, "packages/anvil");
        for (const path of [
          "index.ts",
          "src/neutral.ts",
          "src/jsonl-error.ts",
          "src/jsonl-process.ts",
          "src/execution.ts",
          "src/process-tree-cleanup.ts",
          "src/per-turn/session.ts",
          "src/grok/provider.ts",
          "src/kiro/provider.ts",
          "src/dsh/provider.ts",
        ]) {
          await Bun.write(join(sourceRoot, path), "export {};");
        }
        await Bun.write(join(sourceRoot, file), 'export * from "' + specifier + '";');
        const child = Bun.spawn([process.execPath, "test", guard], {
          cwd: directory,
          env: { PATH: Bun.env.PATH },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        const output = stdout + stderr;
        expect(code, output).toBe(allowed ? 0 : 1);
        if (!allowed) {
          expect(output).toContain(
            "Keep runtime and execution implementations out of provider-neutral modules",
          );
          expect(output).toContain(file + ": " + specifier);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
