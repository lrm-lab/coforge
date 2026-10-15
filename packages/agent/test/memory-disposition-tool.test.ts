import { expect, test } from "bun:test";
import { createMemoryDispositionTool } from "../src/memory-disposition-tool";
import { createMemoryFenceTools, createSession, MemoryAgentTurnBudget } from "../src/runner";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("native receipt forwards only target-authored intent to the authenticated proxy", async () => {
  const calls: unknown[] = [];
  const tool = createMemoryDispositionTool({
    async post(path, body) {
      calls.push({ path, body });
      return { ok: true, duplicate: false };
    },
  });
  expect(tool.name).toBe("memory_disposition");
  const request = {
    hint_id: "hint",
    decision: "reject" as const,
    reason: "does not match constraints",
  };
  const result = await tool.execute("call", request, undefined, undefined, undefined as never);
  expect(calls).toEqual([{ path: "/api/agent/v1/memory-dispositions", body: request }]);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("expected text result");
  expect(JSON.parse(content.text)).toEqual({ ok: true, duplicate: false });
  expect(
    createMemoryFenceTools("openviking-memory", new MemoryAgentTurnBudget()).map(
      (entry) => entry.name,
    ),
  ).not.toContain("memory_disposition");
});

test("a fresh ordinary Pi task session has the native receipt tool before any Hint arrives", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "coforge-memory-receipt-tool-"));
  const agentDir = join(cwd, ".pi", "agent");
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    await mkdir(agentDir, { recursive: true });
    created = await createSession({
      cwd,
      agentDir,
      sessionDir: join(cwd, ".pi-sessions"),
      sessionKind: "pi",
      instructions: "Test only.",
      environment: {
        PI_OFFLINE: "1",
        COFORGE_EVAL_DISABLE_HOST_PI_INJECTION: "1",
        HOME: cwd,
      },
    });
    expect(created.session.getActiveToolNames()).toContain("memory_disposition");
    expect(created.session.getActiveToolNames()).toContain("bash");
  } finally {
    try {
      await created?.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
