import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type AgentSessionReport,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { SessionReference } from "./launch-identity";
import type { LaunchPhaseTiming } from "./launch-phase-timing";
import type { LaunchRequest } from "./runtime-launch-types";
import { inferredReplacedSession, replacedSessionFor } from "./session-replacement";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type LaunchSessionReportPorts = Readonly<{
  current(): boolean;
  isStopping(): boolean;
  envelope(): Pick<
    AgentSessionReport,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId"
  >;
  report(report: AgentSessionReport): Promise<void>;
  /** Fire-and-forget: tells the server the replaced session is gone, before the report. */
  invalidate(sessionId: string): void;
  /** Narrates the replaced session in this launch's Activity. */
  narrateReplaced(sessionId: string): void;
}>;

export type LaunchSessionReportInput = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  launchId: string;
  /** Updated in place after the report so a later rebind continues this session. */
  reference: SessionReference;
  request: LaunchRequest;
  recycled: boolean;
  recycledSessionId?: string;
  reportedSessionId: string;
  daemonInstanceId: string;
  driverReplacedSessionId?: string;
  previousLaunchId?: string;
  timing?: LaunchPhaseTiming;
}>;

/**
 * Reports one launch's native session. The report names the session it replaces whenever the
 * driver reported a different one than this launch was told to resume, even when the driver did
 * not say so itself: the server refuses an unnamed identity swap. The same condition invalidates
 * the stale session first.
 *
 * A refused report is a cloud observation failing, not the launch: the process keeps serving,
 * and the refusal is logged and recorded by the server's own rejection path. The connection
 * already retried the failures it classifies as temporary.
 */
export async function reportLaunchSession(
  ports: LaunchSessionReportPorts,
  input: LaunchSessionReportInput,
): Promise<void> {
  if (!ports.current() || ports.isStopping())
    throw new Error("Agent session launch was superseded");
  const { reference, request, reportedSessionId } = input;
  // The mode the provider was actually handed: a wake recycle always starts fresh, whatever
  // session this launch was originally asked to continue.
  const requestedSessionMode = input.recycled ? "create" : reference.sessionMode;
  const requestedSessionId = request.sessionId ?? reference.sessionId;
  const inferred = inferredReplacedSession({
    requestedSessionId,
    requestedSessionMode,
    reportedSessionId,
  });
  const replaced = replacedSessionFor({
    driverReplacedSessionId: input.driverReplacedSessionId,
    recycledSessionId: input.recycledSessionId,
    requestedReplacedSessionId: request.replacedSessionId,
    requestedSessionId,
    requestedSessionMode,
    reportedSessionId,
  });
  // A session replaced inside the driver, or one whose resume the driver turned into a fresh
  // session: only these emit here (not AgentControl's carried-over `request.replacedSessionId`,
  // already reported once).
  const replacementToInvalidate = input.driverReplacedSessionId ?? inferred;
  if (replacementToInvalidate) ports.invalidate(replacementToInvalidate);
  try {
    await ports.report({
      ...ports.envelope(),
      agentId: input.agentId,
      provider: input.provider,
      sessionId: reportedSessionId,
      ...(replaced ? { replacedSessionId: replaced } : {}),
      daemonInstanceId: input.daemonInstanceId,
      launchId: input.launchId,
      // Read live off `reference` (the same object `#rebindAgent` mutates in place), not the
      // request/control values captured at launch time: a driver-side replacement reported after
      // a rebind must carry the NEW request/epoch.
      startRequestId: reference.requestId,
      ...(reference.controlEpoch ? { controlEpoch: reference.controlEpoch } : {}),
      ...(input.previousLaunchId ? { previousLaunchId: input.previousLaunchId } : {}),
    });
    input.timing?.phase("session_reported");
  } catch (error) {
    logger.warning("Agent session report was not accepted; the launch continues", {
      event: "agent_session:report_deferred",
      agent_id: input.agentId,
      launch_id: input.launchId,
      provider: input.provider,
      error_code: diagnosticErrorCode(error),
    });
  }
  if (!ports.current()) return;
  reference.sessionId = reportedSessionId;
  reference.sessionMode = "resume";
  reference.launchId = input.launchId;
  if (replacementToInvalidate) ports.narrateReplaced(replacementToInvalidate);
}
