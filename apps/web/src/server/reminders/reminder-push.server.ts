import { REMINDER_PROTOCOL_MAJOR } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { Reminders } from "./reminders.server";

type Scope = { workspaceId: string; computerId: string };

/**
 * The Agents whose reminders the Daemon on this Computer is handed: every Agent assigned here that
 * its owner can still vouch for — the owner belongs to the Workspace and the Computer is bound to
 * it, the same membership rule the Daemon's own snapshot request passes (`authorizeDaemon`).
 *
 * This is the set a Daemon cannot work out on its own. It only knows the Agents it was asked to
 * run, so an Agent that has never been started on this Computer is reachable only because the
 * server names it. The query is the daemon's scope, so no Agent of another Computer or another
 * Workspace can enter it: nothing out of scope is ever published, which leaves the Daemon's
 * `reminder.sync_dropped` path for frames that really do arrive for another daemon.
 */
export function assignedReminderAgents(db: Pick<PrismaClient, "agent">, scope: Scope) {
  return db.agent.findMany({
    where: {
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
      ...ACTIVE_AGENT_WHERE,
      owner: { memberships: { some: { workspaceId: scope.workspaceId } } },
      computer: { workspaces: { some: { workspaceId: scope.workspaceId } } },
    },
    select: { id: true },
  });
}

/**
 * Pushes one reminder snapshot per assigned Agent to the Daemon's control channel — the same frame
 * the Daemon's own `agent:v1:reminder:snapshot` request answers with, so whatever arms a timer on
 * that path arms it here too (an overdue reminder included; the server computes the next
 * occurrence when the Daemon fires it).
 *
 * One Agent whose scope check fails is skipped and logged rather than failing the push: a stale
 * owner must not silence the rest of the Computer, and the push runs inside the daemon-ready
 * handshake, where a rejection would keep the Daemon from ever becoming ready.
 */
export async function pushReminderSnapshots(
  ports: {
    db: Pick<PrismaClient, "agent">;
    centrifugo: Pick<CentrifugoServerApi, "publishBatch">;
    reminders: Pick<Reminders, "snapshotForDaemon">;
  },
  scope: Scope,
): Promise<void> {
  const agents = await assignedReminderAgents(ports.db, scope);
  const channel = daemonControlChannel(scope.workspaceId, scope.computerId);
  const publications: { channel: string; data: Uint8Array }[] = [];
  for (const agent of agents) {
    try {
      publications.push({
        channel,
        data: await ports.reminders.snapshotForDaemon({
          protocolMajor: REMINDER_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: scope.workspaceId,
          computerId: scope.computerId,
          agentId: agent.id,
        }),
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "reminder_snapshot_push:skipped",
          outcome: "skipped",
          agent_id: agent.id,
          workspace_id: scope.workspaceId,
          computer_id: scope.computerId,
          error_type: errorType(error),
        }),
      );
    }
  }
  if (publications.length === 0) return;
  const results = await ports.centrifugo.publishBatch(publications);
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}
