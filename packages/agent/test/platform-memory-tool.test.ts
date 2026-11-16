import { expect, test } from "bun:test";
import { createTaskMemoryTools } from "../src/task-memory-tools";
import { createPlatformMemoryTool } from "../src/platform-memory-tool";

test("personal/team tools are opt-in and never widen the Memory Agent fence", () => {
  const proxy = {
    async post() {
      return {};
    },
  };
  expect(createTaskMemoryTools(undefined, {}, proxy).map((t) => t.name)).toEqual([
    "memory_disposition",
  ]);
  expect(
    createTaskMemoryTools(
      undefined,
      { COFORGE_WORKSPACE_FEATURES: '{"platformMemory":true}' },
      proxy,
    ).map((t) => t.name),
  ).toEqual(["memory_disposition", "platform_memory"]);
  expect(
    createTaskMemoryTools(
      "openviking-memory",
      { COFORGE_WORKSPACE_FEATURES: '{"platformMemory":true}' },
      proxy,
    ),
  ).toEqual([]);
});
test("a native create defaults to private memory and sends the stable mutation request id", async () => {
  const seen: unknown[] = [];
  const tool = createPlatformMemoryTool({
    async post(path, body) {
      seen.push({ path, body });
      return { enabled: true, available: true, entries: [] };
    },
  });
  const requestId = "11111111-1111-4111-8111-111111111111";
  await tool.execute(
    "tool-call",
    {
      operation: "create",
      title: "Release",
      content: "Run tests",
      requestId,
    },
    undefined,
    undefined,
    undefined as never,
  );
  expect(seen).toEqual([
    {
      path: "/api/agent/v1/memory",
      body: {
        operation: "create",
        scope: "agent",
        requestId,
        title: "Release",
        content: "Run tests",
        kind: "fact",
      },
    },
  ]);
});
