import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { updateNoticeLine } from "#src/update-notice";

const transport = (notice: string | null | Error) => ({
  computerUpdateNotice: async () => {
    if (notice instanceof Error) throw notice;
    return { ok: true as const, notice };
  },
});

describe("the Computer-update notice line", () => {
  test("a noticed release returns its line", async () => {
    expect(await updateNoticeLine(transport("newer release"), ["task", "list"])).toBe(
      "newer release",
    );
  });

  test("nothing to say returns nothing", async () => {
    expect(await updateNoticeLine(transport(null), ["task", "list"])).toBeUndefined();
  });

  test("`--json` output stays machine-only", async () => {
    expect(
      await updateNoticeLine(transport("newer release"), ["task", "list", "--json"]),
    ).toBeUndefined();
  });

  test("an unreachable daemon adds no line", async () => {
    expect(await updateNoticeLine(transport(new Error("down")), ["task", "list"])).toBeUndefined();
  });
});

describe("the CLI's notice tail", () => {
  test("the line lands on stderr after the output, and the exit code is unchanged", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (request) =>
        new Response(
          request.url.includes("computer-update-notice")
            ? JSON.stringify({ ok: true, notice: "fake notice line" })
            : "{}",
        ),
    });
    try {
      const cli = join(import.meta.dir, "../src/cli.ts");
      const script = `import { runAgentCli } from ${JSON.stringify(cli)};
await runAgentCli(["--help"]);`;
      const proc = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          COFORGE_AGENT_CONTEXT: `sfp_${"a".repeat(43)}`,
          COFORGE_AGENT_PROXY_URL: `http://127.0.0.1:${server.port}`,
        },
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(0);
      expect(stderr).toContain("fake notice line");
      expect(stdout).not.toContain("fake notice line");
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
