import { z } from "zod";
import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";
import { readSessionSecret } from "#src/server/auth/config.server";
import { readSignedValue, signValue } from "#src/server/auth/signed-value.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type { DaemonRuntimeReadyRequest } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  ComputerUpgradeProgressStore,
  type RegisteredUpgradeBinding,
  type UpgradeReporter,
} from "./computer-upgrade-progress.server";

const uuid = z.uuid();
const version = z.string().max(96).refine(isValidReleaseVersion);
const evidence = z.object({ generation: uuid, version, at: z.int().nonnegative() });
const purpose = "computer-upgrade-ready-receipt:v1";

export const machineEvidenceSchema = z.discriminatedUnion("kind", [
  evidence.extend({
    kind: z.literal("phase"),
    phase: z.enum(["downloading", "verifying", "waiting", "switching", "uncertain"]),
  }),
  evidence.extend({
    kind: z.literal("snapshot"),
    bindings: z
      .array(z.object({ workspaceId: uuid, state: z.enum(["running", "stopped", "unknown"]) }))
      .max(128),
  }),
  evidence.extend({ kind: z.literal("healthy") }),
  evidence.extend({
    kind: z.literal("receipt"),
    outcome: z.enum(["promoted", "rolled_back", "failed", "unresolved"]),
    oldProcesses: z.enum(["verified", "none", "unknown"]),
    restoredVersion: version.nullish().transform((value) => value ?? undefined),
  }),
]);

const readyEvidenceSchema = z.object({
  computerId: uuid,
  requestId: uuid,
  workspaceId: uuid,
  bindingId: uuid,
  generation: uuid,
  version,
  workerId: uuid,
  readyRequestId: uuid,
  confirmedAt: z.int().positive(),
  expiresAt: z.int().positive(),
});

export const upgradeProgressReportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("machine"),
    requestId: uuid,
    events: z.array(machineEvidenceSchema).min(1).max(12),
  }),
  z.object({ kind: z.literal("ready"), receipt: z.string().min(1).max(2048) }),
]);

export async function readComputerUpgradeProgressReport(request: Request) {
  const limit = 32_768;
  if (Number(request.headers.get("content-length")) > limit)
    return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  let bytes = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        void reader.cancel().catch(() => {});
        return new Response(null, { status: 413 });
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const parsed = upgradeProgressReportSchema.safeParse(JSON.parse(text + decoder.decode()));
    return parsed.success ? parsed.data : new Response(null, { status: 400 });
  } catch {
    return new Response(null, { status: 400 });
  } finally {
    reader.releaseLock();
  }
}

const REPLACE_PROGRESS = `
local previous = redis.call("GET", KEYS[1])
if (previous or "") ~= ARGV[1] then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "PXAT", ARGV[3])
return 1
`;

let store: ComputerUpgradeProgressStore | undefined;
let client: ReturnType<typeof openRedisClient> | undefined;

function progressRedis() {
  return (client ??= openRedisClient(redisUrlFor("Computer upgrade progress")));
}

function progressLatestKey(bindingId: string) {
  return `coforge:computer:upgrade-progress:v1:latest:${bindingId}`;
}

export async function registerComputerUpgradeProgress(
  origin: UpgradeReporter,
  expectedVersion: string,
  expiresAt: number,
  bindings: RegisteredUpgradeBinding[],
) {
  await getComputerUpgradeProgressStore().begin(origin, expectedVersion, expiresAt, bindings);
  await progressRedis().set(
    progressLatestKey(origin.bindingId),
    origin.requestId,
    "PXAT",
    String(expiresAt + 600_000),
  );
}

export async function latestComputerUpgradeProgressIds(bindingIds: readonly string[]) {
  if (!bindingIds.length) return new Map<string, string>();
  const ids = await progressRedis().mget(...bindingIds.map(progressLatestKey));
  return new Map(
    bindingIds.flatMap((bindingId, index) => {
      const requestId = ids[index];
      return requestId && uuid.safeParse(requestId).success
        ? [[bindingId, requestId] as const]
        : [];
    }),
  );
}

export function getComputerUpgradeProgressStore() {
  if (store) return store;
  const redis = progressRedis();
  return (store = new ComputerUpgradeProgressStore({
    read: (key) => redis.get(key),
    replace: async (key, previous, next, retainUntil) =>
      (await redis.send("EVAL", [
        REPLACE_PROGRESS,
        "1",
        key,
        previous ?? "",
        next,
        String(retainUntil),
      ])) === 1,
  }));
}

