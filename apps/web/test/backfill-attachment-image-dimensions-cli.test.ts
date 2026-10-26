import { expect, test } from "bun:test";

test("the maintenance command requires an explicit frozen range and max-items guard", async () => {
  const source = await Bun.file(
    new URL("../scripts/backfill-attachment-image-dimensions.ts", import.meta.url),
  ).text();
  expect(source).toContain("--dry-run");
  expect(source).toContain("--cutoff");
  expect(source).toContain("--max-items");
  expect(source).toContain("--batch-delay-ms");
  expect(source).toContain("--after-created-at");
  expect(source).toContain("--after-id");
});
