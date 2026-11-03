import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

const hint =
  "A task conversation (a '#channel:#7' target) is read with 'coforge task read <ref> --unread' and replied to with 'coforge task reply <ref>'.";

test("a channel task delivery wakes the Agent with the task commands", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );

  await index.receive({ ...delivery("task"), target: "#coforge:#100" });
  expect(notices).toEqual([`[CoForge inbox notice:\n#coforge:#100 1 new message\n${hint}]`]);
  expect(notices[0]).not.toContain("private body");
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({ target: "#coforge:#100", flags: ["task"], pendingCount: 1 }),
  ]);

  await index.receive({ ...delivery("dm-board"), target: "dm:@ada:#4", sequence: 2 });
  expect(notices[1]).toContain("dm:@ada:#4 1 new message");
  expect(notices[1]).toContain("coforge task reply");
});

test("the server's @peer seat is delivered and not taught a task command the CLI rejects", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  await index.receive({ ...delivery("seat"), target: "@ada~human:#3" });
  expect(notices).toEqual(["[CoForge inbox notice:\n@ada~human:#3 1 new message]"]);
  expect(index.check("agent-1")).toEqual([
    expect.objectContaining({ target: "@ada~human:#3", flags: ["task"] }),
  ]);
});

test("a channel target that is neither a thread anchor nor a task is still rejected", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  await expect(index.receive({ ...delivery("bad"), target: "#general:reply-id" })).rejects.toThrow(
    "invalid agent message scope",
  );
});

test("recovery of a channel task reaches the Agent from the summary alone", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  await index.recover("agent-1", [], { "#coforge:#100": 2, "@ada:#3": 1 });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("#coforge:#100 2 new messages");
  expect(notices[0]).toContain("@ada:#3 1 new message");
  expect(notices[0]).toContain("coforge task read");
  expect(notices[0]).toContain("coforge task reply");
});
