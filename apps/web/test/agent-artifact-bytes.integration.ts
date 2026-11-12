import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentApiRoutes, ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import {
  ARTIFACT_UNREFERENCED_QUOTA_BYTES,
  handleAgentArtifactDownload,
  handleAgentArtifactUpload,
} from "#src/server/artifacts/agent-artifact-files.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * An Agent's file bytes over HTTP: `PUT .../artifacts/uploads/:sha256` stores and grants them
 * before a push names them, and `GET .../artifacts/:artifact/files/:path` gives any file of a
 * version back, exactly, to whoever may read the artifact.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const BASE = "http://local/api/agent/v1/artifacts";

let root: string;
let enabled = true;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let documents: ArtifactDocuments;
let workspaceId: string;
let alice: string;
let agentId: string;
let insiderId: string;
let secretId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-artifact-bytes-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => enabled });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `ab-a-${handle}`, displayName: "Alice" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `ab-${handle}`,
        name: "Bytes",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `ab-bot-${handle}`,
        displayName: "Bot",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  insiderId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `ab-insider-${handle}`,
        displayName: "Insider",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  secretId = (
    await db.conversation.create({
      data: { workspaceId, channelName: `ab-secret-${handle}`, visibility: "private" },
    })
  ).id;
  await db.conversationMember.createMany({
    data: [
      { conversationId: secretId, workspaceId, userId: alice },
      { conversationId: secretId, workspaceId, agentId: insiderId },
    ],
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: alice } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const principal = () => ({ workspaceId, agentId });
const services = () => ({
  db,
  artifacts,
  documents,
  blobs,
  enabled: async () => enabled,
});
const sha256 = (bytes: Uint8Array<ArrayBuffer>) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);

async function put(
  path: string,
  init: { body?: BodyInit | null; headers?: Record<string, string> } = {},
) {
  const response = await handleAgentArtifactUpload(
    new Request(`${BASE}/uploads/${path}`, { method: "PUT", ...init }),
    path,
    principal(),
    services(),
  );
  return {
    status: response.status,
    text: await response.text(),
  };
}

const upload = (bytes: Uint8Array<ArrayBuffer>) =>
  put(sha256(bytes), { body: bytes, headers: { "content-length": String(bytes.length) } });

async function post(body: unknown) {
  const response = await handleAgentArtifactPost(
    new Request(BASE, { method: "POST", body: JSON.stringify(body) }),
    principal(),
    services(),
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function get(artifact: string, path: string, query = "") {
  // The path travels as one percent-encoded segment, as the SDK's route builds it.
  const url = `http://local${agentApiRoutes.cloud.artifactFiles.download.path(artifact, path)}${query}`;
  const segment = url.split("/files/")[1]!.split("?")[0]!;
  return handleAgentArtifactDownload(
    new Request(url),
    { artifact, path: decodeURIComponent(segment) },
    principal(),
    services(),
  );
}

test("an upload stores the bytes, is granted to the Agent, and a repeat answers the same 204", async () => {
  const bytes = text("hello, files\n");
  expect(await upload(bytes)).toEqual({ status: 204, text: "" });
  expect(await upload(bytes)).toEqual({ status: 204, text: "" });
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256: sha256(bytes) } })).toBe(1);
  expect(
    await db.artifactBlobGrant.count({
      where: { workspaceId, sha256: sha256(bytes), actorKey: `agent:${agentId}` },
    }),
  ).toBe(1);
  expect(Buffer.from((await blobs.read(workspaceId, sha256(bytes)))!).toString()).toBe(
    "hello, files\n",
  );
});

