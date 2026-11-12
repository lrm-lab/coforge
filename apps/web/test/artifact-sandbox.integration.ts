import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  Artifacts,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "#src/server/artifacts/artifacts.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";

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
const SANDBOX = "http://127.0.0.1:5199";
const APP = "http://localhost:5173";
/** The wrapper frames the entry at `<link>/page/<path>`; this is the frame's request. */
const frame = (url: string, path = "index.html") =>
  new Request(`${url}/page/${path}`, {
    headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
  });
/** A page's own request for one of its files, from its opaque origin. */
const asset = (url: string, path: string, dest: string) =>
  new Request(`${url}/page/${path}`, {
    headers: { "Sec-Fetch-Dest": dest, "Sec-Fetch-Site": "cross-site" },
  });

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
  upload: async () => {
    throw new Error("bytes are put in the map directly");
  },
};
/** Seconds are added to the sandbox's clock by the test that ages a link. */
let clockOffsetMs = 0;
const artifacts = new Artifacts(db, store, { enabled: async () => true });
const sandbox = new ArtifactSandbox({
  reads: artifacts.reads,
  readBlob: (workspaceId, sha256) => store.read(workspaceId, sha256),
  origin: SANDBOX,
  secret: async () => "x".repeat(40),
  now: () => new Date(Date.now() + clockOffsetMs),
});

let workspaceId: string;
let userId: string;

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
});

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
    kind: "html",
    entryPath: "home.html",
    author: { userId },
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
    publisher: { userId },
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
    publisher: { userId },
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "index.html", sha256: put(html) }],
  });
}

