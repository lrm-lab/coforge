import { expect, test } from "bun:test";
import { readLocalSessionWindows } from "@lrm/coforge-anvil";

const limits = {
  maxResults: 100,
  maxDirectories: 100,
  maxFiles: 100,
  maxContentBytes: 1_024,
  maxFileBytes: 1_024,
  deadlineAtMs: Date.now() + 2_000,
  now: Date.now,
};

test("a failed window pair still consumes its reserved content budget", async () => {
  const budget = { bytes: 1_024 };
  let headBytes = 0;
  const host = {
    async readFileHeadBytes(_root: string, _path: string, bytes: number) {
      headBytes += bytes;
      return { bytes: new Uint8Array(bytes) };
    },
    async readFileTailBytes() {
      throw new Error("tail failed");
    },
  };
  expect(
    await readLocalSessionWindows("/", "/session.jsonl", limits, host, budget),
  ).toBeUndefined();
  expect(budget.bytes).toBe(0);
  expect(
    await readLocalSessionWindows("/", "/session.jsonl", limits, host, budget),
  ).toBeUndefined();
  expect(headBytes).toBe(512);
});
