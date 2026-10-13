import type {
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
  AgentWorkspaceFilesListRequest,
  AgentWorkspaceFilesListResult,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "./active-agent.server";

export type WorkspaceFilesViewer = { userId: string; workspaceId: string };
export type WorkspaceFilesAssignment = { computerId: string; revision: string };

export type PendingWorkspaceFilesList = {
  request: AgentWorkspaceFilesListRequest;
  userId: string;
  revision: string;
};
export type PendingWorkspaceFileRead = {
  request: AgentWorkspaceFileReadRequest;
  userId: string;
  revision: string;
};
export type PendingWorkspaceDelete = {
  request: AgentWorkspaceDeleteRequest;
  userId: string;
  revision: string;
};

export interface AgentWorkspaceFilesListResults {
  begin(pending: PendingWorkspaceFilesList): Promise<void>;
  read(requestId: string): Promise<AgentWorkspaceFilesListResult | undefined>;
  clear(requestId: string): Promise<void>;
}
export interface AgentWorkspaceFileReadResults {
  begin(pending: PendingWorkspaceFileRead): Promise<void>;
  read(requestId: string): Promise<AgentWorkspaceFileReadResult | undefined>;
  clear(requestId: string): Promise<void>;
}
export interface AgentWorkspaceDeleteResults {
  begin(pending: PendingWorkspaceDelete): Promise<void>;
  read(requestId: string): Promise<AgentWorkspaceDeleteResult | undefined>;
  clear(requestId: string): Promise<void>;
}

type WorkspaceFilesListResponse =
  | { status: "ready"; result: AgentWorkspaceFilesListResult }
  | { status: "offline" | "timeout" | "unavailable" };
type WorkspaceFileReadResponse =
  | { status: "ready"; result: AgentWorkspaceFileReadResult }
  | { status: "offline" | "timeout" | "unavailable" };
type WorkspaceDeleteResponse =
  | { status: "ready"; result: AgentWorkspaceDeleteResult }
  | { status: "offline" | "timeout" | "unavailable" };

/**
 * How long to wait before reading a pending result again. A Daemon usually answers within tens of
 * milliseconds, so a flat 100 ms poll made every observation cost at least 100 ms, and the Computer
 * page's workspace scan pays it once per directory, one directory at a time (the Daemon serves one
 * listing at a time). For the first half second the result is read every 20 ms, so an answer is seen
 * within 20 ms of arriving; after that the old 100 ms interval returns, so a slow or missing answer
 * costs only 20 extra reads over its 5 s timeout.
 */
function pollDelayMs(attempt: number) {
  return attempt < 25 ? 20 : 100;
}

/** Authorizes a fresh directory/file observation, not Computer inventory or session state. Same
 * publish/poll/timeout shape as `AgentSkillsQuery`, with two operations instead of one. */
export class AgentWorkspaceFilesQuery {
  constructor(
    private readonly dependencies: {
      findOwned(
        viewer: WorkspaceFilesViewer,
        agentId: string,
      ): Promise<WorkspaceFilesAssignment | undefined>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publishList(request: AgentWorkspaceFilesListRequest): Promise<void>;
      publishRead(request: AgentWorkspaceFileReadRequest): Promise<void>;
      listResults: AgentWorkspaceFilesListResults;
      readResults: AgentWorkspaceFileReadResults;
      publishDelete: (request: AgentWorkspaceDeleteRequest) => Promise<void>;
      deleteResults: AgentWorkspaceDeleteResults;
    },
    private readonly timing: {
      now: () => number;
      wait: (ms: number) => Promise<void>;
      timeoutMs: number;
    } = { now: Date.now, wait: (ms) => Bun.sleep(ms), timeoutMs: 5_000 },
  ) {}

  async list(
    viewer: WorkspaceFilesViewer,
    agentId: string,
    dirPath: string,
    includeHidden: boolean,
  ): Promise<WorkspaceFilesListResponse> {
    const { findOwned, online, publishList, listResults } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentWorkspaceFilesListRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
      dirPath,
      includeHidden,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await listResults.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publishList(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      let attempt = 0;
      do {
        const result = await listResults.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision ||
            !sameWorkspaceFilesListScope(request, result)
          )
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await listResults.clear(request.requestId).catch(() => {});
    }
  }

  async read(
    viewer: WorkspaceFilesViewer,
    agentId: string,
    path: string,
  ): Promise<WorkspaceFileReadResponse> {
    const { findOwned, online, publishRead, readResults } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentWorkspaceFileReadRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
      path,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await readResults.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publishRead(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      let attempt = 0;
      do {
        const result = await readResults.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision ||
            !sameWorkspaceFileReadScope(request, result)
          )
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await readResults.clear(request.requestId).catch(() => {});
    }
  }

  async delete(viewer: WorkspaceFilesViewer, agentId: string): Promise<WorkspaceDeleteResponse> {
    const { findOwned, online, publishDelete, deleteResults } = this.dependencies;
    const assignment = await findOwned(viewer, agentId);
    if (!assignment) return { status: "unavailable" };
    const request: AgentWorkspaceDeleteRequest = {
      protocolMajor: 1,
      requestId: crypto.randomUUID(),
      workspaceId: viewer.workspaceId,
      computerId: assignment.computerId,
      agentId,
    };
    try {
      if (!(await online(request))) return { status: "offline" };
      await deleteResults.begin({ request, userId: viewer.userId, revision: assignment.revision });
      await publishDelete(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      let attempt = 0;
      do {
        const result = await deleteResults.read(request.requestId);
        if (result) {
          const current = await findOwned(viewer, agentId);
          if (
            !current ||
            current.computerId !== assignment.computerId ||
            current.revision !== assignment.revision ||
            !sameWorkspaceDeleteScope(request, result)
          )
            return { status: "unavailable" };
          return { status: "ready", result };
        }
        await this.timing.wait(pollDelayMs(attempt++));
      } while (this.timing.now() < deadline);
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await deleteResults.clear(request.requestId).catch(() => {});
    }
  }
}

export function sameWorkspaceFilesListScope(
  a: AgentWorkspaceFilesListRequest,
  b: AgentWorkspaceFilesListRequest,
) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.dirPath === b.dirPath &&
    a.includeHidden === b.includeHidden
  );
}

