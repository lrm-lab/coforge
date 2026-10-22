import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionIds } from "../src/session-ids";

test("lists every runtime session an Agent workspace holds, oldest first", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "session-ids-"));
  const dir = join(cwd, ".builtin-sessions");
  await mkdir(dir);
  const header = (id: string) => `${JSON.stringify({ type: "session", id, cwd })}\n{"type":"x"}\n`;
  await writeFile(join(dir, "2026-10-22T13-35-27-051Z_b.jsonl"), header("b"));
  await writeFile(join(dir, "2026-10-22T13-35-22-759Z_a.jsonl"), header("a"));
  await writeFile(join(dir, "notes.txt"), "not a session");
  expect(await listSessionIds(cwd)).toEqual(["a", "b"]);
});

test("an Agent workspace without sessions lists none", async () => {
  expect(await listSessionIds(await mkdtemp(join(tmpdir(), "session-ids-")))).toEqual([]);
});
