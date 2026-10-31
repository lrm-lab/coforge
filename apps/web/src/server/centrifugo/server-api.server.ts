import {
  AGENT_START_METHOD,
  DAEMON_RECONNECT_DISCONNECT,
  encodeDaemonRuntimeUsageScanRequest,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import {
  isAgentStatusChannel,
  legacyAgentStatusChannel,
} from "#src/features/agents/agent-status-channel";
import type { StreamPosition } from "#src/features/realtime/subscription-gap";
import { getUsageCache, type UsageCache } from "./usage-cache.server";

export type CentrifugoServerApi = {
  /** `skipHistory` keeps a transient frame out of the channel's history, so a resubscribe's
   * recovery does not replay it. */
  publish(channel: string, data: Uint8Array, options?: { skipHistory?: boolean }): Promise<void>;
  publishJson(channel: string, data: unknown, idempotencyKey?: string): Promise<void>;
  /** One Centrifugo `broadcast` call to many channels at once, instead of N sequential `publish`
   * calls (https://centrifugal.dev/docs/server/server_api#broadcast). A no-op when `channels` is
   * empty. `idempotencyKey` acts per channel, matching `publishJson`'s per-channel semantics. */
  broadcast(channels: string[], data: unknown, idempotencyKey?: string): Promise<void>;
  /** Many binary publications, each to its own channel, in one Centrifugo `batch` call
   * (https://centrifugal.dev/docs/server/server_api#batch). Each settles on its own reply, in
   * order: one failed publication leaves the rest published. A batch Centrifugo did not answer
   * (one deadline covers the whole batch) fails them all. */
  publishBatch(
    publications: readonly { channel: string; data: Uint8Array; skipHistory?: boolean }[],
  ): Promise<PromiseSettledResult<void>[]>;
  /** Ends every subscription each user's clients hold to the paired channel, for people who can
   * no longer read it (https://centrifugal.dev/docs/server/server_api#unsubscribe), in one `batch`
   * call. A no-op when the list is empty; any refused pair fails the call. */
  unsubscribe(subscriptions: readonly { user: string; channel: string }[]): Promise<void>;
};

/** Centrifugo's server API for where channel streams stand. */
export type CentrifugoStreams = {
  /** Each channel's current stream position, from `history` without a limit, which returns only
   * that (https://centrifugal.dev/docs/server/server_api#history), in one parallel `batch`. A
   * channel whose position could not be read (a namespace without history) is left out. */
  streamPositions(channels: string[]): Promise<Record<string, StreamPosition>>;
};

/** Centrifugo's server API for the connections themselves, not what is published on them. */
export type CentrifugoConnections = {
  /** The clients subscribed to a channel whose namespace keeps presence
   * (https://centrifugal.dev/docs/server/server_api#presence). */
  presence(channel: string): Promise<{ client: string; user: string }[]>;
  /** Disconnects one client of a user with the given code
   * (https://centrifugal.dev/docs/server/server_api#disconnect). Whether the client reconnects is
   * the code's range: centrifuge-js stops only on 3500-3999 and 4500-4999. */
  disconnect(input: {
    user: string;
    client: string;
    disconnect: { code: number; reason: string };
  }): Promise<void>;
};

/** How long one Centrifugo server-API call may take, connect included, before it is aborted. */
const CENTRIFUGO_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Server-only adapter for Centrifugo's HTTP server API. Business code never builds its HTTP body.
 * Every call carries a deadline, so an unreachable Centrifugo rejects (`TimeoutError`) instead of
 * holding the request that published.
 */
export function createCentrifugoServerApi(
  env = process.env,
  { timeoutMs = CENTRIFUGO_REQUEST_TIMEOUT_MS }: { timeoutMs?: number } = {},
): CentrifugoServerApi & CentrifugoConnections & CentrifugoStreams {
  const endpoint = env.COFORGE_CENTRIFUGO_API_URL;
  const apiKey = env.COFORGE_CENTRIFUGO_API_KEY;
  if (!endpoint || !apiKey) throw new Error("Centrifugo server API is not configured");
  const serverApiUrl = endpoint;
  const serverApiKey = apiKey;
  async function call(method: string, params: Record<string, unknown>) {
    const response = await fetch(serverApiUrl, {
      method: "POST",
      headers: {
        "x-api-key": serverApiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Centrifugo ${method} failed (${response.status})`);
    const result = (await response.json()) as {
      error?: { code?: unknown };
      result?: {
        responses?: Array<{ error?: { code?: unknown } }>;
        presence?: Record<string, { client?: unknown; user?: unknown }>;
      };
    };
    if (result.error) throw failure(method, result.error);
    const failed = result.result?.responses?.find((response) => response.error);
    if (failed) throw failure(method, failed.error);
    return result.result;
  }
  /** `batch` exists only as a method in the URL path (`/api/batch`), not in the `{ method,
   * params }` body `call` sends; it answers `replies` at the top level, one per command, in
   * order, each with its own `error` if that command failed. Commands run in parallel, so two
   * publications to one channel keep no order between them. */
  async function batch(commands: Record<string, unknown>[]) {
    const response = await fetch(`${serverApiUrl}/batch`, {
      method: "POST",
      headers: { "x-api-key": serverApiKey, "content-type": "application/json" },
      body: JSON.stringify({ parallel: true, commands }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Centrifugo batch failed (${response.status})`);
    const { error, replies } = (await response.json()) as {
      error?: { code?: unknown };
      replies?: Array<{
        error?: { code?: unknown };
        history?: { offset?: unknown; epoch?: unknown };
      }>;
    };
    if (error) throw failure("batch", error);
    return replies ?? [];
  }
  /** One publication. An Agent status one goes to the channel's old name too, in one broadcast
   * (`legacyAgentStatusChannel`); `publishBatch` does not, and no status publisher uses it. */
  async function send(channel: string, publication: Record<string, unknown>) {
    await (isAgentStatusChannel(channel)
      ? call("broadcast", {
          channels: [channel, legacyAgentStatusChannel(channel)],
          ...publication,
        })
      : call("publish", { channel, ...publication }));
  }
  return {
    async publish(channel, data, options) {
      await send(channel, {
        b64data: base64(data),
        ...(options?.skipHistory ? { skip_history: true } : {}),
      });
    },
    async publishJson(channel, data, idempotencyKey) {
      await send(channel, {
        data,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    },
    async broadcast(channels, data, idempotencyKey) {
      if (channels.length === 0) return;
      await call("broadcast", {
        channels,
        data,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
    },
    async publishBatch(publications) {
      if (publications.length === 0) return [];
      let replies: Awaited<ReturnType<typeof batch>>;
      try {
        replies = await batch(
          publications.map(({ channel, data, skipHistory }) => ({
            publish: {
              channel,
              b64data: base64(data),
              ...(skipHistory ? { skip_history: true } : {}),
            },
          })),
        );
      } catch (error) {
        return publications.map(() => ({ status: "rejected", reason: error }));
      }
      return publications.map((_, index) => {
        const reply = replies[index];
        return reply && !reply.error
          ? { status: "fulfilled", value: undefined }
          : { status: "rejected", reason: failure("publish", reply?.error) };
      });
    },
    async streamPositions(channels) {
      if (channels.length === 0) return {};
      const replies = await batch(channels.map((channel) => ({ history: { channel } })));
      const positions: Record<string, StreamPosition> = {};
      channels.forEach((channel, index) => {
        const { offset = 0, epoch } = replies[index]?.history ?? {};
        if (typeof epoch === "string" && epoch !== "" && typeof offset === "number")
          positions[channel] = { offset, epoch };
      });
      return positions;
    },
    async presence(channel) {
      const clients = Object.values((await call("presence", { channel }))?.presence ?? {});
      return clients.flatMap(({ client, user }) =>
        typeof client === "string" && typeof user === "string" ? [{ client, user }] : [],
      );
    },
    async disconnect({ user, client, disconnect }) {
      await call("disconnect", { user, client, disconnect });
    },
    async unsubscribe(subscriptions) {
      if (subscriptions.length === 0) return;
      const replies = await batch(subscriptions.map((unsubscribe) => ({ unsubscribe })));
      const refused = replies.find((reply) => reply.error);
      if (refused) throw failure("unsubscribe", refused.error);
    },
  };
}

/** A Centrifugo command error as one message, its numeric code when it has one. */
function failure(method: string, error?: { code?: unknown }): Error {
  return new Error(
    `Centrifugo ${method} failed (${typeof error?.code === "number" ? error.code : "command error"})`,
  );
}

/** Centrifugo's `b64data`. `btoa` wants a binary string; building it chunk-wise (32 KiB of bytes
 * per `String.fromCharCode` call) keeps the spread under the engine's argument limit and avoids a
 * per-byte string append. */
function base64(data: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < data.length; index += CHUNK)
    binary += String.fromCharCode(...data.subarray(index, index + CHUNK));
  return btoa(binary);
}

/** A private control channel for one authenticated Workspace–Computer connection. */
export const daemonControlChannel = (workspaceId: string, computerId: string) =>
  `daemon:${workspaceId}:${computerId}`;

/**
 * Makes a Computer's daemon connection for one Workspace reconnect now, so it meets whatever its
 * connect check now answers. The connection is found by the presence of its own control channel
 * (the `daemon` namespace keeps presence for this) and only that client is disconnected, with
 * `DAEMON_RECONNECT_DISCONNECT`; the same person's pages and other daemons stay connected. A
 * Computer not connected has nothing to disconnect.
 */
export async function reconnectDaemon(
  api: CentrifugoConnections,
  workspaceId: string,
  computerId: string,
): Promise<void> {
  const clients = await api.presence(daemonControlChannel(workspaceId, computerId));
  await Promise.all(
    clients.map(({ user, client }) =>
      api.disconnect({ user, client, disconnect: DAEMON_RECONNECT_DISCONNECT }),
    ),
  );
}
export { AGENT_START_METHOD };
export function createUsageScan(
  api: Pick<CentrifugoServerApi, "publish">,
  input: { workspaceId: string; computerId: string; provider: RuntimeProvider },
  cache: UsageCache = getUsageCache(),
): Promise<string> {
  const requestId = crypto.randomUUID();
  return (async () => {
    await cache.putScan({ ...input, scanId: requestId, status: "pending" });
    await api.publish(
      daemonControlChannel(input.workspaceId, input.computerId),
      encodeDaemonRuntimeUsageScanRequest({ protocolMajor: 1, requestId, ...input }),
    );
    return requestId;
  })();
}
