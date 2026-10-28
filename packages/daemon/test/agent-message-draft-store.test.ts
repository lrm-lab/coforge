import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import {
  AgentMessageDraftStore,
  AGENT_MESSAGE_DRAFT_TTL_MS,
} from "#src/persistence/agent-message-draft-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const temporaryStateDirectory = () => {
  const path = join(tmpdir(), `coforge-agent-drafts-${crypto.randomUUID()}`);
  directories.push(path);
  return path;
};

const storeFor = (
  root: string,
  agentId = "agent-a",
  now: () => number = () => 1_000,
): AgentMessageDraftStore => new AgentMessageDraftStore(AgentStateDb.open(root, agentId), now);

/** The draft `lookup` found, or `undefined` for any other status. */
async function found(store: AgentMessageDraftStore, target: string) {
  const lookup = await store.lookup(target);
  return lookup.status === "found" ? lookup.draft : undefined;
}

const dbPath = (root: string, agentId = "agent-a") =>
  join(root, "agent-state", agentId, "state.db");

const draftRow = (root: string, target: string, agentId = "agent-a") => {
  const db = new Database(dbPath(root, agentId), { readonly: true });
  try {
    return db.prepare(`SELECT * FROM drafts WHERE target = ?`).get(target) as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
};

test("saves and looks up one Agent message draft as its row", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);

  await store.save("@ada", { content: "draft reply", idempotencyKey: "key-1" });

  expect(await store.lookup("@ada")).toEqual({
    status: "found",
    draft: {
      target: "@ada",
      content: "draft reply",
      idempotencyKey: "key-1",
      reholdCount: 0,
      savedAt: 1_000,
    },
  });
  // The row: one per target, the text in `content`, the send's key in `idempotency_key`.
  expect(draftRow(stateDirectory, "@ada")).toMatchObject({
    target: "@ada",
    content: "draft reply",
    idempotency_key: "key-1",
    saved_at: 1_000,
    rehold_count: 0,
  });
});

test("keeps each target's draft under its own key and clears one without the other", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  await store.save("@ada", { content: "to ada", idempotencyKey: "key-ada" });
  await store.save("#general", { content: "to the channel", idempotencyKey: "key-general" });

  expect((await found(store, "@ada"))?.content).toBe("to ada");
  expect((await found(store, "#general"))?.content).toBe("to the channel");

  await store.clear("@ada");
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  expect((await found(store, "#general"))?.content).toBe("to the channel");
});

test("saves and looks up a held draft's attachmentIds, mentions and seenUpToSeq", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  await store.save("@ada", {
    content: "draft with parts",
    idempotencyKey: "key-1",
    attachmentIds: ["attachment-1", "attachment-2"],
    mentions: [{ type: "user", id: "user-1", name: "ada" }],
    seenUpToSeq: 9,
    seenExactSeqs: [11, 12],
  });

  expect(await found(store, "@ada")).toEqual({
    target: "@ada",
    content: "draft with parts",
    idempotencyKey: "key-1",
    attachmentIds: ["attachment-1", "attachment-2"],
    mentions: [{ type: "user", id: "user-1", name: "ada" }],
    seenUpToSeq: 9,
    seenExactSeqs: [11, 12],
    reholdCount: 0,
    savedAt: 1_000,
  });
});

