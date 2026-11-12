import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { handleAgentArtifactUpload } from "#src/server/artifacts/agent-artifact-files.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * An Agent's artifacts as files over `POST /api/agent/v1/artifacts`: a push (with an artifact, or
 * with none to make one) carries a manifest of uploaded bytes, a read lists the shown version's
 * files, and a list searches by title and pages. The entry file gives the artifact's type.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let artifacts: Artifacts;
let documents: ArtifactDocuments;
let blobs: StoredArtifactBlobs;
let workspaceId: string;
let alice: string;
let agentId: string;
let otherId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-artifact-manifest-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `mf-a-${handle}`, displayName: "Alice" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `mf-${handle}`,
        name: "Files",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `mf-bot-${handle}`,
        displayName: "Bot",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  otherId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `mf-other-${handle}`,
        displayName: "Other",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: alice } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const services = () => ({
  db,
  artifacts,
  documents,
  blobs,
  enabled: async () => true,
});

/** A push with no artifact makes one; this names its fields, with a fresh idempotency key. */
const create = (body: Record<string, unknown>) =>
  post({ operation: "push", idempotencyKey: crypto.randomUUID(), ...body });

async function post(body: unknown) {
  const response = await handleAgentArtifactPost(
    new Request("http://local/api/agent/v1/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { workspaceId, agentId },
    services(),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Uploads a file as the Agent does, and names it in a manifest. */
async function file(path: string, content: string | Uint8Array<ArrayBuffer>, by = agentId) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const response = await handleAgentArtifactUpload(
    new Request(`http://local/api/agent/v1/artifacts/uploads/${sha256(bytes)}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body: bytes,
    }),
    sha256(bytes),
    { workspaceId, agentId: by },
    services(),
  );
  expect(response.status).toBe(204);
  return { path, sha256: sha256(bytes) };
}

const key = () => crypto.randomUUID();
const paths = (read: Record<string, any>) =>
  read.files.map((entry: { path: string }) => entry.path).sort();
const sha = (content: string) => sha256(new TextEncoder().encode(content));

test("a push with no artifact names bytes it has not uploaded: answered missing, nothing made, then the same request lands", async () => {
  const request = {
    operation: "push",
    title: "Funnel report",
    idempotencyKey: key(),
    files: [
      { path: "report.md", sha256: sha("# Funnel\n") },
      { path: "data.csv", sha256: sha("day,signups\n1,10\n") },
    ],
    entry: "report.md",
  };
  const first = await post(request);
  expect(first).toMatchObject({ status: 200, body: { status: "missing" } });
  expect([...first.body.missing].sort()).toEqual(
    [sha("# Funnel\n"), sha("day,signups\n1,10\n")].sort(),
  );
  expect(await db.artifact.count({ where: { workspaceId, title: "Funnel report" } })).toBe(0);

  await file("report.md", "# Funnel\n");
  // One of two uploaded: only the other is still missing.
  expect((await post(request)).body).toEqual({
    status: "missing",
    missing: [sha("day,signups\n1,10\n")],
  });
  await file("data.csv", "day,signups\n1,10\n");
  const created = await post(request);
  expect(created).toMatchObject({
    status: 200,
    body: { currentVersion: 1, title: "Funnel report", entryPath: "report.md" },
  });
  expect(created.body).not.toHaveProperty("kind");
  expect(await db.artifact.count({ where: { workspaceId, title: "Funnel report" } })).toBe(1);

  const read = await post({ operation: "read", artifact: created.body.id });
  expect(read.body).toMatchObject({
    entryPath: "report.md",
    text: "# Funnel\n",
    files: [
      { path: "data.csv", sha256: sha("day,signups\n1,10\n"), sizeBytes: 17, kind: "text" },
      { path: "report.md", sha256: sha("# Funnel\n"), sizeBytes: 9, kind: "text" },
    ],
    artifact: { entryPath: "report.md" },
  });
  expect(read.body.artifact).not.toHaveProperty("kind");
  // The same push again replays the one artifact.
  expect((await post(request)).body.id).toBe(created.body.id);
});

test("a push with no artifact takes its entry from its files, and its entry defaults", async () => {
  const notes = await file("notes.md", "# Notes\n");
  // The only file is the entry.
  const only = await create({ title: "Only notes", files: [notes] });
  expect(only.body).toMatchObject({ currentVersion: 1, entryPath: "notes.md" });
  expect((await post({ operation: "read", artifact: only.body.id })).body.entryPath).toBe(
    "notes.md",
  );
  // An index.html among several files is the entry; a web page needs no description.
  const page = await file("index.html", "<!doctype html><p>hi</p>");
  const html = await create({ title: "A page", files: [page] });
  expect(html.body).toMatchObject({ currentVersion: 1, entryPath: "index.html", preview: "" });
  // Several files open at the one named.
  const more = await file("more.md", "# More\n");
  const several = await create({ title: "Several", files: [notes, more], entry: "more.md" });
  expect(several.body).toMatchObject({ currentVersion: 1 });
  expect((await post({ operation: "read", artifact: several.body.id })).body.entryPath).toBe(
    "more.md",
  );
});

test("a push with no artifact that cannot name an entry, or whose entry is no .md or .html, is refused", async () => {
  const notes = await file("notes.md", "# Notes\n");
  const more = await file("more.md", "# More\n");
  const csv = await file("data.csv", "a,b\n");
  const refused = async (body: Record<string, unknown>, errorId: string) => {
    const answer = await create({ title: "Refused", ...body });
    expect(answer).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
    expect(answer.body.error).toContain(errorId);
    return answer;
  };
  // Two files and none is index.html: the entry must be named.
  await refused({ files: [notes, more] }, "artifact-entry-missing");
  await refused({ files: [notes], entry: "other.md" }, "artifact-entry-missing");
  await refused({ files: [csv] }, "artifact-entry-type");
  await refused({ files: [notes, csv], entry: "data.csv" }, "artifact-entry-type");
  await refused({ files: [{ path: "../notes.md", sha256: notes.sha256 }] }, "artifact-file-path");
  // A new artifact has no files to delete or base to push over, and no kind is stated: the
  // request itself is outside the contract.
  await refused({ files: [notes], delete: ["old.md"] }, "artifact-request");
  await refused({ files: [notes], baseVersion: 0 }, "artifact-request");
  await refused({ files: [notes], kind: "html" }, "artifact-request");
  await refused({ files: [] }, "artifact-request");
  expect(await db.artifact.count({ where: { workspaceId, title: "Refused" } })).toBe(0);
});

test("a web page may be several files, with any .html file as its entry", async () => {
  const page = await file("index.html", "<!doctype html><p>one</p>");
  const style = await file("css/site.css", "p { color: red }\n");
  const home = await file("home.html", "<!doctype html><p>home</p>");
  const make = (body: Record<string, unknown>) =>
    create({ title: "Pages", description: "A page", ...body });
  const entryOf = async (id: string) =>
    (await post({ operation: "read", artifact: id })).body.entryPath;
  const made = await make({ files: [page, style] });
  expect(made.body).toMatchObject({ currentVersion: 1, entryPath: "index.html" });
  expect(await entryOf(made.body.id)).toBe("index.html");
  expect(await entryOf((await make({ files: [home, style], entry: "home.html" })).body.id)).toBe(
    "home.html",
  );
  for (const body of [{ files: [home, style] }, { files: [page, style], entry: "css/site.css" }])
    expect(await make(body)).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });

  const artifact = made.body.id as string;
  const push = (baseVersion: number, body: Record<string, unknown>) =>
    post({ operation: "push", artifact, baseVersion, idempotencyKey: key(), ...body });
  const saved = (number: number) => ({ status: 200, body: { status: "created", number } });
  expect(await push(1, { files: [home] })).toMatchObject(saved(2));
  expect(await push(2, { entry: "home.html" })).toMatchObject(saved(3));
  expect(await push(3, { delete: ["css/site.css"] })).toMatchObject(saved(4));
  const next = await file("index.html", "<!doctype html><p>two</p>");
  expect(await push(4, { files: [next] })).toMatchObject(saved(5));
  const read = (await post({ operation: "read", artifact })).body;
  expect(read.files.map((f: { path: string }) => f.path)).toEqual(["home.html", "index.html"]);
  expect(read.entryPath).toBe("home.html");
  expect(await push(5, { delete: ["home.html"] })).toMatchObject({ status: 400 });
  expect(await push(5, { files: [style], entry: "css/site.css" })).toMatchObject({ status: 400 });
});

test("a push of files adds, replaces and deletes by path, and keeps what it does not name", async () => {
  const created = await create({
    title: "Handbook",
    files: [await file("README.md", "# Handbook\n"), await file("a.txt", "a\n")],
    entry: "README.md",
  });
  const artifact = created.body.id as string;
  const push = (baseVersion: number, body: Record<string, unknown>) =>
    post({ operation: "push", artifact, baseVersion, idempotencyKey: key(), ...body });
  const b = await file("b.txt", "b\n");
  const readme = await file("README.md", "# Handbook\n\nmore\n");
  expect(
    await push(1, { files: [b, readme], delete: ["a.txt"], note: "restructured" }),
  ).toMatchObject({ status: 200, body: { status: "created", number: 2 } });
  const read = await post({ operation: "read", artifact });
  expect(paths(read.body)).toEqual(["README.md", "b.txt"]);
  expect(read.body.text).toBe("# Handbook\n\nmore\n");
  // An older version reads as it was, entry and files.
  const first = await post({ operation: "read", artifact, version: 1 });
  expect(first.body).toMatchObject({ entryPath: "README.md" });
  expect(paths(first.body)).toEqual(["README.md", "a.txt"]);

  // The entry moves with the files, and must stay a .md file.
  const guide = await file("GUIDE.md", "# Guide\n");
  expect(await push(2, { files: [guide], delete: ["README.md"], entry: "GUIDE.md" })).toMatchObject(
    { body: { status: "created", number: 3 } },
  );
  expect((await post({ operation: "read", artifact })).body).toMatchObject({
    entryPath: "GUIDE.md",
    text: "# Guide\n",
  });
  const answer = await push(3, { entry: "b.txt" });
  expect(answer).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  expect(answer.body.error).toContain("artifact-entry-type");
});

test("a push naming bytes not uploaded is answered missing, and lands when sent again", async () => {
  const created = await create({ title: "Retry files", files: [await file("a.md", "# A\n")] });
  const request = {
    operation: "push",
    artifact: created.body.id,
    baseVersion: 1,
    idempotencyKey: key(),
    files: [{ path: "later.txt", sha256: sha("later bytes\n") }],
  };
  expect(await post(request)).toMatchObject({
    status: 200,
    body: { status: "missing", missing: [sha("later bytes\n")] },
  });
  await file("later.txt", "later bytes\n");
  expect(await post(request)).toMatchObject({ body: { status: "created", number: 2 } });
  // Bytes another Agent uploaded are not this Agent's to name: missing until it uploads them.
  await file("theirs.txt", "theirs\n", otherId);
  expect(
    await post({
      ...request,
      idempotencyKey: key(),
      files: [{ path: "x.txt", sha256: sha("theirs\n") }],
    }),
  ).toMatchObject({ body: { status: "missing", missing: [sha("theirs\n")] } });
});

test("an Agent's file push over an older version keeps what others changed in other files", async () => {
  const created = await create({
    title: "Shared files",
    files: [await file("a.md", "# A\n"), await file("b.txt", "b\n"), await file("c.txt", "c\n")],
    entry: "a.md",
  });
  const artifact = created.body.id as string;
  await documents.push(
    { workspaceId, actor: { agentId: otherId } },
    {
      artifactId: artifact,
      baseVersion: 1,
      idempotencyKey: key(),
      manifest: { files: [await file("a.md", "# A, edited by another Agent\n", otherId)] },
    },
  );
  const c = await file("c.txt", "c by the Agent\n");
  const saved = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: [c],
  });
  expect(saved.body).toMatchObject({ status: "created", number: 3, merged: ["a.md"] });
  const clash = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: [await file("a.md", "# A, by the Agent\n")],
  });
  expect(clash).toMatchObject({
    status: 409,
    body: { code: "CONFLICT", details: { files: "a.md" } },
  });
  expect(clash.body.error).toContain("artifact-base-moved");
});

test("list searches titles by every word, pages newest first, and ends without a cursor", async () => {
  const titles = ["Alpha one", "Alpha two", "Beta alpha three", "Gamma", "100% sure", "a_b c"];
  const made: Record<string, string> = {};
  for (const title of titles) {
    made[title] = (
      await create({ title: `${title} ${handle}`, files: [await file("t.md", `# ${title}\n`)] })
    ).body.id;
    // Distinct change times, oldest first, so the order below is the order of creation.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ids = (body: Record<string, any>) => body.artifacts.map((row: { id: string }) => row.id);
  const mine = (id: string) => Object.values(made).includes(id);

  // Every word, in any case, anywhere in the title.
  const alpha = await post({ operation: "list", query: `ALPHA ${handle}`, limit: 50 });
  expect(alpha.status).toBe(200);
  expect(ids(alpha.body).filter(mine)).toEqual([
    made["Beta alpha three"],
    made["Alpha two"],
    made["Alpha one"],
  ]);
  expect(alpha.body.nextCursor).toBeUndefined();
  const both = await post({ operation: "list", query: `beta   alpha ${handle}`, limit: 50 });
  expect(ids(both.body)).toEqual([made["Beta alpha three"]]);
  // LIKE wildcards are plain characters: `%` and `_` match themselves only.
  expect(ids((await post({ operation: "list", query: `% ${handle}`, limit: 50 })).body)).toEqual([
    made["100% sure"],
  ]);
  expect(ids((await post({ operation: "list", query: `a_b ${handle}`, limit: 50 })).body)).toEqual([
    made["a_b c"],
  ]);
  expect(ids((await post({ operation: "list", query: `_ ${handle}`, limit: 50 })).body)).toEqual([
    made["a_b c"],
  ]);

  // Pages of two, newest-changed first, by the cursor each answers.
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await post({
      operation: "list",
      query: handle,
      limit: 2,
      ...(cursor ? { after: cursor } : {}),
    });
    expect(page.status).toBe(200);
    expect(page.body.artifacts.length).toBeLessThanOrEqual(2);
    seen.push(...ids(page.body));
    cursor = page.body.nextCursor;
    pages += 1;
  } while (cursor);
  expect(pages).toBe(3);
  expect(seen).toEqual(titles.map((title) => made[title]!).reverse());

  // Changing an artifact moves it to the front; the page after a cursor does not repeat it.
  await post({
    operation: "push",
    artifact: made["Alpha one"],
    baseVersion: 1,
    idempotencyKey: key(),
    files: [await file("t.md", "now it has other text\n")],
  });
  expect(ids((await post({ operation: "list", query: handle, limit: 1 })).body)).toEqual([
    made["Alpha one"],
  ]);
});

test("a list takes a default page of twenty, at most fifty, and a plain request lists as before", async () => {
  const none = await post({ operation: "list" });
  expect(Array.isArray(none.body)).toBe(true);
  const paged = await post({ operation: "list", query: "" });
  expect(Array.isArray(paged.body.artifacts)).toBe(true);
  expect(paged.body.artifacts.length).toBeLessThanOrEqual(20);
  for (const limit of [51, 0])
    expect(await post({ operation: "list", limit })).toMatchObject({
      status: 400,
      body: { code: "INVALID_INPUT", error: expect.stringContaining("limit is not accepted") },
    });
  expect(await post({ operation: "list", limit: 1, after: "not-a-cursor" })).toMatchObject({
    status: 400,
    body: { code: "INVALID_INPUT", error: expect.stringContaining("artifact-list-cursor") },
  });
});

test("a list page keeps a home's access rules", async () => {
  const secret = (
    await db.conversation.create({
      data: { workspaceId, channelName: `mf-secret-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({
    data: { conversationId: secret, workspaceId, userId: alice },
  });
  expect(await post({ operation: "list", target: `#mf-secret-${handle}`, limit: 5 })).toMatchObject(
    { status: 404, body: { code: "NOT_FOUND" } },
  );
});
