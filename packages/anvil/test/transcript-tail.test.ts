import { expect, test } from "bun:test";
import { readTailLines } from "#src/transcript-tail";

const host = (text: string, startOffset: number) => ({
  readFileTail: async () => ({ text, startOffset }),
});

test("keeps the lines of the tail", async () => {
  expect(await readTailLines("p", 100, host("a\nb\n", 0))).toEqual(["a", "b", ""]);
});

test("drops the first line when the window cut it", async () => {
  expect(await readTailLines("p", 100, host("alf\nb\nc", 2))).toEqual(["b", "c"]);
});

test("an unreadable file answers undefined", async () => {
  const failing = {
    readFileTail: async () => {
      throw new Error("gone");
    },
  };
  expect(await readTailLines("p", 100, failing)).toBeUndefined();
});
