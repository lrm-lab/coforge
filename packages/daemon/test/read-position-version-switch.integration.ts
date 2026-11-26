import { beforeAll, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import {
  AgentContinuationStore,
  type AgentContinuation,
} from "#src/persistence/agent-continuation-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import {
  agentId,
  newConversation,
  oldConversation,
  readPositionHarness,
  taskDelivery,
  taskTarget,
  temporaryReadPositionState,
} from "./fixtures/read-position-acceptance";

const legacyCommit = "e62c31afebd1050009aba0c7609b715021af2898";
const now = () => 1_000;
const rollbackDraftTarget = "#acceptance:#43";
const initialDraft = { content: "Before upgrade", idempotencyKey: "original-draft" };
const rollbackDraft = { content: "During rollback", idempotencyKey: "rollback-draft" };

let legacy: {
  AgentConsumedSeqStore: typeof AgentConsumedSeqStore;
  AgentContinuationStore: typeof AgentContinuationStore;
  AgentMessageDraftStore: typeof AgentMessageDraftStore;
};

beforeAll(async () => {
  const checkout = process.env.COFORGE_READ_POSITION_LEGACY_CHECKOUT;
  if (!checkout || !isAbsolute(checkout))
    throw new Error(
      "Set COFORGE_READ_POSITION_LEGACY_CHECKOUT to an absolute path at " + legacyCommit,
    );
  const head = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"]);
  if (head.stdout.toString().trim() !== legacyCommit || head.exitCode !== 0)
    throw new Error(`Legacy checkout must be at ${legacyCommit}`);
  const status = Bun.spawnSync([
    "git",
    "-C",
    checkout,
    "diff",
    "--quiet",
    "HEAD",
    "--",
    "packages/daemon/src",
    "packages/coforge-sdk/src",
  ]);
  if (status.exitCode !== 0)
    throw new Error("Legacy checkout must use unmodified daemon and SDK source");
  const source = join(checkout, "packages/daemon/src/persistence");
  const [cursors, continuations, drafts] = await Promise.all([
    import(join(source, "agent-consumed-seq-store.ts")) as Promise<
      typeof import("#src/persistence/agent-consumed-seq-store")
    >,
    import(join(source, "agent-continuation-store.ts")) as Promise<
      typeof import("#src/persistence/agent-continuation-store")
    >,
    import(join(source, "agent-message-draft-store.ts")) as Promise<
      typeof import("#src/persistence/agent-message-draft-store")
    >,
  ]);
  legacy = { ...cursors, ...continuations, ...drafts };
});

function continuation(target: string, draft: typeof initialDraft): AgentContinuation {
  return {
    id: draft.idempotencyKey,
    target,
    draft: { ...draft, reholdCount: 0 },
    anywayOffered: true,
    createdAt: now(),
    expiresAt: now() + 10_000,
  };
}

async function saveDrafts(
  agentDb: ReturnType<AgentConsumedSeqStore["stateDb"]>,
  target: string,
  draft: typeof initialDraft,
) {
  await new legacy.AgentMessageDraftStore(agentDb, now).save(target, draft);
  await new legacy.AgentContinuationStore(agentDb, now).create(continuation(target, draft));
}

async function expectDrafts(
  agentDb: ReturnType<AgentConsumedSeqStore["stateDb"]>,
  target: string,
  draft: typeof initialDraft,
  readers = { AgentMessageDraftStore, AgentContinuationStore },
) {
  expect(await new readers.AgentMessageDraftStore(agentDb, now).lookup(target)).toMatchObject({
    status: "found",
    draft: { ...draft, target, reholdCount: 0, savedAt: now() },
  });
  expect(
    await new readers.AgentContinuationStore(agentDb, now).lookup(draft.idempotencyKey),
  ).toMatchObject({ status: "open", continuation: continuation(target, draft) });
}

const readInA = taskDelivery(oldConversation, 31);
const readInB = taskDelivery(newConversation, 5);

