import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  Artifacts,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "#src/server/artifacts/artifacts.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { FRAME, fileRequest, openLink, openPage } from "./helpers/artifact-sandbox-open";

/**
 * Web pages on the sandbox origin over real artifacts (task #490): the link opens the version it
 * was made for even after a newer one is saved, and stops opening once its reader can no longer
 * read the artifact. Reads go through `ArtifactReads`, so the experiment and the read rule are
 * the same checks every artifact read makes.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const SANDBOX = "http://localhost:5199";
const APP = "http://127.0.0.1:5173";
const frame = (filesUrl: string, path = "index.html") =>
  new Request(`${filesUrl}${path}`, { headers: FRAME });
const asset = fileRequest;

const bytes = new Map<string, Uint8Array>();
const store: ArtifactBlobStore = {
  inspectMany: async (_workspaceId, sha256s) =>
    new Map(
      sha256s.flatMap((sha256): [string, ArtifactBlobInfo][] =>
        bytes.has(sha256) ? [[sha256, { kind: "text", sizeBytes: bytes.get(sha256)!.length }]] : [],
      ),
    ),
  use: async (_tx, _workspaceId, sha256s) => sha256s.filter((sha256) => !bytes.has(sha256)),
  read: async (_workspaceId, sha256) => bytes.get(sha256) ?? null,
  allowed: async (_workspaceId, _artifactId, _actor, sha256s) => new Set(sha256s),
};
/** Seconds are added to the sandbox's clock by the test that ages a link. */
let clockOffsetMs = 0;
let switchedOn = true;
const artifacts = new Artifacts(db, store, { enabled: async () => switchedOn });
const sandbox = new ArtifactSandbox({
  reads: artifacts.reads,
  readBlob: (workspaceId, sha256) => store.read(workspaceId, sha256),
  origin: SANDBOX,
  nonces: new MemoryTicketNonces(() => Date.now() + clockOffsetMs),
  secret: async () => "x".repeat(40),
  now: () => new Date(Date.now() + clockOffsetMs),
});

let workspaceId: string;
let userId: string;
let agentId: string;

beforeAll(async () => {
  userId = (
    await db.user.create({ data: { username: `sandbox-${handle}`, displayName: "Sandbox" } })
  ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `sandbox-${handle}`,
        name: "Sandbox",
        members: { create: { userId, role: "member" } },
      },
    })
  ).id;
  agentId = await newAgent(`sandbox-writer-${handle}`);
});

/** An Agent of the Workspace, the writer of a page. */
const newAgent = async (name: string) =>
  (
    await db.agent.create({
      data: { workspaceId, name, displayName: name, ownerId: userId, runtimeConfig: {} },
    })
  ).id;

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

function put(html: string | Uint8Array): string {
  const data = typeof html === "string" ? new TextEncoder().encode(html) : html;
  const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  bytes.set(sha256, data);
  return sha256;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A new web page of several files, version 1, entry `home.html`. */
async function multiPage(name: string, files?: Record<string, string | Uint8Array>) {
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `${name}-${handle}`,
    entryPath: "home.html",
    author: { agentId },
  });
  const set = files ?? {
    "home.html": '<!doctype html><link rel="stylesheet" href="css/site.css"><p>home</p>',
    "css/site.css": "p{color:red}",
    "app.js": "document.title='x'",
    "img/dot.png": PNG,
    "second.html": "<!doctype html><p>second</p>",
  };
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { agentId },
    idempotencyKey: crypto.randomUUID(),
    files: Object.entries(set).map(([path, content]) => ({ path, sha256: put(content) })),
  });
  return page;
}
const linkTo = (artifactId: string) =>
  sandbox.link({ workspaceId, userId, artifactId, embedderOrigin: APP });

async function save(artifactId: string, baseVersion: number, html: string) {
  return artifacts.push({
    workspaceId,
    artifactId,
    baseVersion,
    publisher: { agentId },
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "index.html", sha256: put(html) }],
  });
}

