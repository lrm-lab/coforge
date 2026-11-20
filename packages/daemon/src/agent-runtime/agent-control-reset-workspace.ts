import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode, type AgentWorkspaceResetRequest } from "@lrm/coforge-sdk/internal";
import type { AgentControlContext } from "./agent-control-runtime";
import { fence, repairStaleRecord } from "./agent-control-fence";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

export function resetAgentWorkspace(
  context: AgentControlContext,
  known: Set<string>,
  scope: AgentWorkspaceResetRequest,
): Promise<void> {
  return context.state.run(scope.agentId, async () => {
    let record = await context.state.store.read(scope.agentId);
    record = await repairStaleRecord(context, scope.agentId, record);
    fence(record, scope);
    if (!record || record.scope.epoch !== scope.epoch || record.stopResult?.phase !== "stopped")
      throw new Error("confirmed_stop_required");
    known.add(scope.agentId);
    if (record.workspaceResetResult) {
      if (record.workspaceResetResult.requestId !== scope.requestId)
        throw new Error("control_request_mismatch");
      await context.runtime.result(record.workspaceResetResult).catch(() => {});
      return;
    }
    if (
      !["stopped", "clearing"].includes(record.phase) ||
      record.startResult ||
      context.runtime.running(scope.agentId)
    )
      throw new Error("confirmed_stop_required");
    record.action = "reset-workspace";
    record.phase = "clearing";
    await context.state.store.write(scope.agentId, record);
    // A clear failure is non-fatal (liveness over durable receipts): it never latches the
    // Agent into a terminal state only an explicit reset retry could leave. The session
    // association is still cleared locally and the chain still proceeds to Start. The failure
    // is only logged: there is no result field, state, or anything else that blocks a later
    // agent:start.
    let workspaceClearError = false;
    try {
      await context.state.store.clearWorkspace(scope.agentId);
    } catch (error) {
      workspaceClearError = true;
      logger.error("Agent workspace clear did not complete", {
        event: "agent_control:workspace_clear_failed",
        request_id: scope.requestId,
        workspace_id: scope.workspaceId,
        computer_id: scope.computerId,
        agent_id: scope.agentId,
        error_code: diagnosticErrorCode(error),
        outcome: "failed",
      });
    }
    context.sessions.clear(record);
    record.phase = "workspace-reset";
    record.workspaceResetResult = {
      ...scope,
      phase: "workspace-reset",
      sequence: ++record.sequence,
      ...(workspaceClearError ? { errorCode: "workspace_clear_failed" } : {}),
    };
    record.lastResult = record.workspaceResetResult;
    await context.state.store.write(scope.agentId, record);
    await context.runtime.result(record.lastResult).catch(() => {});
  });
}
