import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryStateDirectory = () => {
  const path = join(tmpdir(), `coforge-consumed-seqs-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
};

/** Where an Agent's ledger lands: `<root>/agent-state/<agentId>/state.db`. */
const dbPath = (root: string, agentId = "agent-1") =>
  join(root, "agent-state", agentId, "state.db");

const cursorRows = (root: string, agentId = "agent-1") => {
  const db = new Database(dbPath(root, agentId), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM consumed_seqs`).all();
  } finally {
    db.close();
  }
};

const metaRows = (root: string, agentId = "agent-1") => {
  const db = new Database(dbPath(root, agentId), { readonly: true });
  try {
    return Object.fromEntries(
      (db.prepare(`SELECT key, value FROM meta`).all() as { key: string; value: string }[]).map(
        (row) => [row.key, row.value],
      ),
    );
  } finally {
    db.close();
  }
};

test("an empty root still refuses to be the state directory", () => {
  expect(() => new AgentConsumedSeqStore("")).toThrow(
    "consumed-sequence state directory is required",
  );
});

test("writes one row per target and reads the state back", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  const state = {
    targets: {
      "@ada": { conversationId: "conversation-1", seq: 7, exactSeqs: [9, 12] },
      "#general:abcd1234": { conversationId: "conversation-1", readOrder: 1, reviewedSeq: 3 },
    },
    aliases: { "#general:ABCD1234": "#general:abcd1234" },
    nextReadOrder: 2,
  };

  store.write("agent-1", state);

  // Every write is committed when it happens — no delay, no flush.
  expect(await readdir(join(stateDirectory, "agent-state", "agent-1"))).toContain("state.db");
  expect(cursorRows(stateDirectory)).toHaveLength(2);
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1")).toEqual({
    ...state,
    scopedTargets: [{ target: "@ada", entry: state.targets["@ada"] }],
  });
  store.close();
});

test("a write replaces every row of the previous snapshot in one transaction", () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: {
      "@ada": { conversationId: "conversation-1", seq: 7 },
      "@bea": { conversationId: "conversation-1", seq: 2 },
    },
    aliases: {},
    nextReadOrder: 1,
  });
  store.write("agent-1", {
    targets: { "@ada": { conversationId: "conversation-1", seq: 9 } },
    aliases: {},
    nextReadOrder: 1,
  });
  expect(cursorRows(stateDirectory)).toHaveLength(1);
  expect(store.read("agent-1").targets["@ada"]).toEqual({
    conversationId: "conversation-1",
    seq: 9,
  });
});

test("rows nobody in this process wrote still normalize on read", () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  const db = store.stateDb("agent-1").database;
  db.prepare(
    `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("@ada", "conversation-1", 4, null, null, JSON.stringify([9, 6, 6, 3, 4, 2.5, "7"]));
  db.prepare(
    `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "@bea",
    "conversation-1",
    null,
    null,
    null,
    JSON.stringify(Array.from({ length: 2600 }, (_, index) => index + 1)),
  );
  // A reviewedSeq beside no readOrder is dropped with the order; a row missing its
  // conversation id cannot say whose sequences it holds.
  db.prepare(
    `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("@cyd", "conversation-1", null, null, 8, "[]");
  db.prepare(
    `INSERT INTO consumed_seqs (target, conversation_id, seq, read_order, reviewed_seq, exact_seqs)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("@dot", "", 5, null, null, "[]");

  const targets = store.read("agent-1").targets;
  expect(targets["@ada"]).toEqual({ conversationId: "conversation-1", seq: 4, exactSeqs: [6, 9] });
  const kept = targets["@bea"]?.exactSeqs ?? [];
  expect([kept.length, kept[0], kept.at(-1)]).toEqual([2500, 101, 2600]);
  expect(targets["@cyd"]).toBeUndefined();
  expect(targets["@dot"]).toBeUndefined();
});

test("the next read order recomputes above every stored order", () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: {
      "@ada": { conversationId: "conversation-1", readOrder: 4, reviewedSeq: 9 },
      "@bea": { conversationId: "conversation-1", seq: 40 },
    },
    aliases: {},
    nextReadOrder: 1,
  });
  // A frontier recorded without a review does not push the counter up to its sequence.
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").nextReadOrder).toBe(5);
});

