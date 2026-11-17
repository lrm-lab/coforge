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
import { FRAME, openPage } from "./helpers/artifact-sandbox-open";
import { legacyWorkspaceArtifact } from "./helpers/legacy-workspace-artifact";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const SANDBOX = "http://localhost:5199";
const APP = "http://127.0.0.1:5173";

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
let switchedOn = true;
const artifacts = new Artifacts(db, store, { enabled: async () => switchedOn });
const sandbox = new ArtifactSandbox({
  reads: artifacts.reads,
  readBlob: (workspaceId, sha256) => store.read(workspaceId, sha256),
  origin: SANDBOX,
  nonces: new MemoryTicketNonces(() => Date.now()),
  secret: async () => "x".repeat(40),
  now: () => new Date(Date.now()),
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

function put(content: string): string {
  const data = new TextEncoder().encode(content);
  const sha256 = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  bytes.set(sha256, data);
  return sha256;
}

async function documentWith(files: Record<string, string>, entryPath = "README.md") {
  const page = await legacyWorkspaceArtifact(db, {
    workspaceId,
    name: `preview-${crypto.randomUUID().slice(0, 8)}-${handle}`,
    entryPath,
    author: { agentId },
  });
  await artifacts.push({
    workspaceId,
    artifactId: page.id,
    baseVersion: 0,
    publisher: { agentId },
    idempotencyKey: crypto.randomUUID(),
    files: Object.entries(files).map(([path, content]) => ({ path, sha256: put(content) })),
  });
  return page;
}

const FILES = {
  "README.md": "# readme",
  "pages/two.html": "<!doctype html><p>two</p>",
  "docs/paper.pdf": "%PDF-1.4 paper",
  "notes.txt": "notes",
};

test("a non-entry page opens as a document under its own link, whatever the entry is", async () => {
  const page = await documentWith(FILES);
  const { url } = await sandbox.link({
    workspaceId,
    userId,
    artifactId: page.id,
    path: "pages/two.html",
    embedderOrigin: APP,
  });
  const { response } = await openPage(sandbox, url);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toContain("<p>two</p>");
});

test("a PDF opens as a frame document of its bytes and its read rule holds", async () => {
  const page = await documentWith(FILES);
  const input = {
    workspaceId,
    userId,
    artifactId: page.id,
    path: "docs/paper.pdf",
    embedderOrigin: APP,
  };
  const { url } = await sandbox.link(input);
  const { response, filesUrl } = await openPage(sandbox, url);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(await response.text()).toBe("%PDF-1.4 paper");
  switchedOn = false;
  try {
    const refused = await sandbox.serve(
      new Request(`${filesUrl}docs/paper.pdf`, { headers: FRAME }),
    );
    expect(refused.status).toBe(404);
    await expect(sandbox.link(input)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    switchedOn = true;
  }
});

test("a path the version lacks, or that is neither a page nor a PDF, refuses", async () => {
  const page = await documentWith(FILES);
  for (const path of ["pages/missing.html", "notes.txt", "README.md", "../README.md"])
    await expect(
      sandbox.link({ workspaceId, userId, artifactId: page.id, path, embedderOrigin: APP }),
      path,
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