test("a member's next link refuses at once once they leave the Workspace", async () => {
  const author = await newAgent(`sb-author-${handle}`);
  const reader = (
    await db.user.create({ data: { username: `sb-reader-${handle}`, displayName: "R" } })
  ).id;
  await db.workspaceMembership.create({
    data: { workspaceId, userId: reader, role: "member" },
  });
  const channel = (
    await db.conversation.create({
      data: { workspaceId, channelName: `closed-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({
    data: { conversationId: channel, workspaceId, agentId: author },
  });
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: channel },
    name: `page-shared-${handle}`,
    entryPath: "index.html",
    author: { agentId: author },
  });
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { agentId: author },
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "index.html", sha256: put("<p>shared</p>") }],
  });
  const link = () =>
    sandbox.link({ workspaceId, userId: reader, artifactId: page.id, embedderOrigin: APP });
  await expect(link()).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.artifact.update({ where: { id: page.id }, data: { access: "workspace" } });
  await link();
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId, userId: reader } },
  });
  await expect(link()).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.conversation.delete({ where: { id: channel } });
  await db.user.delete({ where: { id: reader } });
});

test("a link opens its own version, and stops once its reader cannot read the page", async () => {
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `page-${handle}`,
    entryPath: "index.html",
    author: { agentId },
  });
  await save(page.id, 0, "<p>one</p>");
  const first = await sandbox.link({
    workspaceId,
    userId,
    artifactId: page.id,
    embedderOrigin: APP,
  });
  expect(first.version).toBe(1);

  await save(page.id, 1, "<p>two</p>");
  expect(await (await openPage(sandbox, first.url)).response.text()).toEndWith("<p>one</p>");
  const second = await sandbox.link({
    workspaceId,
    userId,
    artifactId: page.id,
    embedderOrigin: APP,
  });
  expect(second.version).toBe(2);
  const opened = await openPage(sandbox, second.url);
  expect(await opened.response.text()).toEndWith("<p>two</p>");
  expect(opened.response.headers.get("content-security-policy")).toEndWith(
    `frame-ancestors ${APP}`,
  );

  const third = await sandbox.link({
    workspaceId,
    userId,
    artifactId: page.id,
    embedderOrigin: APP,
  });
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  expect((await openLink(sandbox, third.url)).status).toBe(404);
  expect((await sandbox.serve(frame(opened.filesUrl))).status).toBe(404);
  await expect(
    sandbox.link({ workspaceId, userId, artifactId: page.id, embedderOrigin: APP }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.workspaceMembership.create({ data: { workspaceId, userId, role: "member" } });
});

test("a page of several files: the entry document, and every file served under the file token", async () => {
  const page = await multiPage("multi");
  const link = await linkTo(page.id);
  const { filesUrl, response: entry } = await openPage(sandbox, link.url);
  expect(entry.status).toBe(200);
  expect(await entry.text()).toContain("css/site.css");
  expect(entry.headers.get("content-security-policy")).toContain(
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${new URL(filesUrl).origin}/_coforge/runtime.js ${filesUrl}`,
  );
  expect((await sandbox.serve(frame(filesUrl, "second.html"))).status).toBe(200);

  const css = await sandbox.serve(asset(filesUrl, "css/site.css", "style"));
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(await css.text()).toBe("p{color:red}");
  const js = await sandbox.serve(asset(filesUrl, "app.js", "script"));
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const png = await sandbox.serve(asset(filesUrl, "img/dot.png", "image"));
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  expect(png.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");

  expect((await sandbox.serve(asset(filesUrl, "nope.css", "style"))).status).toBe(404);
  for (const path of ["css/site.css", "img/dot.png"])
    expect(
      (
        await sandbox.serve(
          new Request(`${filesUrl}${path}`, { headers: { "Sec-Fetch-Dest": "document" } }),
        )
      ).status,
    ).toBe(404);
  expect((await sandbox.serve(new Request(`${filesUrl}css/site.css`))).status).toBe(404);
});

test("a ticket reaches only its own artifact's version", async () => {
  const one = await multiPage("scope-one", {
    "home.html": "<p>one</p>",
    "only-one.css": "a{}",
    "same.css": "/* one */",
  });
  const two = await multiPage("scope-two", {
    "home.html": "<p>two</p>",
    "only-two.css": "b{}",
    "same.css": "/* two */",
  });
  const first = await openPage(sandbox, (await linkTo(one.id)).url);
  // Version 2 of `one` adds a file and changes another; the old link opens version 1 only.
  await artifacts.push({
    workspaceId,
    artifactId: one.id,
    baseVersion: 1,
    publisher: { agentId },
    idempotencyKey: crypto.randomUUID(),
    files: [
      { path: "added-later.css", sha256: put("c{}") },
      { path: "same.css", sha256: put("/* one, again */") },
    ],
  });
  const text = async (response: Response) => (response.status === 200 ? response.text() : null);
  expect(await text(await sandbox.serve(asset(first.filesUrl, "same.css", "style")))).toBe(
    "/* one */",
  );
  expect((await sandbox.serve(asset(first.filesUrl, "added-later.css", "style"))).status).toBe(404);
  // Another artifact's file is not there, nor is its same-named file this artifact's.
  expect((await sandbox.serve(asset(first.filesUrl, "only-two.css", "style"))).status).toBe(404);
  const latest = await openPage(sandbox, (await linkTo(one.id)).url);
  expect(await text(await sandbox.serve(asset(latest.filesUrl, "same.css", "style")))).toBe(
    "/* one, again */",
  );
  expect(
    await text(
      await sandbox.serve(
        asset((await openPage(sandbox, (await linkTo(two.id)).url)).filesUrl, "same.css", "style"),
      ),
    ),
  ).toBe("/* two */");
});

test("a ticket stops opening after two minutes, its files ten minutes after it was used, and a ticket opens once", async () => {
  const page = await multiPage("expiry");
  const link = await linkTo(page.id);
  const { filesUrl } = await openPage(sandbox, link.url);
  expect((await openLink(sandbox, link.url)).status).toBe(401);
  clockOffsetMs = 9 * 60 * 1000;
  try {
    expect((await sandbox.serve(asset(filesUrl, "app.js", "script"))).status).toBe(200);
    expect((await openLink(sandbox, (await linkTo(page.id)).url)).status).toBe(302);
    const stale = await linkTo(page.id);
    clockOffsetMs = 12 * 60 * 1000;
    expect((await openLink(sandbox, stale.url)).status).toBe(403);
    expect((await sandbox.serve(asset(filesUrl, "app.js", "script"))).status).toBe(403);
  } finally {
    clockOffsetMs = 0;
  }
});

test("a file stops opening when the page's home is hidden from the Workspace, except for its author's owner", async () => {
  const author = await newAgent(`sb-files-${handle}`);
  const reader = (
    await db.user.create({ data: { username: `sb-files-reader-${handle}`, displayName: "R" } })
  ).id;
  await db.workspaceMembership.create({ data: { workspaceId, userId: reader, role: "member" } });
  const channel = (
    await db.conversation.create({
      data: { workspaceId, channelName: `files-${handle}`, visibility: "public" },
    })
  ).id;
  await db.conversationMember.create({
    data: { conversationId: channel, workspaceId, agentId: author },
  });
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: channel },
    name: `files-home-${handle}`,
    entryPath: "home.html",
    author: { agentId: author },
  });
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { agentId: author },
    idempotencyKey: crypto.randomUUID(),
    files: [
      { path: "home.html", sha256: put("<p>home</p>") },
      { path: "a.css", sha256: put("a{}") },
    ],
  });
  const readerPage = await openPage(
    sandbox,
    (
      await sandbox.link({
        workspaceId,
        userId: reader,
        artifactId: page.id,
        embedderOrigin: APP,
      })
    ).url,
  );
  expect((await sandbox.serve(asset(readerPage.filesUrl, "a.css", "style"))).status).toBe(200);
  await db.conversation.update({
    where: { id: channel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  expect((await sandbox.serve(asset(readerPage.filesUrl, "a.css", "style"))).status).toBe(200);
  expect((await sandbox.serve(frame(readerPage.filesUrl, "home.html"))).status).toBe(404);
  await expect(
    sandbox.link({ workspaceId, userId: reader, artifactId: page.id, embedderOrigin: APP }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const ownerPage = await openPage(sandbox, (await linkTo(page.id)).url);
  expect((await sandbox.serve(frame(ownerPage.filesUrl, "home.html"))).status).toBe(200);
  await db.conversation.delete({ where: { id: channel } });
  await db.user.delete({ where: { id: reader } });
});

test("fileInVersion's real queries refuse a deleted artifact, another workspace, another version, a missing file, and a disabled experiment", async () => {
  const page = await multiPage("pin");
  const other = await db.workspace.create({
    data: {
      slug: `sandbox-other-${handle}`,
      name: "Other",
      members: { create: { userId, role: "member" } },
    },
  });
  const file = (over: Partial<Parameters<typeof artifacts.reads.fileInVersion>[0]>) =>
    artifacts.reads.fileInVersion({
      workspaceId,
      artifactId: page.id,
      version: 1,
      path: "app.js",
      ...over,
    });
  try {
    expect(await file({})).not.toBeNull();
    expect(await file({ workspaceId: other.id })).toBeNull();
    expect(await file({ version: 2 })).toBeNull();
    expect(await file({ path: "nope.js" })).toBeNull();
    await db.artifact.update({ where: { id: page.id }, data: { deletedAt: new Date() } });
    expect(await file({})).toBeNull();
    await db.artifact.update({ where: { id: page.id }, data: { deletedAt: null } });
    switchedOn = false;
    await expect(file({})).rejects.toMatchObject({ errorId: "artifacts-disabled" });
    switchedOn = true;
  } finally {
    switchedOn = true;
    await db.workspace.delete({ where: { id: other.id } }).catch(() => undefined);
  }
});
