import { expect, test } from "bun:test";
import {
  agentMigrationErrorMessage,
  agentMigrationStatusLine,
  isAgentMigrationInProgress,
  isAgentMigrationShown,
  agentMigrationRefusal,
  agentMigrationSteps,
} from "#src/features/agents/agent-migration";
import { AppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

test("each stage of a move reads as what is happening, naming the Computer it goes to", () => {
  const status = (state: string, errorCode: string | null = null) =>
    agentMigrationStatusLine({ state, errorCode }, "Studio Mac", "Old Laptop");
  expect(status("requested")).toBe(m.agent_migration_status_stopping({ computer: "Studio Mac" }));
  expect(status("source_stopped")).toBe(
    m.agent_migration_status_uploading({ computer: "Studio Mac" }),
  );
  expect(status("uploaded")).toBe(m.agent_migration_status_placing({ computer: "Studio Mac" }));
  expect(status("placing")).toBe(m.agent_migration_status_placing({ computer: "Studio Mac" }));
  expect(status("switched")).toBe(m.agent_migration_status_starting({ computer: "Studio Mac" }));
  // Done: where it came from, where it is, and that it runs a fresh session there.
  expect(status("completed")).toBe(
    m.agent_migration_status_completed({ source: "Old Laptop", computer: "Studio Mac" }),
  );
  expect(status("canceled")).toBe(m.agent_migration_status_canceled());
  expect(status("failed", "lease_expired")).toBe(
    m.agent_migration_status_failed({ reason: m.agent_migration_reason_lease_expired() }),
  );
  // A code with no wording of its own still reads as words, never as the code.
  expect(status("failed", "bucket_refused")).toBe(
    m.agent_migration_status_failed({ reason: m.agent_migration_reason_transfer() }),
  );
  expect(
    ["requested", "source_stopped", "uploaded", "placing", "switched"].every(
      isAgentMigrationInProgress,
    ),
  ).toBe(true);
  expect(["completed", "failed", "canceled"].some(isAgentMigrationInProgress)).toBe(false);
});

test("a refused move says why, and asks to retry only when a retry can help", () => {
  const refusal = (
    code: "INVALID_INPUT" | "CONFLICT" | "TEMPORARILY_UNAVAILABLE" | "ACCESS_DENIED",
    errorId?: string,
  ) => agentMigrationErrorMessage(new AppError(code, errorId ? { errorId } : {}));
  expect(refusal("CONFLICT", "agent-migrating")).toBe(m.agent_migration_error_already_moving());
  expect(refusal("INVALID_INPUT", "agent-migration-same-computer")).toBe(
    m.agent_migration_error_same_computer(),
  );
  expect(refusal("INVALID_INPUT", "agent-migration-target-unavailable")).toBe(
    m.agent_migration_error_target_unavailable(),
  );
  expect(refusal("TEMPORARILY_UNAVAILABLE", "agent-migration-source-unreachable")).toBe(
    m.agent_migration_error_source_unreachable(),
  );
  expect(refusal("TEMPORARILY_UNAVAILABLE", "agent-migration-unavailable")).toBe(
    m.agent_migration_error_unavailable(),
  );
  expect(refusal("INVALID_INPUT", "agent-migration-unplaced")).toBe(
    m.agent_migration_error_unplaced(),
  );
  expect(refusal("ACCESS_DENIED")).toBe(m.agent_form_not_authorized());
  expect(agentMigrationErrorMessage(new Error("network"))).toBe(m.agent_migration_error_generic());
});

test("a move that ended stays shown for a day, and one still going always", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000).toISOString();
  expect(isAgentMigrationShown({ state: "completed", updatedAt: at(23) }, now)).toBe(true);
  expect(isAgentMigrationShown({ state: "completed", updatedAt: at(25) }, now)).toBe(false);
  expect(isAgentMigrationShown({ state: "placing", updatedAt: at(48) }, now)).toBe(true);
});

test("a move reads as four steps: those behind it done, the one under way current", () => {
  const steps = (state: string) => agentMigrationSteps(state).map((step) => step.status);
  expect(agentMigrationSteps("requested").map((step) => step.label)).toEqual([
    m.agent_migration_step_stop(),
    m.agent_migration_step_upload(),
    m.agent_migration_step_place(),
    m.agent_migration_step_start(),
  ]);
  expect(steps("requested")).toEqual(["current", "pending", "pending", "pending"]);
  expect(steps("source_stopped")).toEqual(["done", "current", "pending", "pending"]);
  expect(steps("uploaded")).toEqual(["done", "done", "current", "pending"]);
  expect(steps("placing")).toEqual(["done", "done", "current", "pending"]);
  expect(steps("switched")).toEqual(["done", "done", "done", "current"]);
  expect(steps("completed")).toEqual(["done", "done", "done", "done"]);
});

test("a move that cannot start says which Computer holds it back, and where to fix it", () => {
  const refusal = (
    errorId: string,
    code: "TEMPORARILY_UNAVAILABLE" | "INVALID_INPUT" = "TEMPORARILY_UNAVAILABLE",
  ) => agentMigrationRefusal(new AppError(code, { errorId }));
  expect(refusal("agent-migration-source-outdated")).toEqual({
    message: m.agent_migration_source_outdated(),
    fixAt: "source",
  });
  expect(refusal("agent-migration-source-offline")).toEqual({
    message: m.agent_migration_source_offline(),
    fixAt: "source",
  });
  expect(refusal("agent-migration-target-outdated")).toEqual({
    message: m.agent_migration_target_outdated(),
    fixAt: "target",
  });
  expect(refusal("agent-migration-target-offline")).toEqual({
    message: m.agent_migration_target_offline(),
    fixAt: "target",
  });
  expect(refusal("agent-migration-runtime-unavailable", "INVALID_INPUT")).toEqual({
    message: m.agent_migration_error_runtime_unavailable(),
    fixAt: "target",
  });
  // A Computer that is gone is fixed on the Computers page, not on its own.
  expect(refusal("agent-migration-target-unavailable", "INVALID_INPUT")).toEqual({
    message: m.agent_migration_error_target_unavailable(),
    fixAt: "computers",
  });
  // A refusal no Computer page can fix offers no link.
  expect(refusal("agent-migration-unavailable")).toEqual({
    message: m.agent_migration_error_unavailable(),
    fixAt: null,
  });
  expect(agentMigrationRefusal(new Error("network"))).toEqual({
    message: m.agent_migration_error_generic(),
    fixAt: null,
  });
});