test("reads a row the store did not write, including its key and seenUpToSeq", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  // Rows can also arrive through the legacy import or a hand edit: they read like stored ones.
  new Database(dbPath(stateDirectory))
    .prepare(
      `INSERT INTO drafts
         (target, content, idempotency_key, saved_at, rehold_count, seen_up_to_seq, seen_exact_seqs)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("@ada", "hand-written", "key-7", 500, 2, 12, "[14,15]");

  expect(await found(store, "@ada")).toEqual({
    target: "@ada",
    content: "hand-written",
    idempotencyKey: "key-7",
    reholdCount: 2,
    savedAt: 500,
    seenUpToSeq: 12,
    seenExactSeqs: [14, 15],
  });
});

test("keeps a draft's exact seen sequences deduplicated and bounded", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  new Database(dbPath(stateDirectory))
    .prepare(
      `INSERT INTO drafts
         (target, content, idempotency_key, saved_at, rehold_count, seen_up_to_seq, seen_exact_seqs)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("@ada", "with seqs", "key-1", 500, 0, 4, JSON.stringify([9, 6, 6, 3, 4, 2.5, "7"]));

  expect((await found(store, "@ada"))?.seenExactSeqs).toEqual([6, 9]);
});

test("a draft without an idempotency key names no logical send and reads as missing", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  new Database(dbPath(stateDirectory))
    .prepare(
      `INSERT INTO drafts (target, content, idempotency_key, saved_at, rehold_count)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("@ada", "no key", "", 500, 0);

  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
});

test("a revised send replaces the draft and resets its hold count", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  await store.save("@ada", { content: "first", idempotencyKey: "key-1" });
  await store.replace("@ada", {
    content: "first",
    idempotencyKey: "key-1",
    reholdCount: 3,
  });
  expect((await found(store, "@ada"))?.reholdCount).toBe(3);

  await store.save("@ada", { content: "revised", idempotencyKey: "key-2" });
  expect(await found(store, "@ada")).toMatchObject({
    content: "revised",
    idempotencyKey: "key-2",
    reholdCount: 0,
  });
});

test("keeps the logical send's idempotency key through a held refresh", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  await store.save("@ada", { content: "held", idempotencyKey: "key-1" });
  await store.replace("@ada", {
    content: "held",
    idempotencyKey: "key-1",
    reholdCount: 1,
  });
  expect((await found(store, "@ada"))?.idempotencyKey).toBe("key-1");
});

test("an expired draft is reported once with its last body; only the looked-up target is removed", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = storeFor(stateDirectory, "agent-a", () => now);
  await store.save("@ada", { content: "stale reply", idempotencyKey: "key-1" });
  await store.save("#general", { content: "other stale reply", idempotencyKey: "key-2" });

  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;

  expect(await store.lookup("@ada")).toEqual({
    status: "expired",
    content: "stale reply",
    savedAt: 1_000,
  });
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });
  // Looking up an expired draft removes only its own row: another target's expired draft
  // still reports itself, with its last body.
  expect(await store.lookup("#general")).toEqual({
    status: "expired",
    content: "other stale reply",
    savedAt: 1_000,
  });
});

test("writing one target's draft never drops another target's expired draft", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = storeFor(stateDirectory, "agent-a", () => now);
  await store.save("@ada", { content: "draft for ada", idempotencyKey: "key-ada" });

  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;
  await store.save("#general", { content: "draft for general", idempotencyKey: "key-general" });
  await store.replace("#general", {
    content: "draft for general",
    idempotencyKey: "key-general",
    reholdCount: 1,
  });
  expect(await store.clearIfIdempotencyKeyMatches("#general", "key-general")).toBe(true);
  await store.clear("#general");

  expect(await store.lookup("@ada")).toEqual({
    status: "expired",
    content: "draft for ada",
    savedAt: 1_000,
  });
});

test("an idempotency key is kept exactly as written; only a blank one reads as missing", async () => {
  const stateDirectory = temporaryStateDirectory();
  const store = storeFor(stateDirectory);
  new Database(dbPath(stateDirectory))
    .prepare(
      `INSERT INTO drafts (target, content, idempotency_key, saved_at, rehold_count)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("@ada", "spaced", " key-1 ", 500, 0);

  expect((await found(store, "@ada"))?.idempotencyKey).toBe(" key-1 ");
  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-1")).toBe(false);
});

