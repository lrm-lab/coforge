import { expect, test } from "bun:test";
import { createAgentActivity } from "@lrm/coforge-anvil";

test("creates one provider-neutral activity shape for commands and diagnostics", () => {
  expect(
    createAgentActivity("running_command", "info", "bun test", "2026-08-27T00:00:00.000Z"),
  ).toEqual({
    detailKind: "running_command",
    level: "info",
    detail: "bun test",
    observedAtMs: Date.parse("2026-08-27T00:00:00.000Z"),
  });
});
