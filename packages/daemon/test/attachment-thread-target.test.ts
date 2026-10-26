import { expect, test } from "bun:test";
import { canonicalThreadTarget } from "#src/daemon-runtime/thread-target";

test("an attachment reply short id resolves only by reading that attachment's parent", async () => {
  const parent = "attachment:11111111-1111-4111-8111-111111111111";
  const root = "22222222-2222-4222-8222-222222222222";
  const reads: string[][] = [];
  const read = async (target: string, anchor: string) => {
    reads.push([target, anchor]);
    return { accepted: true, messages: [{ id: root, target: parent }] };
  };
  expect(await canonicalThreadTarget(parent, read)).toBe(parent);
  expect(reads).toEqual([]);
  expect(await canonicalThreadTarget(`${parent}:22222222-2222`, read)).toBe(`${parent}:${root}`);
  expect(reads).toEqual([[parent, "22222222-2222"]]);
  await expect(
    canonicalThreadTarget(`${parent}:22222222-2222`, async () => ({
      accepted: true,
      messages: [{ id: root, target: "#foreign" }],
    })),
  ).rejects.toThrow();
});