test("an upload is refused for a bad sha256, a missing or oversized length, and bytes that are not the hash", async () => {
  const bytes = text("some bytes");
  const sha = sha256(bytes);
  // The path's sha256 is 64 lowercase hex characters.
  for (const path of [sha.toUpperCase(), sha.slice(1), `${sha}0`, "not-hex"])
    expect(
      await put(path, { body: bytes, headers: { "content-length": String(bytes.length) } }),
    ).toMatchObject({ status: 400 });
  // No Content-Length: 411, before anything is read.
  expect(await put(sha, { body: bytes })).toMatchObject({ status: 411 });
  // Over 16 MiB: 413 without the body being read at all.
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
        throw new Error("the body must not be read");
      },
    },
    // Nothing is pulled until a reader asks.
    { highWaterMark: 0 },
  );
  expect(
    await put(sha, {
      body,
      headers: { "content-length": String(ARTIFACT_UPLOAD_MAX_BYTES + 1) },
    }),
  ).toMatchObject({ status: 413 });
  expect(pulled).toBe(false);
  // The body must hash to the path.
  const mismatch = await put(sha256(text("other bytes")), {
    body: bytes,
    headers: { "content-length": String(bytes.length) },
  });
  expect(mismatch.status).toBe(400);
  expect(JSON.parse(mismatch.text).error).toContain("artifact-blob-sha256");
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256: sha } })).toBe(0);
});

test("an upload takes a Workspace without the experiment as every artifact call does", async () => {
  enabled = false;
  try {
    const bytes = text("gated");
    const answer = await upload(bytes);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.text)).toMatchObject({ code: "ACCESS_DENIED" });
    expect(JSON.parse(answer.text).error).toContain("artifacts-disabled");
    expect(await db.artifactBlob.count({ where: { workspaceId, sha256: sha256(bytes) } })).toBe(0);
  } finally {
    enabled = true;
  }
});

