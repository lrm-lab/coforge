import { afterAll, beforeAll, expect, test } from "bun:test";
import { ARTIFACT_BLOB_GRACE_MS } from "#src/server/artifacts/artifact-blobs.server";
import { PAGE_ASSET_MAX_BYTES } from "#src/features/artifacts/artifact-page-limits";
import {
  ArtifactPageAssets,
  PAGE_ASSET_MAX_COUNT,
} from "#src/server/artifacts/artifact-page-assets.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { MemoryTicketNonces } from "#src/server/artifacts/artifact-sandbox-nonces.server";
import { FRAME, openPage } from "./helpers/artifact-sandbox-open";
import { startPageFixture, type PageFixture } from "./helpers/artifact-page-fixture";

let fx: PageFixture;
let assets: ArtifactPageAssets;
let sandbox: ArtifactSandbox;
const SANDBOX = "http://localhost:5199";
const APP = "http://127.0.0.1:5173";

beforeAll(async () => {
  fx = await startPageFixture("pa");
  assets = new ArtifactPageAssets(fx.db, fx.artifacts.reads, fx.blobs);
  sandbox = new ArtifactSandbox({
    reads: fx.artifacts.reads,
    pageAssets: assets,
    readBlob: (workspaceId, sha256) => fx.blobs.read(workspaceId, sha256),
    origin: SANDBOX,
    nonces: new MemoryTicketNonces(),
    secret: async () => "x".repeat(40),
    now: () => new Date(),
  });
});
afterAll(() => fx.stop());

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const text = (value: string) => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
const upload = (page: ReturnType<PageFixture["as"]>, name: string, bytes: Uint8Array) =>
  assets.upload({ ...page, name, bytes: bytes as Uint8Array<ArrayBuffer> });

