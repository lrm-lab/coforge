import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactPageData } from "#src/server/artifacts/artifact-page-data.server";
import { PAGE_BATCH_MAX } from "#src/features/artifacts/artifact-page-limits";
import {
  PAGE_DATA_MAX_DOCUMENTS,
  PAGE_DOCUMENT_MAX_BYTES,
} from "#src/server/artifacts/artifact-page-data-rules.server";
import type { ArtifactSignalEvent } from "#src/server/artifacts/artifact-signals.server";
import { startPageFixture, type PageFixture } from "./helpers/artifact-page-fixture";

let fx: PageFixture;
let data: ArtifactPageData;
const published: { channel: string; event: ArtifactSignalEvent }[] = [];

beforeAll(async () => {
  fx = await startPageFixture("pd");
  data = new ArtifactPageData(fx.db, fx.artifacts.reads, {
    publish: async (channel, event) => void published.push({ channel, event }),
  });
});
afterAll(() => fx.stop());

const set = (id: string, body: unknown, collection = "notes") => ({
  op: "set" as const,
  collection,
  id,
  data: body,
});

test("a member sets, reads, merges and deletes a document; each write counts a version", async () => {
  const page = fx.as(fx.memberId, await fx.page("crud"));
  expect(await data.write({ ...page, writes: [set("a", { title: "one", n: 1 })] })).toEqual([
    { collection: "notes", id: "a", version: 1 },
  ]);
  expect((await data.get({ ...page, collection: "notes", id: "a" }))?.data).toEqual({
    title: "one",
    n: 1,
  });
  await data.write({
    ...page,
    writes: [{ op: "update", collection: "notes", id: "a", data: { n: 2, extra: true } }],
  });
  const merged = await data.get({ ...page, collection: "notes", id: "a" });
  expect(merged).toMatchObject({ version: 2, data: { title: "one", n: 2, extra: true } });
  expect(
    await data.write({ ...page, writes: [{ op: "delete", collection: "notes", id: "a" }] }),
  ).toEqual([{ collection: "notes", id: "a", deleted: true }]);
  expect(await data.get({ ...page, collection: "notes", id: "a" })).toBeNull();
  await expect(
    data.write({
      ...page,
      writes: [{ op: "update", collection: "notes", id: "a", data: { n: 3 } }],
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", errorId: "artifact-data-missing" });
});

test("a write with ifVersion refuses to overwrite a change it has not seen", async () => {
  const page = fx.as(fx.memberId, await fx.page("versions"));
  await data.write({ ...page, writes: [set("a", { n: 1 })] });
  await data.write({ ...page, writes: [set("a", { n: 2 })] });
  await expect(
    data.write({ ...page, writes: [{ ...set("a", { n: 3 }), ifVersion: 1 }] }),
  ).rejects.toMatchObject({ code: "CONFLICT", errorId: "artifact-data-version" });
  await data.write({ ...page, writes: [{ ...set("a", { n: 3 }), ifVersion: 2 }] });
  await data.write({ ...page, writes: [{ ...set("fresh", { n: 1 }), ifVersion: 0 }] });
  await expect(
    data.write({ ...page, writes: [{ ...set("fresh", { n: 2 }), ifVersion: 0 }] }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a batch is atomic: one refused write leaves the others unwritten", async () => {
  const page = fx.as(fx.memberId, await fx.page("batch"));
  await expect(
    data.write({
      ...page,
      writes: [set("a", { n: 1 }), set("b", { n: 2 }), { ...set("c", { n: 3 }), ifVersion: 9 }],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await data.query({ ...page, collection: "notes" })).documents).toEqual([]);
  const ok = await data.write({ ...page, writes: [set("a", { n: 1 }), set("b", { n: 2 })] });
  expect(ok).toHaveLength(2);
  await expect(
    data.write({
      ...page,
      writes: Array.from({ length: PAGE_BATCH_MAX + 1 }, (_, i) => set(`d${i}`, {})),
    }),
  ).rejects.toMatchObject({ errorId: "artifact-data-batch" });
  await expect(data.write({ ...page, writes: [] })).rejects.toMatchObject({
    errorId: "artifact-data-batch",
  });
});

test("names and documents are bounded", async () => {
  const page = fx.as(fx.memberId, await fx.page("limits"));
  for (const collection of ["", "has space", "a/b", "x".repeat(65), ".dot"])
    await expect(data.write({ ...page, writes: [set("a", {}, collection)] })).rejects.toMatchObject(
      { errorId: "artifact-data-collection" },
    );
  for (const id of ["", "a b", "x".repeat(129)])
    await expect(data.write({ ...page, writes: [set(id, {})] })).rejects.toMatchObject({
      errorId: "artifact-data-id",
    });
  for (const body of [[1], "text", 5, null, { when: new Date() }, { n: Number.NaN }])
    await expect(data.write({ ...page, writes: [set("a", body)] })).rejects.toMatchObject({
      errorId: "artifact-data-shape",
    });
  await expect(
    data.write({ ...page, writes: [set("a", { text: "x".repeat(PAGE_DOCUMENT_MAX_BYTES) })] }),
  ).rejects.toMatchObject({ errorId: "artifact-data-document-too-large" });
  await data.write({
    ...page,
    writes: [set("a", { text: "x".repeat(PAGE_DOCUMENT_MAX_BYTES - 20) })],
  });
});

test("an artifact's documents are capped in total, bytes and count", async () => {
  const page = fx.as(fx.memberId, await fx.page("caps"));
  const big = { text: "x".repeat(PAGE_DOCUMENT_MAX_BYTES - 64) };
  for (let at = 0; at < 80; at += PAGE_BATCH_MAX)
    await data.write({
      ...page,
      writes: Array.from({ length: Math.min(PAGE_BATCH_MAX, 80 - at) }, (_, i) =>
        set(`big${at + i}`, big),
      ),
    });
  await expect(data.write({ ...page, writes: [set("one-too-many", big)] })).rejects.toMatchObject({
    errorId: "artifact-data-full",
  });
  await data.write({ ...page, writes: [{ op: "delete", collection: "notes", id: "big0" }] });
  await data.write({ ...page, writes: [set("fits-now", big)] });

  const crowded = fx.as(fx.memberId, await fx.page("count"));
  await fx.db.artifactPageDocument.createMany({
    data: Array.from({ length: PAGE_DATA_MAX_DOCUMENTS }, (_, i) => ({
      artifactId: crowded.artifactId,
      collection: "rows",
      docId: `r${i}`,
      data: {},
      sizeBytes: 2,
      userId: fx.memberId,
    })),
  });
  await expect(
    data.write({ ...crowded, writes: [set("extra", {}, "rows")] }),
  ).rejects.toMatchObject({ errorId: "artifact-data-full" });
});

test("a query filters by equality, orders, pages and bounds its limit", async () => {
  const page = fx.as(fx.memberId, await fx.page("query"));
  await data.write({
    ...page,
    writes: [
      set("a", { kind: "x", rank: 3 }, "items"),
      set("b", { kind: "y", rank: 1 }, "items"),
      set("c", { kind: "x", rank: 2 }, "items"),
      set("d", { kind: "x" }, "items"),
      set("other", { kind: "x" }, "elsewhere"),
    ],
  });
  const ids = (result: { documents: { id: string }[] }) => result.documents.map((d) => d.id);
  expect(ids(await data.query({ ...page, collection: "items" }))).toEqual(["a", "b", "c", "d"]);
  expect(
    ids(await data.query({ ...page, collection: "items", query: { where: { kind: "x" } } })),
  ).toEqual(["a", "c", "d"]);
  expect(
    ids(
      await data.query({
        ...page,
        collection: "items",
        query: { orderBy: { field: "rank", direction: "desc" } },
      }),
    ),
  ).toEqual(["a", "c", "b", "d"]);
  const walked: string[] = [];
  let after: string | undefined;
  for (;;) {
    const result = await data.query({
      ...page,
      collection: "items",
      query: { orderBy: { field: "rank" }, limit: 2, ...(after ? { after } : {}) },
    });
    walked.push(...ids(result));
    if (!result.next) break;
    after = result.next;
  }
  expect(walked).toEqual(["d", "b", "c", "a"]);
  for (const query of [
    { limit: 201 },
    { limit: 0 },
    { where: { "a b": 1 } },
    { where: { a: { nested: 1 } } },
    { orderBy: { field: "x y" } },
    { unknown: 1 },
    { after: "garbage" },
  ])
    await expect(data.query({ ...page, collection: "items", query })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
});

test("levels: a member writes; an outsider and a stranger to the home read nothing", async () => {
  const wide = await fx.page("levels");
  const narrow = await fx.page("levels-narrow", "conversation");
  await data.write({ ...fx.as(fx.memberId, wide), writes: [set("a", { n: 1 })] });
  expect(
    await data.get({ ...fx.as(fx.adminId, wide), collection: "notes", id: "a" }),
  ).not.toBeNull();
  await expect(
    data.get({ ...fx.as(fx.outsiderId, wide), collection: "notes", id: "a" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    data.write({ ...fx.as(fx.memberId, narrow), writes: [set("a", {})] }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    data.query({ ...fx.as(fx.memberId, narrow), collection: "notes" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a deleted artifact answers not found, and its documents go with the row", async () => {
  const id = await fx.page("gone");
  const page = fx.as(fx.memberId, id);
  await data.write({ ...page, writes: [set("a", { n: 1 })] });
  await fx.db.artifact.update({ where: { id }, data: { deletedAt: new Date() } });
  await expect(data.get({ ...page, collection: "notes", id: "a" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await fx.db.artifact.delete({ where: { id } });
  expect(await fx.db.artifactPageDocument.count({ where: { artifactId: id } })).toBe(0);
});

test("a markdown artifact has no page and so no data", async () => {
  const id = await fx.page("markdown");
  await fx.db.artifact.update({ where: { id }, data: { entryPath: "README.md" } });
  await expect(
    data.write({ ...fx.as(fx.memberId, id), writes: [set("a", {})] }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a committed write is announced once per collection, with nothing of its content", async () => {
  const id = await fx.page("signals");
  published.length = 0;
  await data.write({
    ...fx.as(fx.memberId, id),
    writes: [set("a", { secret: "s" }), set("b", {}), set("c", {}, "other")],
  });
  expect(published.map((entry) => entry.event)).toEqual([
    {
      type: "artifact.data.changed.v1",
      workspaceId: fx.workspaceId,
      artifactId: id,
      collection: "notes",
    },
    {
      type: "artifact.data.changed.v1",
      workspaceId: fx.workspaceId,
      artifactId: id,
      collection: "other",
    },
  ]);
  published.length = 0;
  await expect(
    data.write({ ...fx.as(fx.memberId, id), writes: [{ ...set("a", {}), ifVersion: 99 }] }),
  ).rejects.toBeDefined();
  expect(published).toEqual([]);
});
