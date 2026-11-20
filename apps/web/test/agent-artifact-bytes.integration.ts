import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { agentApiRoutes, ARTIFACT_UPLOAD_MAX_BYTES } from "@lrm/coforge-sdk/agent";
import { PrismaClient } from "#src/generated/prisma/client";
import { ARTIFACT_AGENT_UPLOAD_LIMIT_PER_MINUTE } from "#src/server/app-rate-limits/app-rate-limits-composition.server";
import { Artifacts, ARTIFACT_FILE_LIMIT } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import {
  ARTIFACT_UNREFERENCED_QUOTA_BYTES,
  handleAgentArtifactDownload,
  handleAgentArtifactUpload,
} from "#src/server/artifacts/agent-artifact-files.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const BASE = "http://local/api/agent/v1/artifacts";

let root: string;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let documents: ArtifactDocuments;
let workspaceId: string;
let alice: string;
let agentId: string;
let insiderId: string;
let secretId: string;
const homeTarget = `#ab-home-${handle}`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-artifact-bytes-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs);
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
  const homeId = (
    await db.conversation.create({
      data: { workspaceId, channelName: `ab-home-${handle}`, visibility: "public" },
    })
  ).id;
  await db.conversationMember.createMany({
    data: [
      { conversationId: homeId, workspaceId, agentId },
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
  for (const path of [sha.toUpperCase(), sha.slice(1), `${sha}0`, "not-hex"])
    expect(
      await put(path, { body: bytes, headers: { "content-length": String(bytes.length) } }),
    ).toMatchObject({ status: 400 });
  expect(await put(sha, { body: bytes })).toMatchObject({ status: 411 });
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
        throw new Error("the body must not be read");
      },
    },
    { highWaterMark: 0 },
  );
  expect(
    await put(sha, {
      body,
      headers: { "content-length": String(ARTIFACT_UPLOAD_MAX_BYTES + 1) },
    }),
  ).toMatchObject({ status: 413 });
  expect(pulled).toBe(false);
  const mismatch = await put(sha256(text("other bytes")), {
    body: bytes,
    headers: { "content-length": String(bytes.length) },
  });
  expect(mismatch.status).toBe(400);
  expect(JSON.parse(mismatch.text).error).toContain("artifact-blob-sha256");
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256: sha } })).toBe(0);
});

test("uploads use a dedicated per-Agent rate limit above the artifact file cap without reading the body, and downloads are not limited", async () => {
  expect(ARTIFACT_AGENT_UPLOAD_LIMIT_PER_MINUTE).toBeGreaterThan(ARTIFACT_FILE_LIMIT);
  const bytes = text("rate limited upload");
  const sha = sha256(bytes);
  let left = 1;
  const uploadLimit = {
    admit: async () =>
      left-- > 0 ? { allowed: true as const } : { allowed: false as const, retryAfterSeconds: 23 },
  };
  const first = await handleAgentArtifactUpload(
    new Request(`${BASE}/uploads/${sha}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body: bytes,
    }),
    sha,
    principal(),
    { ...services(), uploadLimit },
  );
  expect(first.status).toBe(204);

  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
        throw new Error("the body must not be read when rate limited");
      },
    },
    { highWaterMark: 0 },
  );
  const limited = await handleAgentArtifactUpload(
    new Request(`${BASE}/uploads/${sha}`, {
      method: "PUT",
      headers: { "content-length": String(bytes.length) },
      body,
    }),
    sha,
    principal(),
    { ...services(), uploadLimit },
  );
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("23");
  expect(limited.headers.get("cache-control")).toBe("no-store");
  const payload = (await limited.json()) as Record<string, any>;
  expect(payload).toMatchObject({
    code: "RATE_LIMITED",
    retryable: true,
    details: {
      operation: "upload",
      limit: ARTIFACT_AGENT_UPLOAD_LIMIT_PER_MINUTE,
      windowSeconds: 60,
      retryAfterSeconds: 23,
    },
  });
  expect(payload.error).toContain("artifact-rate-limited");
  expect(payload.error).toContain(`${ARTIFACT_AGENT_UPLOAD_LIMIT_PER_MINUTE} artifact uploads`);
  expect(pulled).toBe(false);

  const id = await made({ "ok.md": text("# ok\n") });
  const download = await handleAgentArtifactDownload(
    new Request(`http://local${agentApiRoutes.cloud.artifactFiles.download.path(id, "ok.md")}`),
    { artifact: id, path: "ok.md" },
    principal(),
    { ...services(), uploadLimit },
  );
  expect(download.status).toBe(200);
});

test("bytes no version uses yet are held up to 1 GiB; one more is refused, and held bytes always answer 204", async () => {
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
        row("used", 500 * 1024 * 1024, true),
      ],
    });
    const fits = new Uint8Array(room).fill(7);
    expect((await send(fits)).status).toBe(204);
    const over = new Uint8Array(1).fill(9);
    const refused = await send(over);
    expect(refused.status).toBe(413);
    expect(JSON.parse(refused.body)).toMatchObject({ code: "ARTIFACT_STORAGE_FULL" });
    expect(
      await db.artifactBlob.count({ where: { workspaceId: quotaWorkspace, sha256: sha256(over) } }),
    ).toBe(0);
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
    target: homeTarget,
    ...extra,
    files: Object.entries(files).map(([path, bytes]) => ({ path, sha256: sha256(bytes) })),
    ...(extra.entry ? {} : { entry: Object.keys(files)[0] }),
  });
  expect(created).toMatchObject({ status: 200 });
  return created.body.id as string;
}

test("a download gives a file's exact bytes with its type and length, and a version's own", async () => {
  const allByteValues = Uint8Array.from({ length: 256 }, (_, index) => index);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const spacedFilename = "weird name + (1) & 100.md";
  const id = await made({
    "README.md": text("# Bytes\n"),
    "css/site.css": text("p { color: red }\n"),
    "data.csv": text("a,b\n1,2\n"),
    "notes.txt": text("plain\n"),
    "image.png": png,
    "blob.bin": allByteValues,
    [spacedFilename]: text("# Odd\n"),
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
  await expectFile("blob.bin", allByteValues, "application/octet-stream");
  await expectFile(spacedFilename, text("# Odd\n"), "text/markdown; charset=utf-8");
  await expectFile("ünï.txt", text("unicode\n"), "text/plain; charset=utf-8");

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
  expect((await get(id, "a.md", "?version=9")).status).toBe(404);
  expect((await get(id, "a.md", "?version=0")).status).toBe(400);
  expect((await get(id, "a.md", "?version=x")).status).toBe(400);
  expect((await get(crypto.randomUUID(), "a.md")).status).toBe(404);
  expect((await get("not-an-id", "a.md")).status).toBe(404);
  for (const path of ["a\u0000b", "../a.md", "/a.md"])
    expect((await get(id, path)).status).toBe(404);

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
  expect((await get(secret.id, "hush.md")).status).toBe(404);
  await documents.moveToWorkspace(
    { workspaceId, actor: { agentId: insiderId } },
    { artifactId: secret.id },
  );
  const readable = await get(secret.id, "hush.md");
  expect(readable.status).toBe(200);
  expect(await readable.text()).toBe("hush\n");
});