test("a member adds, lists and replaces a file; only an admin deletes", async () => {
  const page = fx.as(fx.memberId, await fx.page("crud"));
  expect(await upload(page, "dot.png", PNG)).toEqual({
    name: "dot.png",
    sizeBytes: PNG.length,
    contentType: "image/png",
  });
  await upload(page, "dot.png", new Uint8Array([...PNG, 9]));
  expect(await assets.list(page)).toEqual([
    { name: "dot.png", sizeBytes: PNG.length + 1, contentType: "image/png" },
  ]);
  await expect(assets.delete({ ...page, name: "dot.png" })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  const admin = fx.as(fx.adminId, page.artifactId);
  expect(await assets.delete({ ...admin, name: "dot.png" })).toEqual({ deleted: true });
  expect(await assets.delete({ ...admin, name: "dot.png" })).toEqual({ deleted: false });
  expect(await assets.list(page)).toEqual([]);
});

test("the author Agent's owner deletes too, and an outsider sees nothing", async () => {
  const id = await fx.page("owner");
  await upload(fx.as(fx.memberId, id), "a.txt", text("hello"));
  expect(await assets.delete({ ...fx.as(fx.ownerId, id), name: "a.txt" })).toEqual({
    deleted: true,
  });
  await expect(assets.list(fx.as(fx.outsiderId, id))).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(upload(fx.as(fx.outsiderId, id), "a.txt", text("x"))).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("the media type comes from the bytes: media and text pass, markup and scripts do not", async () => {
  const page = fx.as(fx.memberId, await fx.page("sniff"));
  const typeOf = async (name: string, bytes: Uint8Array) =>
    (await upload(page, name, bytes)).contentType;
  expect(await typeOf("data.json", text('{"a":1}'))).toBe("application/json");
  expect(await typeOf("rows.csv", text("a,b\n1,2"))).toBe("text/csv; charset=utf-8");
  expect(await typeOf("notes.txt", text("plain"))).toBe("text/plain; charset=utf-8");
  expect(await typeOf("page.txt", text("<script>alert(1)</script>"))).toBe(
    "text/plain; charset=utf-8",
  );
  expect(await typeOf("a.pdf", text("%PDF-1.7 body"))).toBe("application/pdf");
  expect(await typeOf("lies.png", text("%PDF-1.7 body"))).toBe("application/pdf");
  await expect(typeOf("bad.json", text("{nope"))).rejects.toMatchObject({
    errorId: "artifact-asset-type",
  });
  await expect(typeOf("blob.bin", new Uint8Array([0, 1, 2, 3]))).rejects.toMatchObject({
    errorId: "artifact-asset-type",
  });
  await expect(typeOf("empty.txt", new Uint8Array())).rejects.toMatchObject({
    errorId: "artifact-asset-empty",
  });
});

test("names are flat and short", async () => {
  const page = fx.as(fx.memberId, await fx.page("names"));
  for (const name of ["", "a/b.png", "../x.png", ".hidden", "sp ace.png", "x".repeat(101)])
    await expect(upload(page, name, PNG)).rejects.toMatchObject({ errorId: "artifact-asset-name" });
});

test("a file is at most 10 MiB and a page keeps at most 200", async () => {
  const page = fx.as(fx.memberId, await fx.page("limits"));
  await expect(
    upload(page, "big.txt", new Uint8Array(PAGE_ASSET_MAX_BYTES + 1).fill(97)),
  ).rejects.toMatchObject({ errorId: "artifact-asset-too-large" });
  await fx.db.artifactPageAsset.createMany({
    data: Array.from({ length: PAGE_ASSET_MAX_COUNT }, (_, i) => ({
      artifactId: page.artifactId,
      name: `f${i}.txt`,
      sha256: "0".repeat(64),
      sizeBytes: 1,
      contentType: "text/plain",
    })),
  });
  await expect(upload(page, "one-more.txt", text("x"))).rejects.toMatchObject({
    errorId: "artifact-asset-full",
  });
  expect((await upload(page, "f0.txt", text("replaced"))).sizeBytes).toBe(8);
});

test("an asset's bytes outlive the blob sweep, and go with the artifact row", async () => {
  const id = await fx.page("sweep");
  const page = fx.as(fx.memberId, id);
  await upload(page, "keep.txt", text("keep me"));
  const later = new Date(Date.now() + 2 * ARTIFACT_BLOB_GRACE_MS);
  await fx.blobs.removeUnreferenced(later);
  const row = await assets.lookupByFileToken(id, "keep.txt");
  expect(new TextDecoder().decode((await fx.blobs.read(fx.workspaceId, row!.sha256))!)).toBe(
    "keep me",
  );
  await fx.db.artifact.delete({ where: { id } });
  expect(await fx.db.artifactPageAsset.count({ where: { artifactId: id } })).toBe(0);
});

test("the page's own origin serves an asset to its subresources, under its file token only", async () => {
  const id = await fx.page("serve");
  const other = await fx.page("serve-other");
  await upload(fx.as(fx.memberId, id), "dot.png", PNG);
  await upload(fx.as(fx.memberId, id), "data.json", text('{"a":1}'));
  const { url } = await sandbox.link({
    workspaceId: fx.workspaceId,
    userId: fx.memberId,
    artifactId: id,
    embedderOrigin: APP,
  });
  const { filesUrl, response } = await openPage(sandbox, url);
  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy")!;
  const assetsUrl = filesUrl.replace("/_f/", "/_a/");
  const directiveOf = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));
  for (const directive of ["img-src", "media-src", "connect-src"])
    expect(directiveOf(directive)).toContain(assetsUrl);
  for (const directive of ["script-src", "style-src", "font-src"])
    expect(directiveOf(directive)).not.toContain("/_a/");
  const get = (path: string, dest = "image", base = assetsUrl) =>
    sandbox.serve(new Request(`${base}${path}`, { headers: { "Sec-Fetch-Dest": dest } }));
  const png = await get("dot.png");
  expect(png.status).toBe(200);
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(png.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG);
  expect((await get("data.json", "empty")).headers.get("content-type")).toBe("application/json");
  expect((await get("dot.png", "iframe")).status).toBe(404);
  expect((await get("dot.png", "document")).status).toBe(404);
  expect((await get("missing.png")).status).toBe(404);
  expect((await get("..%2Fx.png")).status).toBe(404);
  const otherLink = await sandbox.link({
    workspaceId: fx.workspaceId,
    userId: fx.memberId,
    artifactId: other,
    embedderOrigin: APP,
  });
  const foreign = (await openPage(sandbox, otherLink.url)).filesUrl.replace("/_f/", "/_a/");
  expect((await get("dot.png", "image", foreign)).status).toBe(404);
  const crossOrigin = assetsUrl.replace(`a-${id}`, `a-${other}`);
  expect((await get("dot.png", "image", crossOrigin)).status).toBe(404);
  expect(
    await sandbox.serve(new Request(`${assetsUrl}dot.png`, { headers: FRAME })),
  ).toHaveProperty("status", 404);
});

test("the link says what the viewer may do to the page", async () => {
  const id = await fx.page("level");
  const level = async (userId: string) =>
    (
      await sandbox.link({
        workspaceId: fx.workspaceId,
        userId,
        artifactId: id,
        embedderOrigin: APP,
      })
    ).level;
  expect(await level(fx.memberId)).toBe("interact");
  expect(await level(fx.adminId)).toBe("admin");
  expect(await level(fx.ownerId)).toBe("owner");
});
