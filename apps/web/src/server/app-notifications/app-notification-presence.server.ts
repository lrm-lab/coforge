import { getDatabaseClient } from "#src/server/db/client.server";
import {
  newAppNotificationEvent,
  type AppNotificationEvent,
  type AppNotificationEventPayload,
} from "./app-notification-event";
import { AppNotifications, appNotificationsPossible } from "./app-notifications.server";
import type { PresenceObserver } from "./presence-observer";

type WorkspaceIdentity = { id: string; slug: string };

/** Names the presence event UUIDv5 namespace; a fixed value, so the same transition always gets
 * the same event id and the queue drops the duplicate. */
const PRESENCE_NAMESPACE = "b3a8f4c2-5d1e-5f7a-8c92-4e6d0a1b7f35";

/** How long a Workspace's slug is remembered; the flag is evaluated with it, and a rename must
 * take effect within this. */
const IDENTITY_TTL_MS = 60_000;
const IDENTITY_CACHE_LIMIT = 1_000;

/**
 * Turns the presence changes the status caches report into app notification events, recorded
 * outside any transaction (`AppNotifications.recordDetached`). Each report returns at once: the
 * RPC that made the change never waits for a Workspace lookup or a queue send, and nothing here
 * throws. The Workspace's slug (which the flag is evaluated with) is read only after
 * `appNotificationsPossible()` and cached for a minute.
 */
export class AppNotificationPresence implements PresenceObserver {
  private readonly identities = new Map<string, { identity: WorkspaceIdentity; until: number }>();

  constructor(
    private readonly deps: {
      possible: () => boolean;
      workspace: (id: string) => Promise<WorkspaceIdentity | undefined>;
      record: (workspace: WorkspaceIdentity, event: AppNotificationEvent) => Promise<void>;
    } = {
      possible: appNotificationsPossible,
      workspace: async (id) =>
        (await getDatabaseClient()?.workspace.findUnique({
          where: { id },
          select: { id: true, slug: true },
        })) ?? undefined,
      record: (workspace, event) => AppNotifications.recordDetached(workspace, event),
    },
    private readonly now: () => number = Date.now,
  ) {}

  enabled(): boolean {
    return this.deps.possible();
  }

  agentStatus(change: Parameters<PresenceObserver["agentStatus"]>[0]): void {
    const { workspaceId, agentId, from, to, observedAtMs, idSeed } = change;
    this.emit(workspaceId, idSeed, observedAtMs, {
      type: "agent.status_changed",
      data: { agent_id: agentId, from, to, observed_at: new Date(observedAtMs).toISOString() },
    });
  }

  computerPresence(change: Parameters<PresenceObserver["computerPresence"]>[0]): void {
    const { workspaceId, computerId, from, to, observedAtMs, idSeed } = change;
    this.emit(workspaceId, idSeed, observedAtMs, {
      type: to === "online" ? "computer.online" : "computer.offline",
      data: {
        computer_id: computerId,
        from,
        to,
        observed_at: new Date(observedAtMs).toISOString(),
      },
    });
  }

  private emit(
    workspaceId: string,
    idSeed: string,
    observedAtMs: number,
    payload: AppNotificationEventPayload,
  ): void {
    if (!this.deps.possible()) return;
    void this.send(workspaceId, idSeed, observedAtMs, payload).catch(() => {});
  }

  private async send(
    workspaceId: string,
    idSeed: string,
    observedAtMs: number,
    payload: AppNotificationEventPayload,
  ): Promise<void> {
    const workspace = await this.identity(workspaceId);
    if (!workspace) return;
    await this.deps.record(
      workspace,
      newAppNotificationEvent({
        ...payload,
        workspaceId,
        id: Bun.randomUUIDv5(idSeed, PRESENCE_NAMESPACE),
        timestamp: new Date(observedAtMs).toISOString(),
      }),
    );
  }

  private async identity(workspaceId: string): Promise<WorkspaceIdentity | undefined> {
    const now = this.now();
    const known = this.identities.get(workspaceId);
    if (known && known.until > now) return known.identity;
    const identity = await this.deps.workspace(workspaceId);
    if (!identity) return undefined;
    if (this.identities.size >= IDENTITY_CACHE_LIMIT) this.identities.clear();
    this.identities.set(workspaceId, { identity, until: now + IDENTITY_TTL_MS });
    return identity;
  }
}

export const appNotificationPresence: PresenceObserver = new AppNotificationPresence();