test("clears a draft only for the send whose idempotency key it holds, and never an expired one", async () => {
  const stateDirectory = temporaryStateDirectory();
  let now = 1_000;
  const store = storeFor(stateDirectory, "agent-a", () => now);
  await store.save("@ada", { content: "newer draft", idempotencyKey: "key-new" });

  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-old")).toBe(false);
  expect((await found(store, "@ada"))?.content).toBe("newer draft");

  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-new")).toBe(true);
  expect(await store.lookup("@ada")).toEqual({ status: "missing" });

  await store.save("@ada", { content: "stale draft", idempotencyKey: "key-stale" });
  now += AGENT_MESSAGE_DRAFT_TTL_MS + 1;
  expect(await store.clearIfIdempotencyKeyMatches("@ada", "key-stale")).toBe(false);
});

test("the first open imports the legacy draft file and deletes it", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = temporaryStateDirectory();
  const legacyDirectory = join(
    legacyRoot,
    `coforge-cli-attested-send-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    "agent-a",
  );
  const legacyPath = join(legacyDirectory, "continue-state.json");
  await mkdir(legacyDirectory, { recursive: true });
  await Bun.write(
    legacyPath,
    JSON.stringify({
      targets: {
        "@ada": {
          content: "legacy draft",
          idempotencyKey: "key-legacy",
          savedAt: 500,
          reholdCount: 2,
          seenUpToSeq: 8,
        },
      },
    }),
  );
  const previous = Bun.env.COFORGE_CLI_DRAFT_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_DRAFT_STATE_DIR = legacyRoot;
    const store = storeFor(stateDirectory);
    expect(await found(store, "@ada")).toEqual({
      target: "@ada",
      content: "legacy draft",
      idempotencyKey: "key-legacy",
      reholdCount: 2,
      savedAt: 500,
      seenUpToSeq: 8,
    });
    expect(existsSync(legacyPath)).toBe(false);
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_DRAFT_STATE_DIR;
    else Bun.env.COFORGE_CLI_DRAFT_STATE_DIR = previous;
  }
});

test("a legacy draft with no savedAt is expired at once, and reported once", async () => {
  const stateDirectory = temporaryStateDirectory();
  const legacyRoot = temporaryStateDirectory();
  const legacyDirectory = join(
    legacyRoot,
    `coforge-cli-attested-send-${encodeURIComponent(String(process.geteuid?.() ?? "")).replaceAll(".", "%2E")}`,
    "agent-a",
  );
  const legacyPath = join(legacyDirectory, "continue-state.json");
  await mkdir(legacyDirectory, { recursive: true });
  await Bun.write(
    legacyPath,
    JSON.stringify({ targets: { "@ada": { content: "no age", idempotencyKey: "key-old" } } }),
  );
  const previous = Bun.env.COFORGE_CLI_DRAFT_STATE_DIR;
  try {
    Bun.env.COFORGE_CLI_DRAFT_STATE_DIR = legacyRoot;
    // An unknown age is the epoch: too old to resend, rather than a draft that never expires.
    const store = storeFor(stateDirectory, "agent-a", () => Date.now());
    expect(await store.lookup("@ada")).toMatchObject({ status: "expired", content: "no age" });
    expect(await store.lookup("@ada")).toEqual({ status: "missing" });
    expect(existsSync(legacyPath)).toBe(false);
  } finally {
    if (previous === undefined) delete Bun.env.COFORGE_CLI_DRAFT_STATE_DIR;
    else Bun.env.COFORGE_CLI_DRAFT_STATE_DIR = previous;
  }
});

test("rejects a linked Agent state directory before touching its database", async () => {
  const stateDirectory = temporaryStateDirectory();
  const elsewhere = temporaryStateDirectory();
  await mkdir(join(stateDirectory, "agent-state"), { recursive: true });
  await symlink(elsewhere, join(stateDirectory, "agent-state", "agent-a"));

  expect(() => AgentStateDb.open(stateDirectory, "agent-a")).toThrow(
    "Agent state path must be a real directory",
  );
});
