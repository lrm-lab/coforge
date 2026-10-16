import { expect, test } from "bun:test";
import { agentControlFailureMessage } from "#src/features/agents/agent-runtime-controls";
import { AppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

test("a control action names why it was refused, and asks to retry only when retrying can help", () => {
  expect(agentControlFailureMessage(new AppError("ACCESS_DENIED"))).toBe(
    m.agent_control_access_denied(),
  );
  expect(agentControlFailureMessage(new AppError("CONFLICT", { errorId: "agent-migrating" }))).toBe(
    m.agent_control_migrating(),
  );
  expect(agentControlFailureMessage(new Error("network"))).toBe(m.agent_control_submit_error());
});