export function sameWorkspaceFileReadScope(
  a: AgentWorkspaceFileReadRequest,
  b: AgentWorkspaceFileReadRequest,
) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId &&
    a.path === b.path
  );
}

export function sameWorkspaceDeleteScope(
  a: AgentWorkspaceDeleteRequest,
  b: AgentWorkspaceDeleteResult,
) {
  return (
    a.protocolMajor === b.protocolMajor &&
    a.requestId === b.requestId &&
    a.workspaceId === b.workspaceId &&
    a.computerId === b.computerId &&
    a.agentId === b.agentId
  );
}

/** Same ownership rule as `findOwnedSkillsAssignment`: the agent must belong to the viewer's
 * workspace, be owned by the viewer, and have an online-eligible Computer relationship. Workspace
 * Files has no use for `provider`, so this returns the narrower shape directly rather than going
 * through Skills' runtime-config parsing. */
export async function findOwnedWorkspaceFilesAssignment(
  db: PrismaClient,
  viewer: WorkspaceFilesViewer,
  id: string,
): Promise<WorkspaceFilesAssignment | undefined> {
  const agent = await db.agent.findFirst({
    where: {
      id,
      workspaceId: viewer.workspaceId,
      ownerId: viewer.userId,
      workspace: { members: { some: { userId: viewer.userId } } },
      computer: { workspaces: { some: { workspaceId: viewer.workspaceId } } },
      // Same live-view rule as `findOwnedSkillsAssignment`.
      ...ACTIVE_AGENT_WHERE,
    },
    select: { computerId: true, runtimeConfig: true },
  });
  if (!agent?.computerId) return undefined;
  return {
    computerId: agent.computerId,
    revision: new Bun.CryptoHasher("sha256")
      .update(JSON.stringify(agent.runtimeConfig))
      .digest("hex"),
  };
}
