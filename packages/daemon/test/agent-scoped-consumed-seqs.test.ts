import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentContinuationStore } from "#src/persistence/agent-continuation-store";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";

const agentId = "agent-1";
const target = "#board:#7";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function stateDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "coforge-scoped-consumed-"));
  directories.push(root);
  await mkdir(join(root, "agent-state", agentId), { recursive: true });
  return root;
}

function openLegacy(root: string): Database {
  const db = new Database(join(root, "agent-state", agentId, "state.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '1'), ('legacyImported', 'true');
    CREATE TABLE IF NOT EXISTS consumed_seqs (
      target TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER,
      read_order INTEGER, reviewed_seq INTEGER, exact_seqs TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS drafts (
      target TEXT PRIMARY KEY, content TEXT NOT NULL, attachment_ids TEXT,
      idempotency_key TEXT NOT NULL, mentions TEXT, saved_at INTEGER NOT NULL,
      rehold_count INTEGER NOT NULL DEFAULT 0, seen_up_to_seq INTEGER, seen_exact_seqs TEXT
    );
    CREATE TABLE IF NOT EXISTS continuations (
      id TEXT PRIMARY KEY, target TEXT NOT NULL, payload TEXT NOT NULL, choice TEXT,
      with_input INTEGER, answered_at INTEGER, expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

function writeLegacy(db: Database, spelling: string, conversationId: string, seq: number): void {
  db.query(`INSERT INTO consumed_seqs (target, conversation_id, seq) VALUES (?, ?, ?)
    ON CONFLICT(target) DO UPDATE SET conversation_id = excluded.conversation_id, seq = excluded.seq`).run(
    spelling,
    conversationId,
    seq,
  );
}

test("old → new → old → new retains A/31, B/7, drafts and continuations", async () => {
  const root = await stateDirectory();
  const draft = { content: "draft", idempotencyKey: "held-send", reholdCount: 0 };
  const continuation = {
    id: "continuation",
    target,
    draft,
    anywayOffered: false,
    createdAt: 1,
    expiresAt: 100,
  };
  const legacy = openLegacy(root);
  try {
    writeLegacy(legacy, target, "A", 31);
    legacy
      .query("INSERT INTO drafts (target, content, idempotency_key, saved_at) VALUES (?, ?, ?, ?)")
      .run(target, draft.content, draft.idempotencyKey, 1);
    legacy
      .query("INSERT INTO continuations (id, target, payload, expires_at) VALUES (?, ?, ?, ?)")
      .run(continuation.id, target, JSON.stringify(continuation), continuation.expiresAt);
  } finally {
    legacy.close();
  }

  const upgraded = new AgentConsumedSeqStore(root);
  try {
    expect(upgraded.read(agentId).scopedTargets).toEqual([
      { target, entry: { conversationId: "A", seq: 31 } },
    ]);
    const row = { target, entry: { conversationId: "B", seq: 5 } };
    upgraded.apply(agentId, { upsertTargets: [row], upsertScopedTargets: [row] });
    upgraded.apply(agentId, {
      upsertScopedTargets: [{ target, entry: { conversationId: "A", seq: 29 } }],
    });
    expect(upgraded.read(agentId).scopedTargets).toEqual([
      { target, entry: { conversationId: "A", seq: 31 } },
      row,
    ]);
  } finally {
    upgraded.close();
  }

  const downgraded = openLegacy(root);
  try {
    expect(downgraded.query("SELECT value FROM meta WHERE key = 'version'").get()).toEqual({
      value: "1",
    });
    expect(
      downgraded
        .query("SELECT conversation_id, seq FROM consumed_seqs WHERE target = ?")
        .get(target),
    ).toEqual({ conversation_id: "B", seq: 5 });
    writeLegacy(downgraded, target, "B", 7);
    expect(downgraded.query("SELECT content FROM drafts WHERE target = ?").get(target)).toEqual({
      content: draft.content,
    });
    downgraded.query("UPDATE drafts SET content = ? WHERE target = ?").run("updated draft", target);
    downgraded
      .query("UPDATE continuations SET choice = 'a', with_input = 0, answered_at = 2")
      .run();
  } finally {
    downgraded.close();
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = new AgentConsumedSeqStore(root);
    try {
      expect(reopened.read(agentId).scopedTargets).toEqual([
        { target, entry: { conversationId: "A", seq: 31 } },
        { target, entry: { conversationId: "B", seq: 7 } },
      ]);
      const db = reopened.stateDb(agentId);
      expect(await new AgentMessageDraftStore(db, () => 3).lookup(target)).toEqual({
        status: "found",
        draft: { ...draft, target, content: "updated draft", savedAt: 1 },
      });
      expect(await new AgentContinuationStore(db, () => 3).lookup(continuation.id)).toEqual({
        status: "answered",
        continuation,
        answer: { choice: "a", withInput: false, answeredAt: 2 },
      });
    } finally {
      reopened.close();
    }
  }
});

test("a fault after the first migration insert rolls back all inserts and permits retry", async () => {
  const root = await stateDirectory();
  const initial = new AgentConsumedSeqStore(root);
  try {
    initial.stateDb(agentId);
  } finally {
    initial.close();
  }

  const legacy = openLegacy(root);
  try {
    writeLegacy(legacy, "#one", "A", 31);
    writeLegacy(legacy, "#two", "B", 7);
    legacy.exec(`
      CREATE TRIGGER interrupt_migration BEFORE INSERT ON scoped_consumed_seqs
      WHEN (SELECT COUNT(*) FROM scoped_consumed_seqs) = 1
      BEGIN SELECT RAISE(FAIL, 'injected migration failure'); END;
    `);

    const interrupted = new AgentConsumedSeqStore(root);
    try {
      expect(() => interrupted.stateDb(agentId)).toThrow("injected migration failure");
      expect(legacy.query("SELECT COUNT(*) AS count FROM scoped_consumed_seqs").get()).toEqual({
        count: 0,
      });
      expect(legacy.query("SELECT COUNT(*) AS count FROM consumed_seqs").get()).toEqual({
        count: 2,
      });
      legacy.exec("DROP TRIGGER interrupt_migration");
      expect(interrupted.read(agentId).scopedTargets).toEqual([
        { target: "#one", entry: { conversationId: "A", seq: 31 } },
        { target: "#two", entry: { conversationId: "B", seq: 7 } },
      ]);
    } finally {
      interrupted.close();
    }
  } finally {
    legacy.close();
  }
});

test("scoped aliases share a key and distinct threads stay isolated", async () => {
  const root = await stateDirectory();
  const legacy = openLegacy(root);
  try {
    writeLegacy(legacy, "#room:08e11aa2", "room", 88);
    writeLegacy(legacy, "#missing-identity", "", 99);
  } finally {
    legacy.close();
  }

  const store = new AgentConsumedSeqStore(root);
  const threadOne = "08e11aa2-ffff-4333-8333-ffffffffffff";
  const threadTwo = "08e11aa2-eeee-4333-8333-eeeeeeeeeeee";
  try {
    expect(store.read(agentId).scopedTargets).toEqual([]);
    store.apply(agentId, {
      upsertScopedTargets: [
        { target: "#room", entry: { conversationId: "room", seq: 4, exactSeqs: [8] } },
        { target: "#alias", entry: { conversationId: "room", seq: 6, exactSeqs: [9] } },
        {
          target: "#alias:08e11aa2",
          threadRootId: threadOne,
          entry: { conversationId: "room", seq: 3 },
        },
        {
          target: "#alias:08e11aa2",
          threadRootId: threadTwo,
          entry: { conversationId: "room", seq: 2 },
        },
        { target: "#room:08e11aa2", entry: { conversationId: "room", seq: 90 } },
      ],
    });
    const rows = store.read(agentId).scopedTargets ?? [];
    expect(rows.map(({ entry, threadRootId }) => ({ entry, threadRootId }))).toEqual([
      { entry: { conversationId: "room", seq: 6, exactSeqs: [8, 9] }, threadRootId: undefined },
      { entry: { conversationId: "room", seq: 2 }, threadRootId: threadTwo },
      { entry: { conversationId: "room", seq: 3 }, threadRootId: threadOne },
    ]);
    expect(store.read(agentId).targets["#room"]).toBeUndefined();
  } finally {
    store.close();
  }
});

test("paired rollback writes use only a provable thread spelling", async () => {
  const root = await stateDirectory();
  const legacy = openLegacy(root);
  const shortTarget = "#room:08e11aa2";
  try {
    writeLegacy(legacy, shortTarget, "room", 88);
    writeLegacy(legacy, "#room", "room", 4);
  } finally {
    legacy.close();
  }

  const store = new AgentConsumedSeqStore(root);
  const threadRootId = "08e11aa2-ffff-4333-8333-ffffffffffff";
  const fullTarget = "#room:" + threadRootId;
  try {
    const short = { target: shortTarget, entry: { conversationId: "room", seq: 6 }, threadRootId };
    store.apply(agentId, { upsertTargets: [short], upsertScopedTargets: [short] });
    expect(store.read(agentId).scopedTargets).toContainEqual(short);
    expect(store.read(agentId).targets[shortTarget]).toBeUndefined();

    const parent = { ...short, target: "#room" };
    store.apply(agentId, { upsertTargets: [parent], upsertScopedTargets: [parent] });
    expect(store.read(agentId).targets["#room"]).toEqual({ conversationId: "room", seq: 4 });

    const full = { ...short, target: fullTarget, entry: { conversationId: "room", seq: 7 } };
    store.apply(agentId, { upsertTargets: [full], upsertScopedTargets: [full] });
    expect(store.read(agentId).targets[fullTarget]).toEqual(full.entry);
  } finally {
    store.close();
  }

  const downgraded = openLegacy(root);
  try {
    writeLegacy(downgraded, fullTarget, "room", 9);
  } finally {
    downgraded.close();
  }

  const reopened = new AgentConsumedSeqStore(root);
  try {
    expect(reopened.read(agentId).scopedTargets).toContainEqual({
      target: fullTarget,
      threadRootId,
      entry: { conversationId: "room", seq: 9 },
    });
  } finally {
    reopened.close();
  }
});

test("an interrupted rollback projection leaves both cursor tables intact", async () => {
  const root = await stateDirectory();
  const store = new AgentConsumedSeqStore(root);
  try {
    const first = { target, entry: { conversationId: "A", seq: 31 } };
    const next = { target, entry: { conversationId: "B", seq: 5 } };
    store.apply(agentId, { upsertTargets: [first], upsertScopedTargets: [first] });
    store.stateDb(agentId).database.exec(`
      CREATE TRIGGER interrupt_projection BEFORE INSERT ON consumed_seqs
      BEGIN SELECT RAISE(FAIL, 'injected projection failure'); END;
    `);
    expect(() =>
      store.apply(agentId, { upsertTargets: [next], upsertScopedTargets: [next] }),
    ).toThrow("injected projection failure");
    expect(store.read(agentId).scopedTargets).toEqual([first]);
    expect(store.read(agentId).targets[target]).toEqual(first.entry);
  } finally {
    store.close();
  }
});
