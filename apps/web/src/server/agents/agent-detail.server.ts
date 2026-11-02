import type { Prisma } from "#src/generated/prisma/client";
import type { AgentStatusCache } from "./agent-status.server";
import type { AgentDisplay } from "./agent-display.server";
import { appLogoUrl } from "#src/server/apps/app-logo.server";
import { canDirectMessageAgent } from "./agent-visibility.server";

type DetailComputer = {
  id: string;
  /** The Computer's owner: only they may scan or delete an Agent workspace on it. */
  ownerId?: string;
  name: string;
  displayName: string;
  kind: string;
  /** Last-observed Computer executable version (`server/computers/computer-metadata.server.ts`).
   * Surfaced only in the Agent profile panel's Computer meta line; the full detail page does not
   * render it today. */
  computerVersion?: string | null;
};

type DetailAgent = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  description?: string;
  role: string;
  createdAt: Date;
  computerId?: string | null;
  computer?: DetailComputer | null;
  owner: {
    id: string;
    username: string;
    displayName?: string | null;
    avatarObjectKey?: string | null;
  };
  runtimeConfig: Prisma.JsonValue;
  weeklyReportAssistant?: { id: string } | null;
  /** Set when a user stopped this Agent. */
  stoppedAt?: Date | null;
  /** Who can see this Agent; optional so a caller that has not started selecting it
   * yet still satisfies this type. */
  visibility?: string;
  avatarMascot?: string | null;
  /** Set for an app's bot (`server/app-bots/`): the app it speaks for, as it is now. */
  appBot?: {
    state: string;
    statusText: string | null;
    installation: {
      app: { key: string; name: string; ownerWorkspaceId: string; logoObjectKey: string | null };
    };
  } | null;
  /** Set once the Agent is deleted; its profile stays readable. */
  deletedAt?: Date | null;
  /** Who deleted it, when that was recorded. */
  deletedBy?: { id: string; username: string; displayName?: string | null } | null;
};

export type AgentDetailSource = {
  findAuthorized(
    workspaceId: string,
    agentId: string,
    userId: string,
  ): Promise<DetailAgent | undefined>;
};

function assignedComputer(agent: DetailAgent) {
  const computer = agent.computer;
  if (!agent.computerId || !computer) return undefined;
  return {
    id: computer.id,
    label: computer.displayName.trim() || computer.name.trim(),
    kind: computer.kind,
    computerVersion: computer.computerVersion ?? null,
    ...(computer.ownerId ? { ownerId: computer.ownerId } : {}),
  };
}

/** What the profile shows of an app's bot: the app now, and the line the app published (while the
 * grant stands). The logo is a URL, none shows the app's monogram. */
function appBotIdentity(bot: NonNullable<DetailAgent["appBot"]>) {
  const { app } = bot.installation;
  return {
    appKey: app.key,
    appName: app.name,
    logoUrl: appLogoUrl(app.ownerWorkspaceId, app.key, app.logoObjectKey),
    statusText: bot.state === "granted" ? bot.statusText : null,
  };
}

export class AgentDetailQuery {
  constructor(
    private readonly source: AgentDetailSource,
    private readonly status?: Pick<AgentStatusCache, "snapshot">,
    private readonly display?: Pick<AgentDisplay, "snapshot">,
  ) {}

  async get(workspaceId: string, agentId: string, userId: string) {
    const agent = await this.source.findAuthorized(workspaceId, agentId, userId);
    if (!agent) return undefined;
    // The two reads are independent stores, so they overlap rather than queue: the page waits for
    // the slower of the two, not for both in turn. Each keeps its own failure mode — a failed
    // status read is reported as unknown, and a failed display read just loses the display block.
    const scope = agent.computerId
      ? { workspaceId, computerId: agent.computerId, agentId }
      : undefined;
    let statusReadFailed = false;
    const [status, display] = await Promise.all([
      scope && this.status
        ? this.status.snapshot(scope).catch(() => {
            statusReadFailed = true;
            return undefined;
          })
        : undefined,
      scope && this.display ? this.display.snapshot(scope).catch(() => undefined) : undefined,
    ]);
    const assigned = assignedComputer(agent);
    const bot = agent.appBot && appBotIdentity(agent.appBot);
    return {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      // An app's bot takes the app's name and logo at read time, not the ones it was granted with.
      displayName: bot?.appName ?? agent.displayName,
      description: agent.description,
      appBot: bot ?? null,
      role: agent.role,
      createdAt: agent.createdAt,
      computerId: agent.computerId,
      owner: agent.owner,
      runtimeConfig: agent.runtimeConfig,
      isWeeklyReportAssistant: Boolean(agent.weeklyReportAssistant),
      stopped: Boolean(agent.stoppedAt),
      visibility: agent.visibility,
      avatarMascot: agent.avatarMascot ?? null,
      deletedAt: agent.deletedAt ?? null,
      deletedBy: agent.deletedBy ?? null,
      /** The viewer may open a direct conversation with it (`DirectConversations.open`). */
      canMessage:
        !agent.deletedAt &&
        canDirectMessageAgent(userId, {
          visibility: agent.visibility ?? "",
          ownerId: agent.owner.id,
        }),
      ...(display ? { display } : {}),
      status: {
        value: statusReadFailed ? ("unknown" as const) : (status?.status ?? ("inactive" as const)),
        expiresAt: status?.expiresAt ?? null,
        ordering: status
          ? {
              daemonInstanceId: status.daemonInstanceId,
              clientSeq: status.clientSeq,
              observedAtMs: status.observedAtMs,
            }
          : null,
      },
      computer: assigned,
    };
  }
}
