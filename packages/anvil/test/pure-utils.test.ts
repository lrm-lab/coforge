import { expect, test } from "bun:test";
import {
  createAgentActivity,
  redactTrajectoryText,
  scrubRuntimeErrorText,
} from "@lrm/coforge-anvil";

const SECRET = `cfa_secret_${"q".repeat(43)}`;

test("Anvil keeps provider-neutral activity and error text behavior", () => {
  for (const text of [`the secret is ${SECRET}.`, `x=${SECRET}`, `cat file ${SECRET}\n`]) {
    expect(redactTrajectoryText(text)).not.toContain(SECRET);
    expect(scrubRuntimeErrorText(text)).not.toContain(SECRET);
  }
  expect(
    createAgentActivity("running_command", "info", "bun", "2026-08-27T00:00:00.000Z"),
  ).toMatchObject({
    detailKind: "running_command",
    observedAtMs: Date.parse("2026-08-27T00:00:00.000Z"),
  });
});
