import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { handlePlatformMemoryRequest } from "#src/routes/api/agent/v1/memory";

const actor = { kind: "agent" as const, workspaceId: "workspace", agentId: "agent" };
const request = () =>
  new Request("https://example.invalid/api/agent/v1/memory", {
    method: "POST",
    body: JSON.stringify({ operation: "list" }),
  });
test("memory HTTP preserves revision conflict and retryable engine-unavailable refusals", async () => {
  for (const [code, status, retryable] of [
    ["CONFLICT", 409, false],
    ["TEMPORARILY_UNAVAILABLE", 503, true],
  ] as const) {
    const response = await handlePlatformMemoryRequest(request(), actor, async () => {
      throw new AppError(code);
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code, retryable });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
test("missing Agent identity is refused before memory executes", async () => {
  let called = false;
  const response = await handlePlatformMemoryRequest(request(), null, async () => {
    called = true;
    return { enabled: true, available: true, entries: [] };
  });
  expect(response.status).toBe(403);
  expect(called).toBe(false);
});
