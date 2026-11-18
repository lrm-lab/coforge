import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAppNotifiedStore } from "#src/persistence/app-notified-store";

const workspaceId = "019b0381-1111-7111-8111-111111111111";
const agentId = "019b0381-3333-7333-8333-333333333333";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function store() {
  const directory = mkdtempSync(join(tmpdir(), "app-notified-"));
  directories.push(directory);
  return { directory, store: new FileAppNotifiedStore(directory, workspaceId) };
}

test("what an Agent was told about is read back by the next daemon", async () => {
  const { directory, store: first } = store();
  await first.add(agentId, ["item-1", "item-2"]);
  expect([...(await first.read(agentId))].sort()).toEqual(["item-1", "item-2"]);
  const restarted = new FileAppNotifiedStore(directory, workspaceId);
  expect([...(await restarted.read(agentId))].sort()).toEqual(["item-1", "item-2"]);
});

test("an item added twice is kept once", async () => {
  const { store: files } = store();
  await files.add(agentId, ["item-1"]);
  await files.add(agentId, ["item-1", "item-2"]);
  expect([...(await files.read(agentId))].sort()).toEqual(["item-1", "item-2"]);
});

test("removing one item leaves the rest", async () => {
  const { store: files } = store();
  await files.add(agentId, ["item-1", "item-2"]);
  await files.remove(agentId, "item-1");
  expect(await files.read(agentId)).toEqual(["item-2"]);
  await files.remove(agentId, "item-9");
  expect(await files.read(agentId)).toEqual(["item-2"]);
});

test("clearing forgets every item", async () => {
  const { store: files } = store();
  await files.add(agentId, ["item-1", "item-2"]);
  await files.clear(agentId);
  expect(await files.read(agentId)).toEqual([]);
});

test("an unreadable file is set aside, and the Agent is told about its items again", async () => {
  const { directory, store: files } = store();
  const agentDirectory = join(directory, "app-notified", workspaceId, agentId);
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(join(agentDirectory, "items.json"), "{ not json");
  expect(await files.read(agentId)).toEqual([]);
  expect(
    readdirSync(agentDirectory).some(
      (entry) => entry.startsWith("items.json.corrupt-") && existsSync(join(agentDirectory, entry)),
    ),
  ).toBe(true);
  await files.add(agentId, ["item-1"]);
  expect(await files.read(agentId)).toEqual(["item-1"]);
});

test("an Agent id that would leave the state directory is refused", async () => {
  const { store: files } = store();
  await expect(files.read("../elsewhere")).rejects.toThrow("invalid app notified Agent scope");
});
