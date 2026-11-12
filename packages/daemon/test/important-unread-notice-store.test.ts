import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapePathIdentity } from "#src/persistence/path-scope";
import { ImportantUnreadNoticeStore } from "#src/persistence/important-unread-notice-store";

// A notice written before a restart is not re-sent into the same process (the live state decides
// that), but a new process cannot know it was written at all — so the record is what one restart
// reads to tell the Agent once (task #14).

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const state = await mkdtemp(join(tmpdir(), "coforge-important-unread-"));
  directories.push(state);
  return state;
}

const notice = {
  agentId: "agent-a",
  key: "seq:31",
  highestSequence: 31,
  conversations: [
    { conversationId: "conversation-a", target: "#general", firstSequence: 29, count: 2 },
  ],
  attempts: 1,
  writtenAtMs: 1_000,
  nextAttemptAtMs: 61_000,
};

test("a pending notice survives a new process and is not re-read by the one that wrote it", async () => {
  const state = await directory();
  const writer = new ImportantUnreadNoticeStore(() => state, "process-a");
  const reader = new ImportantUnreadNoticeStore(() => state, "process-b");
  writer.save(notice);
  expect(reader.list()).toEqual([notice]);
  expect(writer.list()).toEqual([]);
  reader.clear("agent-a");
  expect(reader.list()).toEqual([]);
});

test("a record that says nothing to act on is dropped instead of restored", async () => {
  const state = await directory();
  const reader = new ImportantUnreadNoticeStore(() => state, "process-b");
  const write = (agentId: string, body: unknown) =>
    Bun.write(
      join(state, "agent-state", escapePathIdentity(agentId), "important-unread.json"),
      JSON.stringify(body),
    );
  // No batch, no conversations, a sequence that is not a count, and a truncated file.
  await write("agent-empty", { version: 1, owner: "process-a", key: "seq:0", highestSequence: 0 });
  await write("agent-bare", {
    version: 1,
    owner: "process-a",
    key: "seq:5",
    highestSequence: 5,
    conversations: [],
  });
  await write("agent-odd", {
    version: 1,
    owner: "process-a",
    key: "seq:5",
    highestSequence: "5",
    conversations: [{ conversationId: "c", firstSequence: 5 }],
  });
  await Bun.write(
    join(state, "agent-state", escapePathIdentity("agent-broken"), "important-unread.json"),
    "{not json",
  );
  expect(reader.list()).toEqual([]);
  // Each bad record was cleared, so a later start does not read it again either.
  expect(new ImportantUnreadNoticeStore(() => state, "process-c").list()).toEqual([]);
});

test("an entry the server no longer describes still restores its batch", async () => {
  const state = await directory();
  const writer = new ImportantUnreadNoticeStore(() => state, "process-a");
  writer.save({
    ...notice,
    conversations: [{ conversationId: "conversation-a", firstSequence: 29, count: 1 }],
  });
  expect(new ImportantUnreadNoticeStore(() => state, "process-b").list()).toEqual([
    {
      agentId: "agent-a",
      key: "seq:31",
      highestSequence: 31,
      conversations: [{ conversationId: "conversation-a", firstSequence: 29, count: 1 }],
      attempts: 1,
      writtenAtMs: 1_000,
      nextAttemptAtMs: 61_000,
    },
  ]);
});