test("a member's next link refuses at once once they leave the Workspace", async () => {
  // A member reads an artifact whose home they cannot read (task #20); leaving the Workspace
  // revokes the next link — the sandbox's own check runs on every call.
  const author = (
    await db.user.create({ data: { username: `sb-author-${handle}`, displayName: "A" } })
  ).id;
  const reader = (
    await db.user.create({ data: { username: `sb-reader-${handle}`, displayName: "R" } })
  ).id;
  await db.workspaceMembership.createMany({
    data: [
      { workspaceId, userId: author, role: "member" },
      { workspaceId, userId: reader, role: "member" },
    ],
  });
  const channel = (
    await db.conversation.create({
      data: { workspaceId, channelName: `closed-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({
    data: { conversationId: channel, workspaceId, userId: author },
  });
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: channel },
    name: `page-shared-${handle}`,
    kind: "html",
    entryPath: "index.html",
    author: { userId: author },
  });
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { userId: author },
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "index.html", sha256: put("<p>shared</p>") }],
  });
  const link = () =>
    sandbox.link({ workspaceId, userId: reader, artifactId: page.id, embedderOrigin: APP });
  await link();
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId, userId: reader } },
  });
  await expect(link()).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.conversation.delete({ where: { id: channel } });
  await db.user.deleteMany({ where: { id: { in: [author, reader] } } });
});

test("a link opens its own version, and stops once its reader cannot read the page", async () => {
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `page-${handle}`,
    kind: "html",
    entryPath: "index.html",
    author: { userId },
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
  // The old link still opens version 1; a new one opens version 2.
  expect(await (await sandbox.serve(frame(first.url))).text()).toEndWith("<p>one</p>");
  const second = await sandbox.link({
    workspaceId,
    userId,
    artifactId: page.id,
    embedderOrigin: APP,
  });
  expect(second.version).toBe(2);
  const served = await sandbox.serve(frame(second.url));
  expect(await served.text()).toEndWith("<p>two</p>");
  // The page under the wrapper and the app; the wrapper under the app the link was made for.
  expect(served.headers.get("content-security-policy")).toEndWith(
    `frame-ancestors ${SANDBOX} ${APP}`,
  );
  expect(
    (await sandbox.serve(new Request(second.url))).headers.get("content-security-policy"),
  ).toEndWith(`frame-ancestors ${APP}`);

  // Out of the Workspace: the links it already holds open nothing, and no new one is given.
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  expect((await sandbox.serve(frame(second.url))).status).toBe(404);
  await expect(
    sandbox.link({ workspaceId, userId, artifactId: page.id, embedderOrigin: APP }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await db.workspaceMembership.create({ data: { workspaceId, userId, role: "member" } });
});

test("a page of several files: the wrapper frames its entry, and every file is served under the link", async () => {
  const page = await multiPage("multi");
  const link = await linkTo(page.id);
  const wrapper = await (await sandbox.serve(new Request(link.url))).text();
  expect(wrapper).toContain(`src="${new URL(link.url).pathname}/page/home.html"`);

  const entry = await sandbox.serve(frame(link.url, "home.html"));
  expect(entry.status).toBe(200);
  expect(await entry.text()).toContain("css/site.css");
  expect(entry.headers.get("content-security-policy")).toContain(
    `script-src 'unsafe-inline' ${SANDBOX}/a/${link.url.slice(`${SANDBOX}/a/`.length)}/page/`,
  );
  expect((await sandbox.serve(frame(link.url, "second.html"))).status).toBe(200);

  const css = await sandbox.serve(asset(link.url, "css/site.css", "style"));
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  expect(await css.text()).toBe("p{color:red}");
  const js = await sandbox.serve(asset(link.url, "app.js", "script"));
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const png = await sandbox.serve(asset(link.url, "img/dot.png", "image"));
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  expect(png.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");

  // No such file; and never as a document of its own.
  expect((await sandbox.serve(asset(link.url, "nope.css", "style"))).status).toBe(404);
  const top = { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "none" };
  for (const path of ["home.html", "css/site.css", "img/dot.png"])
    expect(
      (await sandbox.serve(new Request(`${link.url}/page/${path}`, { headers: top }))).status,
    ).toBe(404);
  expect((await sandbox.serve(new Request(`${link.url}/page/css/site.css`))).status).toBe(404);
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
  const first = await linkTo(one.id);
  // Version 2 of `one` adds a file and changes another; the old link opens version 1 only.
  await artifacts.push({
    workspaceId,
    artifactId: one.id,
    baseVersion: 1,
    publisher: { userId },
    idempotencyKey: crypto.randomUUID(),
    files: [
      { path: "added-later.css", sha256: put("c{}") },
      { path: "same.css", sha256: put("/* one, again */") },
    ],
  });
  const text = async (response: Response) => (response.status === 200 ? response.text() : null);
  expect(await text(await sandbox.serve(asset(first.url, "same.css", "style")))).toBe("/* one */");
  expect((await sandbox.serve(asset(first.url, "added-later.css", "style"))).status).toBe(404);
  // Another artifact's file is not there, nor is its same-named file this artifact's.
  expect((await sandbox.serve(asset(first.url, "only-two.css", "style"))).status).toBe(404);
  const latest = await linkTo(one.id);
  expect(await text(await sandbox.serve(asset(latest.url, "same.css", "style")))).toBe(
    "/* one, again */",
  );
  expect(
    await text(await sandbox.serve(asset((await linkTo(two.id)).url, "same.css", "style"))),
  ).toBe("/* two */");
});

test("a ticket's files stop opening 30 minutes after the link, as access ends, and for no one else", async () => {
  const page = await multiPage("expiry");
  const link = await linkTo(page.id);
  clockOffsetMs = 29 * 60 * 1000;
  try {
    expect((await sandbox.serve(asset(link.url, "app.js", "script"))).status).toBe(200);
    // The wrapper is open for five minutes only.
    expect((await sandbox.serve(new Request(link.url))).status).toBe(403);
    clockOffsetMs = 30 * 60 * 1000 + 1000;
    expect((await sandbox.serve(asset(link.url, "app.js", "script"))).status).toBe(403);
  } finally {
    clockOffsetMs = 0;
  }
});

test("a file stops opening when the page's home is hidden from the Workspace", async () => {
  const author = (
    await db.user.create({ data: { username: `sb-files-${handle}`, displayName: "F" } })
  ).id;
  await db.workspaceMembership.create({ data: { workspaceId, userId: author, role: "member" } });
  const channel = (
    await db.conversation.create({
      data: { workspaceId, channelName: `files-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.create({
    data: { conversationId: channel, workspaceId, userId: author },
  });
  const page = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: channel },
    name: `files-home-${handle}`,
    kind: "html",
    entryPath: "home.html",
    author: { userId: author },
  });
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { userId: author },
    idempotencyKey: crypto.randomUUID(),
    files: [
      { path: "home.html", sha256: put("<p>home</p>") },
      { path: "a.css", sha256: put("a{}") },
    ],
  });
  const link = await linkTo(page.id);
  expect((await sandbox.serve(asset(link.url, "a.css", "style"))).status).toBe(200);
  // Reads are workspace-wide now (task #20); what ends a public page is its home going away.
  await db.conversation.update({
    where: { id: channel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  expect((await sandbox.serve(asset(link.url, "a.css", "style"))).status).toBe(404);
  expect((await sandbox.serve(frame(link.url, "home.html"))).status).toBe(404);
  await db.conversation.delete({ where: { id: channel } });
  await db.user.delete({ where: { id: author } });
});
