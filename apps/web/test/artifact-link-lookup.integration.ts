import { afterAll, beforeAll, expect, test } from "bun:test";
import { linkPageLookup } from "#src/server/artifacts/artifact-public-page.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let lookup: ReturnType<typeof linkPageLookup>;

beforeAll(async () => {
  f = await commentsFixture("ll");
  lookup = linkPageLookup(f.db, async () => true);
});
afterAll(() => f.cleanup());

const share = (id: string) =>
  f.db.$executeRaw`UPDATE "artifacts" SET "access" = 'link' WHERE "id" = ${id}::uuid`;

test("a link-tier artifact is found and a conversation-tier one is not", async () => {
  const shared = await f.make("Shared page");
  const plain = await f.make("Plain page");
  await share(shared);
  expect(await lookup(shared)).toMatchObject({ shared: true, page: { artifactId: shared } });
  expect(await lookup(plain)).toEqual({ shared: false, page: null });
});

test("a deleted link-tier artifact is not found, the same as one that never existed", async () => {
  const id = await f.make("Soon gone");
  await share(id);
  await f.db.artifact.update({ where: { id }, data: { deletedAt: new Date() } });
  expect(await lookup(id)).toEqual({ shared: false, page: null });
  expect(await lookup(crypto.randomUUID())).toEqual({ shared: false, page: null });
});