export async function issueComputerUpgradeReadyReceipt(
  db: Pick<PrismaClient, "workspaceComputer">,
  request: DaemonRuntimeReadyRequest,
  authenticatedWorkerId: string | undefined,
) {
  const {
    workspaceId,
    computerId,
    computerVersion,
    daemonVersion,
    workerInstanceId,
    requestId,
    observedUpgradeRequestId,
    upgradeActivationGeneration,
  } = request;
  if (
    !observedUpgradeRequestId ||
    !upgradeActivationGeneration ||
    !computerVersion ||
    computerVersion !== daemonVersion ||
    workerInstanceId !== authenticatedWorkerId ||
    !uuid.safeParse(observedUpgradeRequestId).success ||
    !uuid.safeParse(upgradeActivationGeneration).success
  )
    return;
  const binding = await db.workspaceComputer.findUnique({
    where: { workspaceId_computerId: { workspaceId, computerId } },
    select: { id: true },
  });
  if (!binding) return;
  const reporter = {
    workspaceId,
    computerId,
    bindingId: binding.id,
    requestId: observedUpgradeRequestId,
  };
  const target = await getComputerUpgradeProgressStore().identifyReady(
    reporter,
    upgradeActivationGeneration,
  );
  if (
    !target ||
    target.expectedVersion !== computerVersion ||
    target.previousWorkerId === workerInstanceId
  )
    return;
  const payload = readyEvidenceSchema.safeParse({
    ...reporter,
    generation: upgradeActivationGeneration,
    version: computerVersion,
    workerId: workerInstanceId,
    readyRequestId: requestId,
    confirmedAt: Date.now(),
    expiresAt: target.expiresAt,
  });
  if (payload.success && payload.data.confirmedAt < payload.data.expiresAt)
    return signValue(purpose, payload.data, await readSessionSecret(Bun.env));
}

export async function recordComputerUpgradeReadyReceipt(
  token: string,
  reporter: Omit<UpgradeReporter, "requestId">,
) {
  const evidence = readyEvidenceSchema.safeParse(
    readSignedValue<unknown>(purpose, token, await readSessionSecret(Bun.env)),
  );
  if (!evidence.success || evidence.data.confirmedAt > Date.now()) return "rejected";
  return getComputerUpgradeProgressStore().recordReady(
    { ...reporter, requestId: evidence.data.requestId },
    evidence.data,
  );
}

export async function readVisibleComputerUpgradeProgress(
  db: Pick<PrismaClient, "workspaceComputer">,
  scope: { workspaceId: string; computerId: string; userId: string },
  requestId: string,
  targetVersionOnline: boolean,
) {
  const rows = await db.workspaceComputer.findMany({
    where: {
      computerId: scope.computerId,
      computer: { ownerId: scope.userId, kind: "local" },
      workspace: { members: { some: { userId: scope.userId } } },
    },
    select: { id: true, workspaceId: true, workspace: { select: { name: true } } },
  });
  if (!rows.some((row) => row.workspaceId === scope.workspaceId)) return;
  const progress = await getComputerUpgradeProgressStore().read(
    { computerId: scope.computerId, requestId },
    rows.map((row) => row.id),
    targetVersionOnline,
  );
  if (!progress) return;
  const names = new Map(rows.map((row) => [row.workspaceId, row.workspace.name]));
  return {
    ...progress,
    workspaces: progress.workspaces.map((row) => ({
      ...row,
      name: names.get(row.workspaceId) ?? "",
    })),
  };
}

export async function acceptComputerUpgradeProgress(
  db: Pick<PrismaClient, "$transaction">,
  principal: { workspaceId: string; computerId: string; apiKeyHash: string },
  input: z.infer<typeof upgradeProgressReportSchema>,
) {
  const { workspaceId, computerId, apiKeyHash } = principal;
  return db.$transaction(async (tx) => {
    const [binding] = await tx.$queryRaw<{ id: string }[]>`
      SELECT binding.id FROM workspace_computers binding
      JOIN daemon_api_keys credential
        ON credential.workspace_id = binding."workspaceId"
        AND credential.computer_id = binding."computerId"
      JOIN workspace_memberships member
        ON member."workspaceId" = binding."workspaceId"
        AND member."userId" = credential.owner_id
      WHERE binding."workspaceId" = ${workspaceId}::uuid
        AND binding."computerId" = ${computerId}::uuid
        AND credential.api_key_hash = ${apiKeyHash}
        AND credential.revoked_at IS NULL
      FOR SHARE OF binding, credential, member`;
    if (!binding) return 403;
    const reporter = { workspaceId, computerId, bindingId: binding.id };
    const results =
      input.kind === "ready"
        ? [await recordComputerUpgradeReadyReceipt(input.receipt, reporter)]
        : await Promise.all(
            input.events.map((event) =>
              getComputerUpgradeProgressStore().recordMachine(
                { ...reporter, requestId: input.requestId },
                event,
              ),
            ),
          );
    if (results.every((result) => result === "stored")) return 204;
    return results.includes("rejected") ? 403 : 410;
  });
}
