import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";

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
  expect(new AgentConsumedSeqStore(stateDirectory).read("agent-1")).toEqual(state);
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
      nextReadOrder: 4,
    });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(legacyDirectory)).toBe(false);
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
