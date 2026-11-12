import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import {
  advanceReadPosition,
  readWithPosition,
} from "#src/server/artifacts/artifact-read-positions.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * An Agent's read position on an artifact: reading the current version says what others
 * published since the Agent last looked, and moves the position forward, never back. Its own
 * push (a new artifact's first, or one over a version) moves it too; reading an older version
 * moves nothing.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let blobs: StoredArtifactBlobs;
let documents: ArtifactDocuments;
let artifacts: Artifacts;
let workspaceId: string;
let alice: string;
const agents: Record<"reader" | "writer" | "fresh" | "other", string> = {
  reader: "",
  writer: "",
  fresh: "",
  other: "",
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-read-position-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `rp-a-${handle}`, displayName: "Alice" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `rp-${handle}`,
        name: "Positions",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  for (const [key, displayName] of [
    ["reader", "Reader Bot"],
    ["writer", "Writer Bot"],
    ["fresh", "Fresh Bot"],
    ["other", "Other Bot"],
  ] as const) {
    agents[key] = (
      await db.agent.create({
        data: {
          workspaceId,
          name: `rp-${key}-${handle}`,
          displayName,
          ownerId: alice,
          runtimeConfig: {},
        },
      })
    ).id;
  }
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: alice } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

/** The same database with the read-position store failing: a write to it rejects, and with
 * `reads` a read of it does too, as when the table or its connection is gone after a save
 * committed. */
function positionStoreDown({ reads }: { reads: boolean }) {
  const down = () => Promise.reject(new Error("position store down"));
  return new Proxy(db, {
    get(target, property) {
      if (property === "$executeRaw") return down;
      if (reads && property === "artifactReadPosition") return { findUnique: down };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function post(agentId: string, body: unknown, services: { db: typeof db } = { db }) {
  const response = await handleAgentArtifactPost(
    new Request("http://local/api/agent/v1/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { workspaceId, agentId },
    { db: services.db, documents, enabled: async () => true },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const key = () => crypto.randomUUID();

/** The `document.md` file of some text, uploaded by the Agent and named as a manifest. */
async function document(agentId: string, text: string) {
  const { sha256 } = await blobs.upload({
    workspaceId,
    bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
    actor: { agentId },
  });
  return [{ path: "document.md", sha256 }];
}

/** A Workspace artifact made by the Writer Bot (its version 1). */
async function make(title: string) {
  const created = await post(agents.writer, {
    operation: "push",
    title,
    idempotencyKey: key(),
    files: await document(agents.writer, "one\n"),
  });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

/** A push over the newest version, by an Agent. */
async function save(
  artifact: string,
  by: { agentId: string },
  text: string,
  extra: { note?: string; label?: string } = {},
) {
  const current = (await db.artifact.findUniqueOrThrow({ where: { id: artifact } })).currentVersion;
  const saved = await post(by.agentId, {
    operation: "push",
    artifact,
    baseVersion: current,
    idempotencyKey: key(),
    files: await document(by.agentId, text),
    ...extra,
  });
  expect(saved.body.status).toBe("created");
  return saved.body.number as number;
}

/** The Other Bot, whose pushes are others' (read when used: the ids exist after `beforeAll`). */
const other = {
  get agentId() {
    return agents.other;
  },
};

const positionOf = async (artifactId: string, agentId: string) =>
  (
    await db.artifactReadPosition.findUnique({
      where: { artifactId_agentId: { artifactId, agentId } },
    })
  )?.version;

test("a first read lists what others published, newest first, and says it is the first", async () => {
  const artifact = await make("First read");
  await save(artifact, other, "two\n", { note: "tightened", label: "draft" });
  const read = await post(agents.reader, { operation: "read", artifact });
  expect(read.status).toBe(200);
  // Every field a read answered before is still there.
  expect(read.body).toMatchObject({ text: "two\n", entryPath: "document.md" });
  expect(read.body.unseen).toMatchObject({ firstRead: true, versionCount: 2 });
  expect(read.body.unseen.versions).toEqual([
    {
      number: 2,
      publisher: { kind: "agent", name: "Other Bot" },
      createdAt: expect.any(String),
      note: "tightened",
      label: "draft",
      changedPaths: ["document.md"],
      changedCount: 1,
    },
    {
      number: 1,
      publisher: { kind: "agent", name: "Writer Bot" },
      createdAt: expect.any(String),
      note: "",
      label: "",
      changedPaths: ["document.md"],
      changedCount: 1,
    },
  ]);
  expect(await positionOf(artifact, agents.reader)).toBe(2);

  // The next read has nothing new, and is not a first read.
  const again = await post(agents.reader, { operation: "read", artifact });
  expect(again.body.unseen).toEqual({ firstRead: false, versionCount: 0, versions: [] });
});

test("others' versions since the position are listed and counted; the Agent's own are left out", async () => {
  const artifact = await make("Own and others");
  await post(agents.reader, { operation: "read", artifact });
  await save(artifact, other, "two\n");
  await save(artifact, { agentId: agents.reader }, "three\n");
  await save(artifact, { agentId: agents.writer }, "four\n");
  // The Reader's own push moved its position to 3, so only the Writer's version 4 is new.
  expect(await positionOf(artifact, agents.reader)).toBe(3);
  const read = await post(agents.reader, { operation: "read", artifact });
  expect(read.body.unseen).toMatchObject({ firstRead: false, versionCount: 1 });
  expect(read.body.unseen.versions.map((v: { number: number }) => v.number)).toEqual([4]);

  // A fresh Agent has published none of the four, so it hears of all of them.
  const fresh = await post(agents.fresh, { operation: "read", artifact });
  expect(fresh.body.unseen).toMatchObject({ firstRead: true, versionCount: 4 });
  // Its own version 5 in the middle of the range is excluded from list and count.
  await save(artifact, { agentId: agents.fresh }, "five\n");
  await save(artifact, other, "six\n");
  await db.artifactReadPosition.deleteMany({
    where: { artifactId: artifact, agentId: agents.fresh },
  });
  const rebuilt = await post(agents.fresh, { operation: "read", artifact });
  expect(rebuilt.body.unseen).toMatchObject({ firstRead: true, versionCount: 5 });
  expect(rebuilt.body.unseen.versions.map((v: { number: number }) => v.number)).toEqual([
    6, 4, 3, 2, 1,
  ]);
});

test("a read lists the newest five of many and counts them all", async () => {
  const artifact = await make("Many");
  for (let n = 2; n <= 8; n += 1) await save(artifact, other, `v${n}\n`);
  const read = await post(agents.reader, { operation: "read", artifact });
  expect(read.body.unseen).toMatchObject({ firstRead: true, versionCount: 8 });
  expect(read.body.unseen.versions.map((v: { number: number }) => v.number)).toEqual([
    8, 7, 6, 5, 4,
  ]);
});

test("the position moves on a read of the current version, not of an older one", async () => {
  const artifact = await make("Older");
  await save(artifact, other, "two\n");
  await save(artifact, other, "three\n");

  const older = await post(agents.reader, { operation: "read", artifact, version: 1 });
  expect(older.body.unseen).toBeNull();
  expect(await positionOf(artifact, agents.reader)).toBeUndefined();

  // Naming the current version is reading the current version.
  const current = await post(agents.reader, { operation: "read", artifact, version: 3 });
  expect(current.body.unseen).toMatchObject({ firstRead: true, versionCount: 3 });
  expect(await positionOf(artifact, agents.reader)).toBe(3);

  // A later read of an older version leaves it where it was.
  await post(agents.reader, { operation: "read", artifact, version: 2 });
  expect(await positionOf(artifact, agents.reader)).toBe(3);
});

test("an Agent's first push and its pushes over a version move its position to its own version", async () => {
  const artifact = await make("Mine");
  // The Writer made version 1 and has not read it: its push moved it.
  expect(await positionOf(artifact, agents.writer)).toBe(1);
  await save(artifact, other, "two\n");
  await save(artifact, { agentId: agents.fresh }, "three\n");
  expect(await positionOf(artifact, agents.fresh)).toBe(3);
  const read = await post(agents.fresh, { operation: "read", artifact });
  expect(read.body.unseen).toEqual({ firstRead: false, versionCount: 0, versions: [] });
  // The Writer still has Alice's and the Fresh Bot's versions to hear about.
  const writer = await post(agents.writer, { operation: "read", artifact });
  expect(writer.body.unseen).toMatchObject({ firstRead: false, versionCount: 2 });
});

test("a position never moves backwards, however the writes arrive", async () => {
  const artifact = await make("Racing");
  const agentId = agents.reader;
  await advanceReadPosition(db, { artifactId: artifact, agentId, version: 5 });
  await advanceReadPosition(db, { artifactId: artifact, agentId, version: 3 });
  expect(await positionOf(artifact, agentId)).toBe(5);
  await advanceReadPosition(db, { artifactId: artifact, agentId, version: 7 });
  expect(await positionOf(artifact, agentId)).toBe(7);
  await Promise.all(
    [2, 9, 4, 8, 1].map((version) =>
      advanceReadPosition(db, { artifactId: artifact, agentId, version }),
    ),
  );
  expect(await positionOf(artifact, agentId)).toBe(9);
});

test("deleting an artifact removes its read positions", async () => {
  const artifact = await make("Gone");
  await post(agents.reader, { operation: "read", artifact });
  expect(await db.artifactReadPosition.count({ where: { artifactId: artifact } })).toBe(2);
  await db.artifact.delete({ where: { id: artifact } });
  expect(await db.artifactReadPosition.count({ where: { artifactId: artifact } })).toBe(0);
});

test("a failing position store never fails a committed push, or a read", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const created = await post(
      agents.writer,
      {
        operation: "push",
        title: "Bookkeeping",
        idempotencyKey: key(),
        files: await document(agents.writer, "one\n"),
      },
      { db: positionStoreDown({ reads: true }) },
    );
    expect(created.status).toBe(200);
    const artifact = created.body.id as string;
    expect(await positionOf(artifact, agents.writer)).toBeUndefined();

    const pushed = await post(
      agents.writer,
      {
        operation: "push",
        artifact,
        baseVersion: 1,
        idempotencyKey: key(),
        files: await document(agents.writer, "two\n"),
      },
      { db: positionStoreDown({ reads: true }) },
    );
    expect(pushed.status).toBe(200);
    expect(pushed.body).toMatchObject({ status: "created", number: 2 });

    // The read still answers, with the version list it could not look up a position for.
    const read = await post(
      agents.reader,
      { operation: "read", artifact },
      { db: positionStoreDown({ reads: true }) },
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ text: "two\n" });
    expect(warn).toHaveBeenCalled();
    for (const [line] of warn.mock.calls)
      expect(JSON.parse(String(line))).toMatchObject({
        event: expect.stringMatching(/^artifacts:/),
      });
  } finally {
    warn.mockRestore();
  }
});

test("a read whose position write fails still returns what it computed", async () => {
  const artifact = await make("Computed");
  await save(artifact, other, "two\n");
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const failingWrite = positionStoreDown({ reads: false });
    const read = await post(agents.reader, { operation: "read", artifact }, { db: failingWrite });
    expect(read.status).toBe(200);
    expect(read.body.unseen).toMatchObject({ firstRead: true, versionCount: 2 });
    expect(await positionOf(artifact, agents.reader)).toBeUndefined();
  } finally {
    warn.mockRestore();
  }
});

test("publishers show by their display name; a blank one never shows a username", async () => {
  const blankAgent = await db.agent.create({
    data: {
      workspaceId,
      name: `rp-blank-agent-${handle}`,
      displayName: "",
      ownerId: alice,
      runtimeConfig: {},
    },
  });
  try {
    const artifact = await make("Names");
    const saved = await post(blankAgent.id, {
      operation: "push",
      artifact,
      baseVersion: 1,
      idempotencyKey: key(),
      files: await document(blankAgent.id, "two\n"),
    });
    expect(saved.body.status).toBe("created");
    const read = await post(agents.reader, { operation: "read", artifact });
    const names = read.body.unseen.versions.map(
      (v: { publisher: { kind: string; name: string } }) => v.publisher,
    );
    expect(names).toEqual([
      { kind: "agent", name: `rp-blank-agent-${handle}` },
      { kind: "agent", name: "Writer Bot" },
    ]);
  } finally {
    await db.agent.deleteMany({ where: { id: blankAgent.id } });
  }
});

test("the unseen range stops at the version the read shows", async () => {
  const artifact = await make("Bounded");
  await save(artifact, other, "two\n");
  await save(artifact, other, "three\n");
  // A version published between the load (which showed 2) and the position read is not counted,
  // and the position moves to what was shown, so the next read still reports it.
  const summary = await readWithPosition(db, {
    artifactId: artifact,
    agentId: agents.reader,
    workspaceId,
    shown: 2,
    current: 2,
  });
  expect(summary).toMatchObject({ firstRead: true, versionCount: 2 });
  expect(summary?.versions.map((v) => v.number)).toEqual([2, 1]);
  expect(await positionOf(artifact, agents.reader)).toBe(2);
  const next = await post(agents.reader, { operation: "read", artifact });
  expect(next.body.unseen).toMatchObject({ firstRead: false, versionCount: 1 });
});

test("a re-read that finds nothing new writes nothing", async () => {
  const artifact = await make("Quiet");
  await post(agents.reader, { operation: "read", artifact });
  const stamp = async () =>
    (
      await db.$queryRaw<{ xmin: string }[]>`
        SELECT xmin::text AS xmin FROM "artifact_read_positions"
        WHERE "artifactId" = ${artifact}::uuid AND "agentId" = ${agents.reader}::uuid`
    )[0]?.xmin;
  const before = await stamp();
  expect(before).toBeDefined();
  await post(agents.reader, { operation: "read", artifact });
  await advanceReadPosition(db, { artifactId: artifact, agentId: agents.reader, version: 1 });
  expect(await stamp()).toBe(before);
});

test("a version lists at most ten changed paths and counts them all", async () => {
  const artifact = await make("Wide");
  const paths = Array.from({ length: 14 }, (_, n) => `file-${String(n).padStart(2, "0")}.md`);
  await db.artifactVersion.create({
    data: {
      artifactId: artifact,
      number: 2,
      publisherAgentId: agents.other,
      entryPath: "document.md",
      changedPaths: { added: paths.slice(0, 11), deleted: paths.slice(11) },
      idempotencyKey: key(),
    },
  });
  await db.artifact.update({ where: { id: artifact }, data: { currentVersion: 2 } });
  const read = await post(agents.reader, { operation: "read", artifact });
  const wide = read.body.unseen.versions[0];
  expect(wide.number).toBe(2);
  expect(wide.changedCount).toBe(14);
  expect(wide.changedPaths).toEqual(paths.slice(0, 10));
});
