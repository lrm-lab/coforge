import { getLogger } from "@logtape/logtape";
import type { AgentControlScope, AgentStartIntent } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeRecord } from "./agent-runtime-state";
import type { AgentControlContext } from "./agent-control-runtime";
import { carriesStartPrompt } from "./agent-control-replay";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/**
 * A Start met an already-running process under an older, terminal operation.
 * Keeps the process — never spawns, never stops it — and adopts the new scope: the record
 * moves to the new epoch/requestId, keeps `identity`/`daemonInstanceId`, and takes the new
 * `launchId` the server minted for this operation. Sequence restarts the way a fresh record's
 * does; the previous epoch's stop/workspace-reset/start receipts are dropped so they cannot
 * leak into this new epoch's equal-epoch replay branch (`record.startResult` below is this
 * epoch's own, freshly built). Call only inside the `state.run(agentId, ...)` mutex `start()`
 * already holds — it takes no lock of its own, so no second in-flight launch is possible.
 */
export async function rebindRunning(
  { state, sessions, runtime }: Pick<AgentControlContext, "state" | "sessions" | "runtime">,
  record: AgentRuntimeRecord,
  scope: AgentControlScope,
  intent: AgentStartIntent,
): Promise<void> {
  const launchId = intent.launchId as string; // checked by the caller before this is reached.
  const previousEpoch = record.scope.epoch;
  record.scope = scope;
  record.action = "start";
  record.launchId = launchId;
  record.sequence = 0;
  delete record.stopResult;
  delete record.workspaceResetResult;
  delete record.startResult;
  // Never touches `daemonInstanceId` (this daemon instance already owns the running process,
  // confirmed by `runtime.running()`) — "keeps identity, daemonInstanceId" per the brief.
  await state.store.write(scope.agentId, record);
  // Re-points every place the runtime remembers this launch's requestId/controlEpoch/launchId
  // fence (session reference, activity launch, pending Activity/invalidate bookkeeping) and
  // sends the immediate Session re-report + `agent:status(active)` under the new scope; returns
  // the running process's current identity, exactly like a fresh `launch` would.
  const identity = await runtime.rebind(intent, launchId);
  record.identity = identity ?? record.identity;
  record.startResult = {
    ...scope,
    phase: "started",
    launchId,
    sequence: ++record.sequence,
    ...(record.identity ? { identity: record.identity } : {}),
  };
  record.lastResult = record.startResult;
  sessions.capture(record, record.identity);
  await state.store.write(scope.agentId, record);
  // Reuses the same hook the equal-epoch replay branch already uses to deliver a Start's wake
  // message (and prompts) to a running process — never spawns anything.
  if (intent.wakeMessage || carriesStartPrompt(intent)) await runtime.wake?.(intent);
  await runtime.result(record.lastResult).catch(() => {});
  logger.info("Agent Start rebound to an already-running process", {
    event: "agent_control:start_rebound",
    agent_id: scope.agentId,
    request_id: scope.requestId,
    previous_epoch: previousEpoch,
    epoch: scope.epoch,
    launch_id: launchId,
    outcome: "rebound",
  });
}
