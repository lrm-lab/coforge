import { expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { lockConversation } from "#src/server/conversations/conversation-lock.server";

const connectionString = Bun.env.CHANNEL_TEST_DATABASE_URL;

const ATTACHMENT_INSERT_TIMEOUT_MS = 10_000;
const LOCK_OBSERVATION_TIMEOUT_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 5;
const LOCK_WAIT_SESSION_OPTIONS = { lock_timeout: 30_000 };
const TRANSACTION_TIMEOUT_MS = 20_000;

async function waitWithTimeout<T, TimeoutValue extends string>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: TimeoutValue,
): Promise<T | TimeoutValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<TimeoutValue>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test.skipIf(!connectionString)(
  "an attachment insert is not blocked while the conversation lock is held",
  async () => {
    const db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString!, ...LOCK_WAIT_SESSION_OPTIONS }),
    });
    const second = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString!, ...LOCK_WAIT_SESSION_OPTIONS }),
    });
    const observer = new PrismaClient({
      adapter: new PrismaPg({ connectionString: connectionString! }),
    });
    const held = Promise.withResolvers<number>();
    const releaseLock = Promise.withResolvers<void>();
    let holdError: unknown;
    let holdLock: Promise<void> | undefined;
    let attachmentCreate: Promise<unknown> | undefined;
    let probe: Promise<"taken" | "rejected"> | undefined;
    let disconnectError: unknown;
    try {
      const suffix = crypto.randomUUID();
      const owner = await db.user.create({
        data: { username: `lock-owner-${suffix}`, displayName: "owner" },
      });
      const workspace = await db.workspace.create({
        data: {
          slug: `lock-${suffix}`,
          name: "Lock test",
          members: { create: [{ userId: owner.id, role: "owner" }] },
        },
      });
      const conversation = await db.conversation.create({
        data: {
          workspaceId: workspace.id,
          channelName: "chan",
          members: { create: [{ userId: owner.id }] },
        },
      });
      holdLock = db
        .$transaction(
          async (tx) => {
            await lockConversation(tx, conversation.id);
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            if (!backend) {
              throw new Error("Holder transaction did not report a PostgreSQL backend PID");
            }
            held.resolve(backend.pid);
            await releaseLock.promise;
          },
          { timeout: TRANSACTION_TIMEOUT_MS },
        )
        .catch((error) => {
          holdError = error;
          held.reject(error);
        });
      const holderPid = await waitWithTimeout(
        held.promise,
        ATTACHMENT_INSERT_TIMEOUT_MS,
        "timeout",
      );
      if (holderPid === "timeout") {
        throw new Error("Holder transaction did not acquire the conversation lock in time");
      }
      attachmentCreate = second.attachment.create({
        data: {
          workspaceId: workspace.id,
          conversationId: conversation.id,
          uploaderId: owner.id,
          objectKey: `test/lock/${suffix}`,
          fileName: "upload.txt",
          contentType: "text/plain",
          sizeBytes: 1,
        },
      });
      const inserted = await waitWithTimeout(
        attachmentCreate,
        ATTACHMENT_INSERT_TIMEOUT_MS,
        "blocked",
      );
      expect(inserted).not.toBe("blocked");
      const probeStarted = Promise.withResolvers<number>();
      let probeState: "pending" | "taken" | "rejected" = "pending";
      let probeError: unknown;
      probe = second
        .$transaction(
          async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            if (!backend) {
              throw new Error("Probe transaction did not report a PostgreSQL backend PID");
            }
            probeStarted.resolve(backend.pid);
            await lockConversation(tx, conversation.id);
          },
          { timeout: TRANSACTION_TIMEOUT_MS },
        )
        .then(
          () => {
            probeState = "taken";
            return "taken" as const;
          },
          (error) => {
            probeState = "rejected";
            probeError = error;
            probeStarted.reject(error);
            return "rejected" as const;
          },
        );
      const probePid = await waitWithTimeout(
        probeStarted.promise,
        LOCK_OBSERVATION_TIMEOUT_MS,
        "timeout",
      );
      if (probePid === "timeout") {
        throw new Error("Probe transaction did not report a PostgreSQL backend PID in time");
      }
      expect(probePid).not.toBe(holderPid);
      const deadline = Date.now() + LOCK_OBSERVATION_TIMEOUT_MS;
      let blocked = false;
      while (Date.now() < deadline) {
        if (probeState !== "pending") break;
        const [waiting] = await observer.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid = ${probePid}::int
            AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        ) AS blocked`;
        if (waiting?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(LOCK_POLL_INTERVAL_MS);
      }
      expect(blocked).toBe(true);
      expect(probeState).toBe("pending");
      releaseLock.resolve();
      await holdLock;
      expect(holdError).toBeUndefined();
      expect(await probe).toBe("taken");
      expect(probeError).toBeUndefined();
    } finally {
      releaseLock.resolve();
      await Promise.allSettled([holdLock, attachmentCreate, probe].filter(Boolean));
      const disconnects = await Promise.allSettled([
        observer.$disconnect(),
        second.$disconnect(),
        db.$disconnect(),
      ]);
      const disconnectErrors = disconnects
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (disconnectErrors.length > 0) {
        disconnectError =
          disconnectErrors.length === 1
            ? disconnectErrors[0]
            : new AggregateError(disconnectErrors, "Failed to disconnect test Prisma clients");
      }
    }
    if (disconnectError !== undefined) {
      throw disconnectError;
    }
  },
  30_000,
);
