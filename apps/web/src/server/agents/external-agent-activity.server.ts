import type { AppRateLimit } from "#src/server/app-rate-limits/app-rate-limit.server";
import {
  AGENT_ACTIVITY_DETAIL_KIND,
  type ActivityTrajectoryEntry,
  type AgentActivity,
  type AgentActivityKind,
  type AgentDisplaySnapshot,
  parseActivityEntries,
} from "@lrm/coforge-sdk/internal";
import type { ExternalActivityEvent } from "./external-agent-activity-ingest.server";
import { EXTERNAL_ONLINE_WINDOW_MS, externalDisplayScope } from "./external-agent-presence.server";
import type { AgentDisplay } from "./agent-display.server";

export type ExternalActivityRow = AgentActivity & { computerId: null };

export type ExternalActivityPorts = {
  claimEventIds(agent: ExternalAgentIds, eventIds: readonly string[]): Promise<Set<string>>;
  releaseEventIds(agent: ExternalAgentIds, eventIds: readonly string[]): Promise<void>;
  display: Pick<AgentDisplay, "observeExternalStatus">;
  rateLimit: AppRateLimit;
  statusReported: {
    isSet(agentId: string): Promise<boolean>;
    set(agentId: string, at: Date): Promise<void>;
  };
  record(rows: readonly ExternalActivityRow[]): Promise<void>;
  publishDisplay(snapshot: AgentDisplaySnapshot): Promise<void>;
  publishActivity(rows: readonly ExternalActivityRow[]): Promise<void>;
};

type ExternalAgentIds = { workspaceId: string; agentId: string };

const HOOK_DOT_GUESS: Readonly<Record<string, AgentActivityKind>> = {
  PreToolUse: "working",
  Stop: "online",
};

function hookRow(
  agent: ExternalAgentIds,
  event: ExternalActivityEvent,
): ExternalActivityRow | undefined {
  const { hook, subagent } = event;
  if (!hook) return undefined;
  const toolStart: ActivityTrajectoryEntry | undefined =
    hook.toolName && !hook.name.startsWith("Post")
      ? {
          kind: "tool_start",
          toolName: hook.toolName,
          ...(hook.toolInput ? { toolInput: hook.toolInput } : {}),
          ...(hook.callId ? { callId: hook.callId } : {}),
          ...(subagent
            ? {
                subagent: {
                  parentToolUseId: subagent.parentToolUseId,
                  ...(subagent.subagentType ? { subagentType: subagent.subagentType } : {}),
                },
              }
            : {}),
        }
      : undefined;
  const entries: ActivityTrajectoryEntry[] = toolStart ? [toolStart] : [];
  let detailKind: string;
  let detail = "";
  if (subagent) {
    detailKind = AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY;
    if (!toolStart)
      detail = `Subagent ${subagent.phase ?? hook.name}${subagent.subagentType ? ` (${subagent.subagentType})` : ""}`;
  } else if (toolStart) detailKind = AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED;
  else if (hook.toolName) detailKind = AGENT_ACTIVITY_DETAIL_KIND.TOOL_END;
  else if (hook.name === "Stop") detailKind = AGENT_ACTIVITY_DETAIL_KIND.IDLE;
  else return undefined;
  const requestId = `external:${event.eventId ?? crypto.randomUUID()}`;
  try {
    parseActivityEntries(entries);
  } catch {
    return undefined;
  }
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: agent.workspaceId,
    agentId: agent.agentId,
    detailKind,
    level: "info",
    detail,
    observedAtMs: event.occurredAtMs,
    launchId: requestId,
    clientSeq: 1,
    entries,
    computerId: null,
  };
}

export async function ingestExternalActivity(
  ports: ExternalActivityPorts,
  agent: ExternalAgentIds,
  events: readonly ExternalActivityEvent[],
  now: number,
): Promise<{ acceptedCount: number; rejectedCount: number }> {
  let rejectedCount = events.filter((event) => event.rejected).length;
  const candidates = events.filter((event) => !event.rejected);
  const ids = [...new Set(candidates.flatMap((event) => (event.eventId ? [event.eventId] : [])))];
  const claimed = ids.length > 0 ? await ports.claimEventIds(agent, ids) : new Set<string>();
  const taken = new Set<string>();
  const fresh = candidates.filter((event) => {
    if (!event.eventId) return true;
    if (!claimed.has(event.eventId) || taken.has(event.eventId)) return false;
    taken.add(event.eventId);
    return true;
  });
  rejectedCount += candidates.length - fresh.length;
  try {
    await applyEvents(
      ports,
      agent,
      [...fresh].sort((a, b) => a.occurredAtMs - b.occurredAtMs),
      now,
    );
  } catch (error) {
    await ports.releaseEventIds(agent, [...taken]).catch(() => {});
    throw error;
  }
  return { acceptedCount: fresh.length, rejectedCount };
}

async function applyEvents(
  ports: ExternalActivityPorts,
  agent: ExternalAgentIds,
  events: readonly ExternalActivityEvent[],
  now: number,
): Promise<void> {
  const rows: ExternalActivityRow[] = [];
  let newestReport: ExternalActivityEvent | undefined;
  let newestGuess: ExternalActivityEvent | undefined;
  for (const event of events) {
    const row = hookRow(agent, event);
    if (row) rows.push(row);
    if (event.subagent) continue;
    if (event.report) {
      if (!newestReport || event.occurredAtMs > newestReport.occurredAtMs) newestReport = event;
    } else if (event.hook && HOOK_DOT_GUESS[event.hook.name]) {
      if (!newestGuess || event.occurredAtMs > newestGuess.occurredAtMs) newestGuess = event;
    }
  }
  const scope = externalDisplayScope(agent.workspaceId, agent.agentId);
  let latest: AgentDisplaySnapshot | undefined;
  if (newestReport?.report) {
    await ports.statusReported.set(agent.agentId, new Date(now));
    latest = await ports.display.observeExternalStatus(scope, {
      kind: newestReport.report.kind,
      detail: newestReport.report.detail,
      occurredAtMs: newestReport.occurredAtMs,
      reported: true,
      windowMs: EXTERNAL_ONLINE_WINDOW_MS,
    });
  } else if (newestGuess?.hook && !(await ports.statusReported.isSet(agent.agentId))) {
    latest = await ports.display.observeExternalStatus(scope, {
      kind: HOOK_DOT_GUESS[newestGuess.hook.name]!,
      detail: "",
      occurredAtMs: newestGuess.occurredAtMs,
      reported: false,
      windowMs: EXTERNAL_ONLINE_WINDOW_MS,
    });
  }
  if (rows.length > 0) {
    await ports.record(rows);
    await ports.publishActivity(rows).catch(() => {});
  }
  if (latest) await ports.publishDisplay(latest).catch(() => {});
}
