import {
  DAEMON_CONNECT_REJECTION_CODES,
  DAEMON_DUPLICATE_CONNECTION_DISCONNECT,
  isRecord,
  type DaemonConnectRejectionReason,
} from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  DaemonApiKeyOwnerNotMemberError,
  hashDaemonApiKey,
  isDaemonApiKey,
  verifyDaemonApiKey,
  type DaemonApiKeyClaims,
  type DaemonApiKeyRepository,
} from "#src/server/auth/daemon-api-key.server";
import { PrismaDaemonApiKeyRepository } from "#src/server/db/repositories/daemon-api-key.repositories.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import {
  getComputerConnectRefusals,
  type ComputerConnectRefusals,
} from "#src/server/centrifugo/computer-connect-refusals.server";
import {
  daemonControlChannel,
  createCentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";

type ConnectRequest = {
  data?: unknown;
};

function connectData(data: unknown): Record<string, unknown> {
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(data) ? data : {};
}

/**
 * A 200 answer carrying a Centrifugo `disconnect` in the terminal 4500-4999 range: the Daemon's
 * client does not reconnect, and the reason is the stable code the Daemon parks its binding on.
 * A non-200 answer would reach the client as Centrifugo's temporary internal error instead.
 */
function refuse(
  reason: DaemonConnectRejectionReason,
  principal?: { workspaceId: string; computerId: string },
): Response {
  // A refusal ends a Computer's connection for good; never silent. A revoked key has no
  // principal left to name.
  console.warn(
    JSON.stringify({
      event: "daemon_connect:refused",
      reason,
      ...(principal
        ? { workspace_id: principal.workspaceId, computer_id: principal.computerId }
        : {}),
    }),
  );
  return Response.json({
    disconnect: { code: DAEMON_CONNECT_REJECTION_CODES[reason], reason },
  });
}

/**
 * A refusal or a good connect must never change the answer it accompanies: a Redis failure
 * here is logged and the auth result stands, so a refused Daemon still parks and a working
 * one still connects.
 */
async function recordRefusal(
  refusals: ComputerConnectRefusals | undefined,
  scope: { workspaceId: string; computerId: string } | undefined,
  reason: DaemonConnectRejectionReason,
) {
  if (!refusals || !scope) return;
  try {
    await refusals.record({ workspaceId: scope.workspaceId, computerId: scope.computerId }, reason);
  } catch {
    console.warn(JSON.stringify({ event: "daemon_connect:refusal_record_failed", reason }));
  }
}

async function clearRefusal(
  refusals: ComputerConnectRefusals | undefined,
  scope: { workspaceId: string; computerId: string },
) {
  try {
    await refusals?.clear({
      workspaceId: scope.workspaceId,
      computerId: scope.computerId,
    });
  } catch {
    console.warn(JSON.stringify({ event: "daemon_connect:refusal_clear_failed" }));
  }
}

export type CentrifugoConnectDependencies = {
  daemonApiKeys: DaemonApiKeyRepository;
  computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  /** Why a formerly valid key stopped being valid, if that was recorded (Workspace deleted,
   * Computer removed). */
  revocationReason(apiKeyHash: string): Promise<DaemonConnectRejectionReason | undefined>;
  /** Records a terminal refusal for the Computers page and clears it on the next good connect.
   * Absent only in tests; production always wires it. */
  connectRefusals?: ComputerConnectRefusals;
  /** The instance ids of the clients already holding the binding's `daemon:` control channel,
   * from Centrifugo presence (`undefined` for a connection that set no info). Absent only in
   * tests; production always wires it. A failed read answers `undefined` and the connect
   * proceeds: duplicate protection must never take a working Daemon offline. */
  connectedDaemons?(channel: string): Promise<(string | undefined)[] | undefined>;
};

let centrifugoApi: ReturnType<typeof createCentrifugoServerApi> | undefined;

export function centrifugoConnectDependencies(db: PrismaClient): CentrifugoConnectDependencies {
  const revocations = new DaemonCredentialRevocations(db);
  return {
    daemonApiKeys: new PrismaDaemonApiKeyRepository(db),
    computerBelongsToWorkspace: async (workspaceId, computerId) =>
      Boolean(
        await db.workspaceComputer.findUnique({
          where: { workspaceId_computerId: { workspaceId, computerId } },
          select: { id: true },
        }),
      ),
    revocationReason: (apiKeyHash) => revocations.reasonFor(apiKeyHash),
    connectRefusals: getComputerConnectRefusals(),
    connectedDaemons: async (channel) => {
      try {
        centrifugoApi ??= createCentrifugoServerApi();
        return (await centrifugoApi.presence(channel)).map((client) => client.info);
      } catch {
        return undefined;
      }
    },
  };
}

export async function authenticateCentrifugoConnect(
  request: Request,
  dependencies: CentrifugoConnectDependencies,
): Promise<Response> {
  try {
    const body = (await request.json()) as ConnectRequest;
    // Newer Daemons send the key as an emulated connect header, which Centrifugo redacts in
    // its command logs; connect data is logged verbatim on every failed attempt, so it stays
    // only as the answer for Daemons released before the header existed. Remove this fallback
    // once every online Computer runs a daemon that sends the header.
    const key =
      request.headers.get("x-coforge-daemon-api-key") ?? connectData(body.data).daemonApiKey;
    const instanceId = request.headers.get("x-coforge-daemon-instance-id") ?? undefined;
    if (typeof key !== "string") throw new Error("Daemon API key missing");
    let principal: DaemonApiKeyClaims;
    try {
      principal = await verifyDaemonApiKey(key, dependencies.daemonApiKeys);
    } catch (error) {
      // A live key whose owner left the Workspace: its Computer has no place there any more.
      if (error instanceof DaemonApiKeyOwnerNotMemberError) {
        await recordRefusal(dependencies.connectRefusals, error.claims, "computer_unlinked");
        return refuse("computer_unlinked", error.claims);
      }
      // Only the holder of a formerly valid key learns why it stopped working; any other key is
      // an ordinary, retryable authentication failure.
      if (isDaemonApiKey(key)) {
        const hash = hashDaemonApiKey(key);
        const reason = await dependencies.revocationReason(hash);
        if (reason) return refuse(reason);
        // A key row that exists but is revoked stopped working through a path that recorded
        // no revocation reason (key migration, replacement): still terminal, never retried.
        const record = await dependencies.daemonApiKeys.findByHash(hash);
        if (record?.revokedAt) {
          const scope = { workspaceId: record.workspaceId, computerId: record.computerId };
          await recordRefusal(dependencies.connectRefusals, scope, "credential_revoked");
          return refuse("credential_revoked", scope);
        }
      }
      throw error;
    }
    if (
      !(await dependencies.computerBelongsToWorkspace(principal.workspaceId, principal.computerId))
    ) {
      await recordRefusal(dependencies.connectRefusals, principal, "computer_unlinked");
      return refuse("computer_unlinked", principal);
    }
    await clearRefusal(dependencies.connectRefusals, principal);
    // One live Daemon per binding: a second connection for the same control channel is answered
    // with a reconnectable disconnect, so it waits its turn instead of racing the first. The
    // instance id tells this process's own half-open predecessor (same id — a quick reconnect
    // while Centrifugo still counts the old socket) from a second daemon holding the binding
    // (different id). Presence is live — a dropped connection stops counting the moment
    // Centrifugo sees it go.
    const channel = daemonControlChannel(principal.workspaceId, principal.computerId);
    const connected = await dependencies.connectedDaemons?.(channel).catch(() => undefined);
    if (connected !== undefined && connected.some((other) => other !== instanceId))
      return Response.json({ disconnect: DAEMON_DUPLICATE_CONNECTION_DISCONNECT });
    return Response.json({
      result: {
        user: principal.userId,
        // Client info Centrifugo keeps in the connection's presence record, so the next connect
        // can match this daemon instance against the one already holding the channel.
        ...(instanceId !== undefined ? { info: instanceId } : {}),
        meta: {
          workspace_id: principal.workspaceId,
          computer_id: principal.computerId,
        },
        subs: {
          [`daemon:${principal.workspaceId}:${principal.computerId}`]: {},
        },
      },
    });
  } catch {
    return Response.json(
      { error: { code: 401, message: "connection authentication failed" } },
      { status: 401 },
    );
  }
}