test("alias chains compress on read and cycles drop", () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: { "@ada": { conversationId: "conversation-1", seq: 1 } },
    aliases: { "@ADA": "@ada", "@adA": "@ADA" },
    nextReadOrder: 1,
  });
  const db = store.stateDb("agent-1").database;
  db.prepare(`INSERT OR REPLACE INTO consumed_seq_aliases (spelling, canonical) VALUES (?, ?)`).run(
    "@loop1",
    "@loop2",
  );
  db.prepare(`INSERT OR REPLACE INTO consumed_seq_aliases (spelling, canonical) VALUES (?, ?)`).run(
    "@loop2",
    "@loop1",
  );
  expect(store.read("agent-1").aliases).toEqual({ "@ADA": "@ada", "@adA": "@ada" });
});

test("the first open imports the legacy JSON cursor and deletes the file", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = temporaryStateDirectory();
  const legacyDirectory = join(
    legacyRoot,
    `coforge-cli-consumed-seq-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    "agent-1",
  );
  const legacyPath = join(legacyDirectory, "consumed-seqs.json");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({
      targets: {
        "@ada": { conversationId: "conversation-1", seq: 7, exactSeqs: [9] },
        "@bea": { conversationId: "conversation-1", readOrder: 3, reviewedSeq: 4 },
      },
      aliases: { "@ADA": "@ada" },
      nextReadOrder: 99,
    }),
  );
  const previous = Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = legacyRoot;
    const store = new AgentConsumedSeqStore(stateDirectory);
    expect(store.read("agent-1")).toEqual({
      targets: {
        "@ada": { conversationId: "conversation-1", seq: 7, exactSeqs: [9] },
        "@bea": { conversationId: "conversation-1", readOrder: 3, reviewedSeq: 4 },
      },
      aliases: { "@ADA": "@ada" },
      scopedTargets: [
        {
          target: "@bea",
          entry: {
            conversationId: "conversation-1",
            seq: 7,
            exactSeqs: [9],
            readOrder: 3,
            reviewedSeq: 4,
          },
        },
      ],
      nextReadOrder: 4,
    });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyDirectory)).toBe(false);
    expect(metaRows(stateDirectory)).toEqual({ version: "1", legacyImported: "true" });
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
    else Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = previous;
  }
});

test("the import marker keeps a legacy file that reappears out of a migrated database", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = temporaryStateDirectory();
  const legacyDirectory = join(
    legacyRoot,
    `coforge-cli-consumed-seq-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    "agent-1",
  );
  const legacyPath = join(legacyDirectory, "consumed-seqs.json");
  await mkdir(legacyDirectory, { recursive: true });
  await writeFile(
    legacyPath,
    JSON.stringify({ targets: { "@ada": { conversationId: "conversation-1", seq: 7 } } }),
  );
  const previous = Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = legacyRoot;
    new AgentConsumedSeqStore(stateDirectory).read("agent-1");
    // An older build (or a stray copy) writes the file again after the import already ran, and the
    // import removed the directory it lived in.
    await mkdir(legacyDirectory, { recursive: true });
    await writeFile(
      legacyPath,
      JSON.stringify({ targets: { "@bea": { conversationId: "conversation-1", seq: 4 } } }),
    );
    expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").targets).toEqual({
      "@ada": { conversationId: "conversation-1", seq: 7 },
    });
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR;
    else Bun.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = previous;
  }
});

test("the Agent state directories are real and owned", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", { targets: {}, aliases: {}, nextReadOrder: 1 });
  const directory = await stat(join(stateDirectory, "agent-state", "agent-1"));
  expect(directory.isDirectory()).toBe(true);
  expect(directory.mode & 0o777).toBe(0o700);
});

