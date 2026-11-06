import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type AgentSessionReport,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentLaunchCoordinatorPorts } from "./agent-launch-coordinator";
import type { SessionReference } from "./launch-identity";
import type { LaunchPhaseTiming } from "./launch-phase-timing";
import type { LaunchRequest } from "./runtime-launch-types";
import { inferredReplacedSession, replacedSessionFor } from "./session-replacement";
import {
  connectionSessionInvalidate,
  runtimeDisplayName,
  sessionInvalidateActivityText,
} from "./session-invalidate-activity";
import { AgentSessionSupersededError } from "#src/agent-runtime/launch-failure";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** Whether the server's session report rejection says this launch or daemon instance is superseded. */
export function isSessionReportSuperseded(error: unknown): boolean {
  if (error instanceof AgentSessionSupersededError) return true;
  if (typeof error === "object" && error !== null) {
    if ((error as { category?: unknown }).category === "superseded") return true;
    if ((error as { code?: unknown }).code === 409) return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /superseded/iu.test(message);
}

export type SessionIdReporterPorts = Pick<
  AgentLaunchCoordinatorPorts,
  | "transport"
  | "reportAgentSession"
  | "envelope"
  | "isStopping"
  | "narrateUnavailable"
  | "connection"
  | "runtimeInstanceId"
>;

export type SessionIdReporterInput = Readonly<{
  agentId: string;
  provider: RuntimeProvider;
  launch: ActivityLaunch;
  current(): boolean;
  reference: SessionReference;
  request: LaunchRequest;
  recycled: boolean;
  recycledSessionId?: string;
  previousLaunchId?: string;
  timing?: LaunchPhaseTiming;
}>;

export type SessionIdReporter = Readonly<{
  onSessionId: ((sessionId: string, replacedSessionId?: string) => Promise<void>) | undefined;
  reportedSessionId(): string | undefined;
  driverReplacedSessionId(): string | undefined;
}>;

/** The provider's `onSessionId` callback for one launch: absent when the transport cannot
 * report sessions, and a state reader for the ids it observed once the process is up. */
export function sessionIdReporter(
  ports: SessionIdReporterPorts,
  input: SessionIdReporterInput,
): SessionIdReporter {
  const { agentId, provider, launch, reference, request, timing } = input;
  let reportedSessionId: string | undefined;
  let driverReplacedSessionId: string | undefined;
  const onSessionId = ports.transport().reportAgentSession
    ? async (reported: string, replaced?: string) => {
        reportedSessionId = reported;
        driverReplacedSessionId = replaced;
        return reportLaunchSession(
          {
            current: input.current,
            isStopping: () => ports.isStopping(),
            envelope: () => ports.envelope(),
            report: (report) => ports.reportAgentSession(report),
            invalidate: (sessionId) =>
              ports.transport().sendSessionInvalidate?.(
                connectionSessionInvalidate(ports.connection, ports.runtimeInstanceId, {
                  agentId,
                  provider,
                  sessionId,
                  launchId: launch.launchId,
                  reason: "missing",
                }),
              ),
            narrateReplaced: (sessionId) => {
              ports.narrateUnavailable(
                agentId,
                launch,
                sessionInvalidateActivityText(runtimeDisplayName(provider), sessionId, "missing"),
              );
            },
          },
          {
            agentId,
            provider,
            launchId: launch.launchId,
            reference,
            request,
            recycled: input.recycled,
            recycledSessionId: input.recycledSessionId,
            reportedSessionId,
            daemonInstanceId: ports.runtimeInstanceId,
            driverReplacedSessionId,
            previousLaunchId: input.previousLaunchId,
            timing,
          },
        );
      }
    : undefined;
  return {
    onSessionId,
    reportedSessionId: () => reportedSessionId,
    driverReplacedSessionId: () => driverReplacedSessionId,
  };
}

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
    if (isSessionReportSuperseded(error)) {
      logger.warning("Agent session report was superseded; stopping process", {
        event: "agent_session:report_superseded",
        agent_id: input.agentId,
        launch_id: input.launchId,
        provider: input.provider,
        error_code: diagnosticErrorCode(error),
      });
      throw new AgentSessionSupersededError();
    }
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