test("a real old→new→old→new switch retains A=31, advances B=5→7 and preserves held sends", async () => {
  const state = temporaryReadPositionState();
  try {
    const old = new legacy.AgentConsumedSeqStore(state.path);
    try {
      old.apply(agentId, {
        upsertTargets: [
          { target: taskTarget, entry: { conversationId: oldConversation, seq: 31 } },
        ],
      });
      await saveDrafts(old.stateDb(agentId), taskTarget, initialDraft);
    } finally {
      old.close();
    }

    const firstUpgrade = readPositionHarness(state.path);
    try {
      await firstUpgrade.attention.receive(readInA);
      expect(firstUpgrade.notices).toHaveLength(0);
      await expectDrafts(firstUpgrade.store.stateDb(agentId), taskTarget, initialDraft);
      await firstUpgrade.attention.receive(readInB);
      expect(firstUpgrade.notices).toHaveLength(1);
      await firstUpgrade.readPage(newConversation, 5, [readInB]);
    } finally {
      firstUpgrade.close();
    }

    const rollback = new legacy.AgentConsumedSeqStore(state.path);
    try {
      const agentDb = rollback.stateDb(agentId);
      await expectDrafts(agentDb, taskTarget, initialDraft, legacy);
      rollback.apply(agentId, {
        upsertTargets: [{ target: taskTarget, entry: { conversationId: newConversation, seq: 7 } }],
      });
      expect(rollback.read(agentId).targets[taskTarget]).toMatchObject({
        conversationId: newConversation,
        seq: 7,
      });
      agentDb.database
        .query("INSERT INTO consumed_seqs (target, conversation_id, seq) VALUES (?, ?, ?)")
        .run(rollbackDraftTarget, "", 99);
      agentDb.database
        .query("INSERT INTO consumed_seqs (target, conversation_id, seq) VALUES (?, ?, ?)")
        .run("#acceptance:unresolved scope", newConversation, 99);
      await saveDrafts(agentDb, rollbackDraftTarget, rollbackDraft);
    } finally {
      rollback.close();
    }

    const reupgrade = readPositionHarness(state.path);
    try {
      await expectDrafts(reupgrade.store.stateDb(agentId), taskTarget, initialDraft);
      await expectDrafts(reupgrade.store.stateDb(agentId), rollbackDraftTarget, rollbackDraft);
      await reupgrade.attention.receive(taskDelivery(newConversation, 7));
      await reupgrade.attention.receive(readInA);
      expect(reupgrade.notices).toEqual([]);

      await reupgrade.attention.receive(taskDelivery(newConversation, 8));
      expect(reupgrade.notices).toHaveLength(1);
      await reupgrade.attention.receive(taskDelivery(oldConversation, 32));
      expect(reupgrade.notices).toHaveLength(2);
      await reupgrade.attention.receive(
        taskDelivery("unrelated-conversation", 6, "New unscoped-history task", rollbackDraftTarget),
      );
      expect(reupgrade.notices).toHaveLength(3);
    } finally {
      reupgrade.close();
    }
  } finally {
    state.remove();
  }
});

async function interruptUpgrade(stateDirectory: string, delayMs: number): Promise<boolean> {
  let started = false;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const worker = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/read-position-upgrade-worker.ts"),
      stateDirectory,
      agentId,
    ],
    {
      stdio: ["ignore", "ignore", "inherit"],
      ipc(message, subprocess) {
        if (message === "opening") {
          started = true;
          timer = setTimeout(() => {
            if (!finished && subprocess.exitCode === null) subprocess.kill("SIGKILL");
          }, delayMs);
        }
        if (message === "finished") finished = true;
      },
    },
  );
  try {
    const exitCode = await worker.exited;
    if (started && worker.signalCode === "SIGKILL") return !finished;
    if (exitCode !== 0 || !finished)
      throw new Error(`Upgrade fixture exited with code ${exitCode}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

test("a SIGKILL during a database upgrade leaves the old state usable and the upgrade retry complete", async () => {
  const witnesses = Array.from({ length: 2048 }, (_, index) =>
    taskDelivery(`migration-conversation-${index}`, 31, "Old reply", `#migration:#${index + 1}`),
  );
  const rows = witnesses.map((message) => ({
    target: message.target,
    entry: { conversationId: message.conversationId, seq: message.sequence },
  }));
  let interrupted = 0;
  for (const delayMs of [1, 2, 4, 8]) {
    const state = temporaryReadPositionState();
    try {
      const old = new legacy.AgentConsumedSeqStore(state.path);
      try {
        old.apply(agentId, { upsertTargets: rows });
        await saveDrafts(old.stateDb(agentId), taskTarget, initialDraft);
      } finally {
        old.close();
      }

      if (!(await interruptUpgrade(state.path, delayMs))) continue;
      interrupted++;
      const oldReopen = new legacy.AgentConsumedSeqStore(state.path);
      try {
        const db = oldReopen.stateDb(agentId);
        expect(db.database.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
        const oldTargets = oldReopen.read(agentId).targets;
        expect(Object.keys(oldTargets)).toHaveLength(rows.length);
        expect(
          rows.every(({ target, entry }) => {
            const stored = oldTargets[target];
            return stored?.conversationId === entry.conversationId && stored.seq === entry.seq;
          }),
        ).toBe(true);
        await expectDrafts(db, taskTarget, initialDraft, legacy);
      } finally {
        oldReopen.close();
      }

      const retry = readPositionHarness(state.path);
      try {
        const wrongBoundaries = witnesses.filter(
          (message) =>
            !retry.attention.hasConsumed(message) ||
            retry.attention.hasConsumed({ ...message, sequence: message.sequence + 1 }),
        );
        expect(wrongBoundaries.map((message) => message.target)).toEqual([]);
        await expectDrafts(retry.store.stateDb(agentId), taskTarget, initialDraft);
      } finally {
        retry.close();
      }
    } finally {
      state.remove();
    }
  }
  expect(interrupted).toBeGreaterThan(0);
});