test("an older snapshot never moves a cursor, a review boundary or a read order backwards", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: {
      "@ada": {
        conversationId: "conversation-1",
        seq: 9,
        readOrder: 5,
        reviewedSeq: 9,
        exactSeqs: [11, 13],
      },
    },
    aliases: {},
    nextReadOrder: 6,
  });
  // A snapshot from an earlier read arrives after it: the database keeps what it already has.
  store.write("agent-1", {
    targets: {
      "@ada": {
        conversationId: "conversation-1",
        seq: 7,
        readOrder: 3,
        reviewedSeq: 7,
        exactSeqs: [9],
      },
    },
    aliases: {},
    nextReadOrder: 4,
  });
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").targets["@ada"]).toEqual({
    conversationId: "conversation-1",
    seq: 9,
    readOrder: 5,
    reviewedSeq: 9,
    // The frontier did not move, so the seen sequences are the union; normalization drops the
    // ones at or below it.
    exactSeqs: [11, 13],
  });
});

test("a target that moved to another conversation starts over", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: { "@ada": { conversationId: "conversation-1", seq: 9, readOrder: 5, reviewedSeq: 9 } },
    aliases: {},
    nextReadOrder: 6,
  });
  // A channel deleted and recreated under the same name: its sequences restart, so the old
  // frontier is not a floor.
  store.write("agent-1", {
    targets: { "@ada": { conversationId: "conversation-2", seq: 2, readOrder: 1, reviewedSeq: 2 } },
    aliases: {},
    nextReadOrder: 2,
  });
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").targets["@ada"]).toEqual({
    conversationId: "conversation-2",
    seq: 2,
    readOrder: 1,
    reviewedSeq: 2,
  });
});

test("a database a newer build wrote is refused instead of migrated", async () => {
  const stateDirectory = temporaryStateDirectory();
  new AgentConsumedSeqStore(stateDirectory).write("agent-1", {
    targets: {},
    aliases: {},
    nextReadOrder: 1,
  });
  const db = new Database(dbPath(stateDirectory));
  db.prepare(`UPDATE meta SET value = '999' WHERE key = 'version'`).run();
  db.close();
  expect(() => AgentStateDb.open(stateDirectory, "agent-1")).toThrow(
    "Agent state database version 999 is newer than this daemon (1)",
  );
});

test("removing an Agent closes its ledger and deletes its directory", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: { "@ada": { conversationId: "conversation-1", seq: 7 } },
    aliases: {},
    nextReadOrder: 2,
  });
  expect(existsSync(dbPath(stateDirectory))).toBe(true);
  store.remove("agent-1");
  // A deleted Agent leaves no database behind in the daemon's state directory.
  expect(existsSync(join(stateDirectory, "agent-state", "agent-1"))).toBe(false);
  // The next use opens a fresh, empty ledger rather than a closed handle.
  expect(store.read("agent-1").targets).toEqual({});
});

