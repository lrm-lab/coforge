import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bundling the session API into a main module does not start the RPC runner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coforge-agent-import-"));
  try {
    const source = join(directory, "consumer.ts");
    await Bun.write(
      source,
      "import { createSession } from " +
        JSON.stringify(new URL("../index.ts", import.meta.url).pathname) +
        "; console.log(typeof createSession);",
    );
    // Single-file server bundlers evaluate import.meta.main in the final entry's scope.
    const result = await Bun.build({
      entrypoints: [source],
      outdir: join(directory, "bundle"),
      target: "bun",
      define: { "import.meta.main": "true" },
    });
    expect(result.success, result.logs.map(String).join("\n")).toBe(true);
    const child = Bun.spawn([process.execPath, result.outputs[0]!.path], {
      env: { HOME: directory, PATH: Bun.env.PATH, PI_OFFLINE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    expect(stdout.trim()).toBe("function");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
