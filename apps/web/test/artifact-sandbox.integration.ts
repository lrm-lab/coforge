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
 * read the page's home. Reads go through `ArtifactReads`, so the experiment and the home's access
 * are the same checks every artifact read makes.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const SANDBOX = "http://127.0.0.1:5199";
const APP = "http://localhost:5173";
/** The wrapper frames the page at `<link>/page`; this is the frame's request. */
const frame = (url: string) =>
  new Request(`${url}/page`, {
    headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
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
const artifacts = new Artifacts(db, store, { enabled: async () => true });
const sandbox = new ArtifactSandbox({
  reads: artifacts.reads,
  readBlob: (workspaceId, sha256) => store.read(workspaceId, sha256),
  origin: SANDBOX,
  secret: async () => "x".repeat(40),
  now: () => new Date(),
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

function put(html: string): string {
  const sha256 = new Bun.CryptoHasher("sha256").update(html).digest("hex");
  bytes.set(sha256, new TextEncoder().encode(html));
  return sha256;
}

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
});