test("apply updates and deletes only named targets and aliases while preserving monotonicity", () => {
  const stateDirectory = temporaryStateDirectory();
  const store = new AgentConsumedSeqStore(stateDirectory);
  store.write("agent-1", {
    targets: {
      "@ada": {
        conversationId: "conversation-1",
        seq: 9,
        readOrder: 5,
        reviewedSeq: 9,
        exactSeqs: [11, 13],
      },
      "@bea": { conversationId: "conversation-2", seq: 4 },
    },
    aliases: { "@ADA": "@ada", "@BEA": "@bea" },
    nextReadOrder: 6,
  });

  store.apply("agent-1", {
    upsertTargets: [
      {
        target: "@ada",
        entry: {
          conversationId: "conversation-1",
          seq: 7,
          readOrder: 3,
          reviewedSeq: 7,
          exactSeqs: [15],
        },
      },
      {
        target: "@cyd",
        entry: { conversationId: "conversation-3", seq: 2, exactSeqs: [5] },
      },
    ],
    upsertAliases: [{ spelling: "@CYD", canonical: "@cyd" }],
    deleteAliases: ["@BEA"],
  });

  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1")).toEqual({
    targets: {
      "@ada": {
        conversationId: "conversation-1",
        seq: 9,
        readOrder: 5,
        reviewedSeq: 9,
        exactSeqs: [11, 13],
      },
      "@bea": { conversationId: "conversation-2", seq: 4 },
      "@cyd": { conversationId: "conversation-3", seq: 2, exactSeqs: [5] },
    },
    aliases: { "@ADA": "@ada", "@CYD": "@cyd" },
    scopedTargets: [
      {
        target: "@ada",
        entry: {
          conversationId: "conversation-1",
          seq: 9,
          exactSeqs: [11, 13],
          readOrder: 5,
          reviewedSeq: 9,
        },
      },
      { target: "@bea", entry: { conversationId: "conversation-2", seq: 4 } },
      { target: "@cyd", entry: { conversationId: "conversation-3", seq: 2, exactSeqs: [5] } },
    ],
    nextReadOrder: 6,
  });

  store.apply("agent-1", {
    upsertTargets: [
      {
        target: "@ada",
        entry: { conversationId: "conversation-1", seq: 9, exactSeqs: [15] },
      },
      {
        target: "@cyd",
        entry: { conversationId: "conversation-3-recreated", seq: 1 },
      },
    ],
    deleteTargets: ["@bea"],
  });

  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1")).toEqual({
    targets: {
      "@ada": {
        conversationId: "conversation-1",
        seq: 9,
        readOrder: 5,
        reviewedSeq: 9,
        exactSeqs: [11, 13, 15],
      },
      "@cyd": { conversationId: "conversation-3-recreated", seq: 1 },
    },
    aliases: { "@ADA": "@ada", "@CYD": "@cyd" },
    scopedTargets: [
      {
        target: "@ada",
        entry: {
          conversationId: "conversation-1",
          seq: 9,
          exactSeqs: [11, 13, 15],
          readOrder: 5,
          reviewedSeq: 9,
        },
      },
      { target: "@bea", entry: { conversationId: "conversation-2", seq: 4 } },
      { target: "@cyd", entry: { conversationId: "conversation-3", seq: 2, exactSeqs: [5] } },
      { target: "@cyd", entry: { conversationId: "conversation-3-recreated", seq: 1 } },
    ],
    nextReadOrder: 6,
  });

  expect(() => store.apply("../escape", { deleteTargets: ["@ada"] })).toThrow(
    "invalid consumed-sequence Agent scope",
  );
  store.close();
});

test("AgentConsumedAttention uses incremental apply, skips no-op initial binds, and syncs resets and alias flips", async () => {
  const { AgentConsumedAttention } = await import("#src/daemon-runtime/agent-consumed-attention");
  const { PreviewSeen } = await import("#src/daemon-runtime/inbox-preview-rows");
  const stateDirectory = temporaryStateDirectory();
  const backing = new AgentConsumedSeqStore(stateDirectory);
  let fullWrites = 0;
  const deltas: unknown[] = [];
  const spyPort = {
    read: (agentId: string) => backing.read(agentId),
    write: (agentId: string, state: Parameters<AgentConsumedSeqStore["write"]>[1]) => {
      fullWrites++;
      backing.write(agentId, state);
    },
    apply: (agentId: string, delta: Parameters<AgentConsumedSeqStore["apply"]>[1]) => {
      deltas.push(delta);
      backing.apply(agentId, delta);
    },
  };
  const attention = new AgentConsumedAttention({
    store: () => spyPort,
    previewSeen: new PreviewSeen(),
    settlePending: () => {},
  });

  attention.bindConversation("agent-1", "#general", "conv-1");
  expect(fullWrites).toBe(0);
  expect(deltas).toHaveLength(0);

  attention.recordModelSeen("agent-1", "#early", 5);
  expect(deltas).toHaveLength(0);
  attention.bindConversation("agent-1", "#early", "conv-early");
  expect(deltas).toHaveLength(1);
  expect(backing.read("agent-1").targets["#early"]).toEqual({
    conversationId: "conv-early",
    seq: 5,
  });

  attention.recordModelSeen("agent-1", "#general", 10);
  attention.recordReadContext("agent-1", "#general", 10);
  attention.bindConversation("agent-1", "#general", "conv-2");
  expect(backing.read("agent-1").targets["#general"]).toEqual({
    conversationId: "conv-2",
    readOrder: 1,
  });

  attention.bindConversation("agent-1", "#early", "conv-early-2");
  expect(backing.read("agent-1").targets["#early"]).toBeUndefined();

  attention.recordTargetAlias("agent-1", "b", "a");
  attention.recordTargetAlias("agent-1", "x", "b");
  attention.recordTargetAlias("agent-1", "a", "b");
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1").aliases).toEqual({
    a: "b",
    x: "b",
  });
  expect(fullWrites).toBe(0);
  backing.close();
});