test("bytes no version uses yet are held up to 1 GiB; one more is refused, and held bytes always answer 204", async () => {
  // Another Workspace's bytes do not count, nor do those a version names.
  const quotaWorkspace = (
    await db.workspace.create({
      data: {
        slug: `ab-quota-${handle}`,
        name: "Quota",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  const quotaAgent = (
    await db.agent.create({
      data: {
        workspaceId: quotaWorkspace,
        name: `ab-quota-bot-${handle}`,
        displayName: "Quota",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  const send = async (bytes: Uint8Array<ArrayBuffer>) => {
    const response = await handleAgentArtifactUpload(
      new Request(`${BASE}/uploads/${sha256(bytes)}`, {
        method: "PUT",
        headers: { "content-length": String(bytes.length) },
        body: bytes,
      }),
      sha256(bytes),
      { workspaceId: quotaWorkspace, agentId: quotaAgent },
      services(),
    );
    return { status: response.status, body: await response.text() };
  };
  try {
    const row = (name: string, sizeBytes: number, referenced: boolean) => ({
      workspaceId: quotaWorkspace,
      sha256: sha256(text(name)),
      sizeBytes,
      kind: "binary",
      objectKey: `workspaces/${quotaWorkspace}/artifacts/blobs/${name}`,
      referenced,
    });
    const room = 100;
    await db.artifactBlob.createMany({
      data: [
        row("unused-1", ARTIFACT_UNREFERENCED_QUOTA_BYTES - room, false),
        // A version's own bytes are not counted.
        row("used", 500 * 1024 * 1024, true),
      ],
    });
    // 100 bytes of room: 100 more fit, 101 do not.
    const fits = new Uint8Array(room).fill(7);
    expect((await send(fits)).status).toBe(204);
    const over = new Uint8Array(1).fill(9);
    const refused = await send(over);
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "ARTIFACT_STORAGE_FULL" });
    expect(
      await db.artifactBlob.count({ where: { workspaceId: quotaWorkspace, sha256: sha256(over) } }),
    ).toBe(0);
    // Bytes the Workspace holds already add nothing: uploading them again is a 204.
    expect((await send(fits)).status).toBe(204);
  } finally {
    await db.workspace.delete({ where: { id: quotaWorkspace } }).catch(() => undefined);
  }
});

async function made(
  files: Record<string, Uint8Array<ArrayBuffer>>,
  extra: Record<string, unknown> = {},
) {
  for (const bytes of Object.values(files)) await upload(bytes);
  const created = await post({
    operation: "push",
    idempotencyKey: crypto.randomUUID(),
    title: "Bytes",
    ...extra,
    files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    ...(extra.entry ? {} : { entry: Object.keys(files)[0] }),
  });
  expect(created.status).toBe(200);
  return created.body.id as string;
}

test("a download gives a file's exact bytes with its type and length, and a version's own", async () => {
  // All 256 byte values, so nothing is re-encoded on the way.
  const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const id = await made({
    "README.md": text("# Bytes\n"),
    "css/site.css": text("p { color: red }\n"),
    "data.csv": text("a,b\n1,2\n"),
    "notes.txt": text("plain\n"),
    "image.png": png,
    "blob.bin": binary,
    "weird name #1 100%.md": text("# Odd\n"),
    "ünï.txt": text("unicode\n"),
  });
  const expectFile = async (
    path: string,
    bytes: Uint8Array<ArrayBuffer>,
    type: string,
    version?: number,
  ) => {
    const response = await get(id, path, version ? `?version=${version}` : "");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  };
  await expectFile("README.md", text("# Bytes\n"), "text/markdown; charset=utf-8");
  await expectFile("css/site.css", text("p { color: red }\n"), "text/css; charset=utf-8");
  await expectFile("data.csv", text("a,b\n1,2\n"), "text/csv; charset=utf-8");
  await expectFile("notes.txt", text("plain\n"), "text/plain; charset=utf-8");
  await expectFile("image.png", png, "image/png");
  await expectFile("blob.bin", binary, "application/octet-stream");
  await expectFile("weird name #1 100%.md", text("# Odd\n"), "text/markdown; charset=utf-8");
  await expectFile("ünï.txt", text("unicode\n"), "text/plain; charset=utf-8");

  // A later version replaces a file; the first still reads as it was.
  const changed = text("# Bytes, edited\n");
  await upload(changed);
  expect(
    await post({
      operation: "push",
      artifact: id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "README.md", sha256: sha256(changed) }],
      delete: ["notes.txt"],
    }),
  ).toMatchObject({ body: { status: "created", number: 2 } });
  await expectFile("README.md", changed, "text/markdown; charset=utf-8");
  await expectFile("README.md", text("# Bytes\n"), "text/markdown; charset=utf-8", 1);
  await expectFile("notes.txt", text("plain\n"), "text/plain; charset=utf-8", 1);
});

test("a download of a missing file, version or artifact is not found, as a read is", async () => {
  const id = await made({ "a.md": text("# A\n") });
  const missingFile = await get(id, "nope.md");
  expect(missingFile.status).toBe(404);
  expect(((await missingFile.json()) as { error: string }).error).toContain(
    "artifact-file-not-found",
  );
  // The file exists in version 1 only when it was named there; a version that is not there is 404.
  expect((await get(id, "a.md", "?version=9")).status).toBe(404);
  expect((await get(id, "a.md", "?version=0")).status).toBe(400);
  expect((await get(id, "a.md", "?version=x")).status).toBe(400);
  expect((await get(crypto.randomUUID(), "a.md")).status).toBe(404);
  expect((await get("not-an-id", "a.md")).status).toBe(404);
  // A path no artifact can hold is answered as missing, never passed on to the database.
  for (const path of ["a\u0000b", "../a.md", "/a.md"])
    expect((await get(id, path)).status).toBe(404);

  // An artifact in a private channel the Agent cannot read answers as one that does not exist.
  const hush = await blobs.upload({
    workspaceId,
    bytes: text("hush\n"),
    actor: { agentId: insiderId },
  });
  const secret = await documents.create(
    { workspaceId, actor: { agentId: insiderId } },
    {
      conversationId: secretId,
      title: "Secret",
      manifest: { files: [{ path: "hush.md", sha256: hush.sha256 }] },
    },
  );
  const hidden = await get(secret.id, "hush.md");
  expect(hidden.status).toBe(404);
  const body = (await hidden.json()) as { code: string; error: string };
  expect(body.code).toBe("NOT_FOUND");
  expect(body.error).not.toContain("artifact-file-not-found");
  // Once widened to the Workspace, the Agent reads its files.
  await artifacts.changeAccess({
    workspaceId,
    artifactId: secret.id,
    actor: { userId: alice },
    access: "workspace",
  });
  expect(await (await get(secret.id, "hush.md")).text()).toBe("hush\n");
});

test("a download takes a Workspace without the experiment as every artifact call does", async () => {
  const id = await made({ "a.md": text("# Gated\n") });
  enabled = false;
  try {
    const response = await get(id, "a.md");
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toContain("artifacts-disabled");
  } finally {
    enabled = true;
  }
});
