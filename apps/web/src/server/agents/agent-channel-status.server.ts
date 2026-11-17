import type { AgentDisplay } from "./agent-display.server";
import type { ExternalSetup } from "./external-agent-presence.server";

export type AgentChannelStatus = {
  status: "online" | "offline" | "unknown";
  activity?: string;
  activityDetail?: string;
};

type Scope = { workspaceId: string; computerId: string | null; agentId: string };
type Snapshot = Awaited<ReturnType<AgentDisplay["snapshot"]>>;

export async function resolveAgentChannelStatus(
  display: Pick<AgentDisplay, "snapshot">,
  scope: Scope,
): Promise<AgentChannelStatus> {
  if (!scope.computerId) return { status: "unknown" };
  try {
    return statusFromSnapshot(
      await display.snapshot({
        workspaceId: scope.workspaceId,
        computerId: scope.computerId,
        agentId: scope.agentId,
      }),
    );
  } catch {
    return { status: "unknown" };
  }
}

export async function resolveAgentChannelStatuses(
  display: Pick<AgentDisplay, "snapshot" | "snapshotMany">,
  scopes: readonly Scope[],
  external:
    | ReadonlyMap<string, ExternalSetup>
    | Promise<ReadonlyMap<string, ExternalSetup> | undefined> = new Map(),
): Promise<AgentChannelStatus[]> {
  const [setups, displayed] = await Promise.all([
    external,
    resolveDisplayedStatuses(display, scopes),
  ]);
  return scopes.map((scope, index) => {
    const setup = setups?.get(scope.agentId);
    if (setup) return { status: setup.state === "online" ? "online" : "offline" };
    return displayed[index]!;
  });
}

async function resolveDisplayedStatuses(
  display: Pick<AgentDisplay, "snapshot" | "snapshotMany">,
  scopes: readonly Scope[],
): Promise<AgentChannelStatus[]> {
  const bound = scopes.flatMap((scope) =>
    scope.computerId
      ? [{ workspaceId: scope.workspaceId, computerId: scope.computerId, agentId: scope.agentId }]
      : [],
  );
  if (bound.length === 0) return scopes.map(() => ({ status: "unknown" }));
  try {
    const snapshots = await display.snapshotMany(bound);
    const byAgentId = new Map<string, Snapshot | undefined>(
      bound.map((scope, index) => [scope.agentId, snapshots[index]]),
    );
    return scopes.map((scope) => {
      const snapshot = byAgentId.get(scope.agentId);
      return snapshot ? statusFromSnapshot(snapshot) : { status: "unknown" };
    });
  } catch {
    return Promise.all(scopes.map((scope) => resolveAgentChannelStatus(display, scope)));
  }
}

function statusFromSnapshot(snapshot: Snapshot): AgentChannelStatus {
  if (snapshot.activityKind === "offline") return { status: "offline" };
  if (snapshot.activityKind === "online") return { status: "online" };
  return {
    status: "online",
    activity: snapshot.activityKind,
    ...(snapshot.detail ? { activityDetail: snapshot.detail } : {}),
  };
}
