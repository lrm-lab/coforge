import { expect, test } from "bun:test";
import {
  agentMigrationErrorMessage,
  agentMigrationStatusLine,
  isAgentMigrationInProgress,
} from "#src/features/agents/agent-migration";
import { AppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

test("each stage of a move reads as what is happening, naming the Computer it goes to", () => {
  const status = (state: string, errorCode: string | null = null) =>
    agentMigrationStatusLine({ state, errorCode }, "Studio Mac");
  expect(status("requested")).toBe(m.agent_migration_status_stopping({ computer: "Studio Mac" }));
  expect(status("source_stopped")).toBe(
    m.agent_migration_status_uploading({ computer: "Studio Mac" }),
  );
  expect(status("uploaded")).toBe(m.agent_migration_status_placing({ computer: "Studio Mac" }));
  expect(status("placing")).toBe(m.agent_migration_status_placing({ computer: "Studio Mac" }));
  expect(status("switched")).toBe(m.agent_migration_status_starting({ computer: "Studio Mac" }));
  expect(status("completed")).toBe(m.agent_migration_status_completed({ computer: "Studio Mac" }));
  expect(status("canceled")).toBe(m.agent_migration_status_canceled());
  expect(status("failed", "lease_expired")).toBe(
    m.agent_migration_status_failed({ reason: "lease_expired" }),
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
  expect(refusal("ACCESS_DENIED")).toBe(m.agent_form_not_authorized());
  expect(agentMigrationErrorMessage(new Error("network"))).toBe(m.agent_migration_error_generic());
});
