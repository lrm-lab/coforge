import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

/**
 * A push over a version others moved past: what the others changed and the push did not touch is
 * kept, and nothing is ever merged inside a file. A file, or a setting, both sides changed (or one
 * deleted and the other changed) refuses the whole push with `artifact-base-moved`, naming each
 * of them.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let documents: ArtifactDocuments;
let workspaceId: string;
let userId: string;
let agentId: string;
let otherId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-agent-base-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  userId = (await db.user.create({ data: { username: `ab-${handle}`, displayName: "Base" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `ab-${handle}`, name: "Base", members: { create: { userId, role: "owner" } } },
    })
  ).id;
  const newAgent = async (name: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId,
          name: `ab-${name}-${handle}`,
          displayName: name,
          ownerId: userId,
          runtimeConfig: {},
        },
      })
    ).id;
  agentId = await newAgent("bot");
  otherId = await newAgent("other");
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

// Read when used: the ids exist once `beforeAll` has run.
const agent = {
  get agentId() {
    return agentId;
  },
};
/** The other Agent, whose pushes move an artifact on beneath the first's. */
const other = {
  get agentId() {
    return otherId;
  },
};
const reader = {
  get userId() {
    return userId;
  },
};

const upload = async (text: string, actor: { agentId: string }) =>
  (await blobs.upload({ workspaceId, bytes: new TextEncoder().encode(text), actor })).sha256;

/** One push of text files by path (`undefined` text deletes the path). */
async function push(
  artifactId: string,
  baseVersion: number,
  files: Record<string, string | undefined>,
  options: Partial<Parameters<Artifacts["push"]>[0]> = {},
  actor: { agentId: string } = agent,
) {
  const entries = Object.entries(files);
  return artifacts.push({
    workspaceId,
    artifactId,
    baseVersion,
    publisher: actor,
    idempotencyKey: crypto.randomUUID(),
    files: await Promise.all(
      entries
        .filter(([, text]) => text !== undefined)
        .map(async ([path, text]) => ({ path, sha256: await upload(text!, actor) })),
    ),
    deletedPaths: entries.filter(([, text]) => text === undefined).map(([path]) => path),
    ...options,
  });
}

let made = 0;

/** An artifact whose version 1 holds `a.md` (the entry), `b.txt` and `c.txt`. */
async function artifact(title = "Plan") {
  const created = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `base-${(made += 1)}-${handle}`,
    title,
    entryPath: "a.md",
    author: other,
  });
  await push(created.id, 0, { "a.md": "a\n", "b.txt": "b\n", "c.txt": "c\n" }, {}, other);
  return created.id;
}

const filesAt = async (artifactId: string, version?: number) =>
  Object.fromEntries(
    await Promise.all(
      (await artifacts.read({ workspaceId, artifactId, reader, version })).files.map(
        async (file) => [
          file.path,
          new TextDecoder().decode((await blobs.read(workspaceId, file.sha256))!),
        ],
      ),
    ),
  );

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) =>
      cause as { code?: string; errorId?: string; details?: Record<string, string> },
  );
  expect(error).toMatchObject({ code: "CONFLICT", errorId: "artifact-base-moved" });
  return error!.details!;
}

test("files others changed that the Agent's save does not touch are kept", async () => {
  const id = await artifact();
  await push(id, 1, { "b.txt": "b by someone\n", "d.txt": "d by someone\n" }, {}, other);
  const saved = await push(id, 1, { "c.txt": "c by the Agent\n" });
  expect(saved).toMatchObject({
    status: "created",
    number: 3,
    merged: ["b.txt", "d.txt"],
  });
  expect(await filesAt(id)).toEqual({
    "a.md": "a\n",
    "b.txt": "b by someone\n",
    "c.txt": "c by the Agent\n",
    "d.txt": "d by someone\n",
  });
});

test("a file both sides changed refuses the whole save and names it", async () => {
  const id = await artifact();
  await push(id, 1, { "b.txt": "b by someone\n", "c.txt": "c by someone\n" }, {}, other);
  const details = await refusal(
    push(id, 1, { "b.txt": "b by the Agent\n", "c.txt": "c by the Agent\n", "e.txt": "e\n" }),
  );
  expect(details.files).toBe("b.txt\nc.txt");
  // Nothing of the save landed, not even the file nobody else touched.
  expect(await filesAt(id)).not.toHaveProperty("e.txt");
  expect(
    (await artifacts.read({ workspaceId, artifactId: id, reader })).artifact.currentVersion,
  ).toBe(2);
});

