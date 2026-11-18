import { expect, test } from "bun:test";
import { workbenchRequirements } from "#src/server/pi-chat/pi-chat-production.server";

const sessionId = crypto.randomUUID();

test("personal Computers require explicit Codex routing for every workbench operation", () => {
  expect(workbenchRequirements("local", { action: "list" })).toBeUndefined();
  expect(
    workbenchRequirements("local", {
      action: "start",
      message: "test",
      requestId: crypto.randomUUID(),
      runtime: "pi",
    }),
  ).toBeUndefined();
  expect(workbenchRequirements("local", { action: "read", sessionId, runtime: "codex" })).toEqual({
    codex: true,
    files: false,
    controls: false,
  });
  expect(
    workbenchRequirements("local", { action: "files", path: "", runtime: "codex" }),
  ).toBeUndefined();
  expect(workbenchRequirements("cloud", { action: "files", path: "" })).toEqual({
    codex: false,
    files: true,
    controls: false,
  });
});
