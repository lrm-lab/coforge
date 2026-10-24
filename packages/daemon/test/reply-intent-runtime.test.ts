import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { ReplyIntentPublisher } from "#src/daemon-runtime/reply-intent-publisher";
import { activityHarness } from "./fixtures/activity-runtime";

// macOS tmpdir lives under /var, a symlink; the state store rejects linked ancestors.
const workspaceRoot = join(realpathSync(tmpdir()), `coforge-reply-intent-${crypto.randomUUID()}`);
const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot,
};
afterAll(() => rm(workspaceRoot, { recursive: true, force: true }));

const sendCall = (id: string, target = "#general") => ({
  type: "tool-start" as const,
  id,
  name: "bash",
  input: { command: `coforge message send --target '${target}' <<'X'\nhi\nX` },
});

test("a launch's message send reaches the connection as an about-to-post frame, and its end clears it", async () => {
  const { runtime, replyIntents, emitEvent } = await activityHarness(connection);
  try {
    emitEvent({ type: "tool-start", id: "ls-1", name: "bash", input: { command: "ls" } });
    expect(replyIntents).toEqual([]);

    emitEvent(sendCall("call-1", "#general:ab12cd34"));
    expect(replyIntents).toHaveLength(1);
    expect(replyIntents[0]).toMatchObject({
      protocolMajor: 1,
      workspaceId: "workspace-a",
      agentId: "agent-a",
      intent: { phase: "start", callId: "call-1", target: "#general:ab12cd34" },
    });
    expect(replyIntents[0]!.requestId).toBeTruthy();
    expect(replyIntents[0]!.observedAtMs).toBeGreaterThan(0);

    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    // The end repeats the target, so the server can route it where the start went.
    expect(replyIntents.at(-1)).toMatchObject({
      intent: { phase: "end", callId: "call-1", target: "#general:ab12cd34" },
    });
  } finally {
    await runtime.stop();
  }
});

test("a completed turn ends the calls still announced", async () => {
  const { runtime, replyIntents, emitEvent } = await activityHarness(connection);
  try {
    emitEvent(sendCall("call-1"));
    emitEvent({ type: "completed", status: "completed" });
    expect(replyIntents.map((frame) => frame.intent.phase)).toEqual(["start", "end"]);
  } finally {
    await runtime.stop();
  }
});

type Launch = { stopping: boolean };

function publisher(options: { current?: Launch; active?: boolean } = {}) {
  const sent: Array<{ phase: string; target?: string }> = [];
  const launch: Launch = { stopping: false };
  const subject = new ReplyIntentPublisher<Launch>({
    currentLaunch: () => ("current" in options ? options.current : launch),
    transport: () => ({
      sendAgentReplyIntent: (frame) =>
        sent.push({ phase: frame.intent.phase, target: frame.intent.target }),
    }),
    workspaceId: () => "workspace-a",
    active: () => options.active ?? true,
  });
  return { tracker: subject.tracker("agent-a", launch), launch, sent };
}

const send = (id: string, target = "#general") => ({
  type: "tool-start" as const,
  id,
  name: "bash",
  input: { command: `coforge message send --target '${target}' --content hi` },
});
const finish = (id: string) => ({ type: "tool-end" as const, id, isError: false });

test("no start is published before the runtime is up or for a launch that is not current, but its end is", () => {
  const down = publisher({ active: false });
  down.tracker.observe(send("c1"));
  expect(down.sent).toEqual([]);

  const replaced = publisher({ current: { stopping: false } });
  replaced.tracker.observe(send("c1"));
  expect(replaced.sent).toEqual([]);
});

test("an end only tears down, so it is sent whatever the runtime or launch has become", () => {
  const state = { active: true };
  const first: Launch = { stopping: false };
  const sent: string[] = [];
  let current: Launch | undefined = first;
  const subject = new ReplyIntentPublisher<Launch>({
    currentLaunch: () => current,
    transport: () => ({ sendAgentReplyIntent: (frame) => sent.push(frame.intent.phase) }),
    workspaceId: () => "workspace-a",
    active: () => state.active,
  });
  const tracker = subject.tracker("agent-a", first);
  tracker.observe(send("c1"));
  // The launch is replaced and the runtime stops; the announced call still ends.
  current = { stopping: false };
  state.active = false;
  tracker.observe(finish("c1"));
  expect(sent).toEqual(["start", "end"]);
});

test("a stopping launch announces no new start but still ends what it announced", () => {
  const { tracker, launch, sent } = publisher();
  tracker.observe(send("c1"));
  launch.stopping = true;
  tracker.observe(send("c2"));
  tracker.observe(finish("c1"));
  expect(sent).toEqual([
    { phase: "start", target: "#general" },
    { phase: "end", target: "#general" },
  ]);
});

test("a target known while the call streams reaches the connection flagged early, once", async () => {
  const { runtime, replyIntents, emitEvent } = await activityHarness(connection);
  try {
    emitEvent({ type: "reply-intent", id: "call-1", target: "#general" });
    expect(replyIntents).toHaveLength(1);
    expect(replyIntents[0]).toMatchObject({
      intent: { phase: "start", callId: "call-1", target: "#general", early: true },
    });
    // The finished call neither restarts the announcement nor drops the flag.
    emitEvent(sendCall("call-1"));
    expect(replyIntents).toHaveLength(1);
    emitEvent({ type: "tool-end", id: "call-1", isError: false });
    expect(replyIntents.at(-1)).toMatchObject({ intent: { phase: "end", callId: "call-1" } });
    // A call announced only when it finishes is not early.
    emitEvent(sendCall("call-2"));
    expect(replyIntents.at(-1)?.intent.early).toBeUndefined();
  } finally {
    await runtime.stop();
  }
});
