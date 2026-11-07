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

test("a Start the Computer refused says why and what to do", () => {
  // As it reaches the page: the wire message, not the server's AppError instance.
  const wire = new Error(
    new AppError("CONFLICT", {
      errorId: "agent-control-failed",
      details: { reason: "runtime_login_required" },
    }).message,
  );
  expect(agentControlFailureMessage(wire)).toBe(
    m.agent_stop_reason_sentence({
      label: m.agent_stop_sign_in(),
      detail: m.agent_stop_sign_in_detail(),
    }),
  );
});

test("a reason with no guidance keeps the general message", () => {
  const wire = new Error(
    new AppError("CONFLICT", {
      errorId: "agent-control-failed",
      details: { reason: "runtime_start_failed" },
    }).message,
  );
  expect(agentControlFailureMessage(wire)).toBe(m.agent_control_submit_error());
});