test("both sides making the same change to a file is no conflict", async () => {
  const id = await artifact();
  await push(id, 1, { "b.txt": "same\n" }, {}, other);
  const saved = await push(id, 1, { "b.txt": "same\n", "c.txt": "c by the Agent\n" });
  expect(saved).toMatchObject({ status: "created", merged: ["b.txt"] });
  expect(await filesAt(id)).toMatchObject({ "b.txt": "same\n", "c.txt": "c by the Agent\n" });
});

test("a file one side deleted and the other changed refuses the save", async () => {
  const id = await artifact();
  await push(id, 1, { "b.txt": undefined, "c.txt": "c by someone\n" }, {}, other);
  // The Agent changes what someone deleted, and deletes what someone changed.
  const details = await refusal(push(id, 1, { "b.txt": "b by the Agent\n", "c.txt": undefined }));
  expect(details.files).toBe("b.txt\nc.txt");
});

test("both sides deleting a file is no conflict", async () => {
  const id = await artifact();
  await push(id, 1, { "b.txt": undefined }, {}, other);
  const saved = await push(id, 1, { "b.txt": undefined, "c.txt": "c by the Agent\n" });
  expect(saved).toMatchObject({ status: "created" });
  expect(await filesAt(id)).toEqual({ "a.md": "a\n", "c.txt": "c by the Agent\n" });
});

test("a setting both sides changed to different values refuses the save and names it", async () => {
  const id = await artifact("Plan");
  await artifacts.push({
    workspaceId,
    artifactId: id,
    baseVersion: 1,
    publisher: other,
    idempotencyKey: crypto.randomUUID(),
    title: "Launch plan",
    description: "by someone",
  });
  const details = await refusal(push(id, 1, {}, { title: "Roadmap", description: "by the Agent" }));
  expect(details.settings).toBe("title\ndescription");
  // The same value on both sides, and a setting only the Agent changed, merge.
  const saved = await push(id, 1, {}, { title: "Launch plan", description: "by someone" });
  expect(saved).toMatchObject({ status: "nothing" });
  expect(await push(id, 1, { "c.txt": "c2\n" }, { title: "Launch plan" })).toMatchObject({
    status: "created",
    mergedSettings: ["title", "description"],
  });
});

test("a push never merges inside a file", async () => {
  const created = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `base-lines-${handle}`,
    entryPath: "document.md",
    author: other,
  });
  const lines = (first: string, last: string) => `${first}\n\nmiddle\n\n${last}\n`;
  await push(created.id, 0, { "document.md": lines("one", "three") }, {}, other);
  await push(created.id, 1, { "document.md": lines("one by someone", "three") }, {}, other);
  // The push's paragraph is another one, which a line merge would join.
  const details = await refusal(
    push(created.id, 1, { "document.md": lines("one", "three by the Agent") }),
  );
  expect(details.files).toBe("document.md");
});

test("an artifact made and pushed through the documents keeps what others pushed meanwhile", async () => {
  const sha256 = await upload("# Notes\n\nfirst\n\nsecond\n", other);
  const created = await documents.create(
    { workspaceId, actor: other },
    { title: "Notes", manifest: { files: [{ path: "document.md", sha256 }] } },
  );
  const save = async (baseVersion: number, input: { text?: string; title?: string }) =>
    documents.push(
      { workspaceId, actor: agent },
      {
        artifactId: created.id,
        baseVersion,
        idempotencyKey: crypto.randomUUID(),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.text !== undefined && {
          manifest: {
            files: [{ path: "document.md", sha256: await upload(input.text, agent) }],
          },
        }),
      },
    );
  // Someone retitles it; the push of the file over version 1 keeps the title.
  await documents.push(
    { workspaceId, actor: other },
    {
      artifactId: created.id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      title: "Notes 2",
    },
  );
  expect(await save(1, { text: "# Notes\n\nfirst\n\nsecond, edited\n" })).toMatchObject({
    status: "created",
    mergedSettings: ["title"],
  });
  // Another push of the same file over version 1 is refused, not merged.
  const details = await refusal(save(1, { text: "# Notes\n\nfirst, edited\n\nsecond\n" }));
  expect(details.files).toBe("document.md");
  // Settings of its own over the version it read still save.
  expect((await save(3, { title: "Notes 3" })).status).toBe("created");
});
