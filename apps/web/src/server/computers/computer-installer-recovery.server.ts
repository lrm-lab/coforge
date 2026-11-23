import {
  installerRecoveryChallengeSchema,
  type InstallerRecoveryChallenge,
  type InstallerRecoveryObservation,
} from "@lrm/coforge-sdk/internal/installer-recovery-observation";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import {
  createCentrifugoServerApi,
  daemonControlChannel,
} from "#src/server/centrifugo/server-api.server";
import { computerRestartIdentityKey } from "./computer-restart-store.server";
import { COMPUTER_INSTALLER_RECOVERY } from "./computer-installer-recovery-lua";

type Scope = { workspaceId: string; computerId: string };
export type InstallerRecoveryClient = {
  workerInstanceId: string;
  client: string;
  connectionSequence: number;
};
export type InstallerRecoveryConnection = InstallerRecoveryClient & { startedAt: number };
type LiveCheck = (scope: Scope, client: InstallerRecoveryClient) => Promise<boolean>;
type Advice = InstallerRecoveryConnection & { remainingMs: number };

type Update =
  | { kind: "read" }
  | ({ kind: "ready"; nextToken: string; live: boolean } & InstallerRecoveryConnection)
  | ({ kind: "close" } & InstallerRecoveryClient)
  | ({
      kind: "observe";
      sample: InstallerRecoveryObservation;
      nextToken: string;
      live: boolean;
    } & InstallerRecoveryConnection);

export class RedisComputerInstallerRecovery {
  constructor(
    private readonly redis: { send(command: string, args: string[]): Promise<unknown> },
    private readonly live: LiveCheck,
  ) {}

  async ready(scope: Scope, client: InstallerRecoveryConnection): Promise<boolean> {
    // Remember the accepted connection even if presence is briefly unavailable.
    // Its heartbeat can retry presence before receiving a challenge.
    const live = await this.live(scope, client).catch(() => false);
    return (
      (await this.update(scope, {
        ...client,
        kind: "ready",
        nextToken: crypto.randomUUID(),
        live,
      })) === "ready"
    );
  }

  async observe(
    scope: Scope,
    client: InstallerRecoveryConnection,
    sample: InstallerRecoveryObservation,
  ): Promise<InstallerRecoveryChallenge | undefined> {
    const update = { ...client, kind: "observe" as const, sample, nextToken: crypto.randomUUID() };
    let reply = await this.update(scope, { ...update, live: false });
    if (reply === "presence" && (await this.live(scope, client)))
      reply = await this.update(scope, { ...update, live: true });
    if (typeof reply !== "string" || !reply || reply === "presence") return undefined;
    return installerRecoveryChallengeSchema.parse(JSON.parse(reply));
  }

  async close(scope: Scope, client: InstallerRecoveryClient): Promise<void> {
    await this.update(scope, { ...client, kind: "close" });
  }

  async read(scope: Scope): Promise<{ remainingMs: number } | null> {
    const previous = await this.advice(scope);
    if (!previous || !(await this.live(scope, previous))) return null;
    const current = await this.advice(scope);
    if (current?.connectionSequence !== previous.connectionSequence) return null;
    return { remainingMs: current.remainingMs };
  }

  private async advice(scope: Scope): Promise<Advice | null> {
    const result = await this.update(scope, { kind: "read" });
    return typeof result === "string" && result ? (JSON.parse(result) as Advice) : null;
  }

  private update(scope: Scope, update: Update) {
    return this.redis.send("EVAL", [
      COMPUTER_INSTALLER_RECOVERY,
      "1",
      computerRestartIdentityKey(scope),
      JSON.stringify(update),
    ]);
  }
}

const connectionCounter = "coforge:computer-installer-recovery-connection:v1";
// Recovery advice is optional on the connect and heartbeat proxies.
const recoveryOperationTimeoutMs = 250;
let redis: ReturnType<typeof openRedisClient> | undefined;
let store: RedisComputerInstallerRecovery | undefined;

function recoveryRedis() {
  return (redis ??= openRedisClient(redisUrlFor("Computer installer recovery"), {
    commandTimeoutMs: recoveryOperationTimeoutMs,
  }));
}

export async function nextInstallerRecoveryConnection(): Promise<number> {
  return Number(await recoveryRedis().send("INCR", [connectionCounter]));
}

export function getComputerInstallerRecovery() {
  return (store ??= new RedisComputerInstallerRecovery(
    recoveryRedis(),
    async (scope, connection) => {
      const clients = await createCentrifugoServerApi(undefined, {
        timeoutMs: recoveryOperationTimeoutMs,
      }).presence(daemonControlChannel(scope.workspaceId, scope.computerId));
      return clients.some(
        ({ client, info }) => client === connection.client && info === connection.workerInstanceId,
      );
    },
  ));
}
