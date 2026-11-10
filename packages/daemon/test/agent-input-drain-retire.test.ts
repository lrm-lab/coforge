import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentInputDrain, type AgentInputDrainPorts } from "#src/daemon-runtime/agent-input-drain";
import type { AgentInput } from "#src/daemon-runtime/runtime-launch-intent";

const delivery = (id: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "body",
  method: "agent:v1:message:deliver",
  target: "#general",
});

/** A drain over fake ports: `block` holds the first delivery's notice until it is released or
 * rejected, `launching` is what the NEW launch looks like to the ports. */
function drain(options: { launching?: boolean } = {}) {
  const abandoned: unknown[] = [];
  const ran: string[] = [];
  const gate = Promise.withResolvers<void>();
  const ports = {
    runnerHeld: () => false,
    sessionFor: () => ({ hasLiveTurn: false }),
    launchFor: () => ({ startup: { responses: 0, endsLaunch: () => true, errorObserved: true } }),
    hasQueuedDeliveries: () => false,
    isLaunching: () => options.launching ?? false,
    isStopping: () => false,
    deliverMessage: async (_: string, message: AgentMessageDelivery) => {
      ran.push(message.deliveryId);
      await gate.promise;
    },
    runStartup: async () => {},
    runPrompt: async (_: string, text: string) => {
      ran.push(text);
      await gate.promise;
    },
    recoverAttention: async () => {
      ran.push("recovery");
      await gate.promise;
    },
    abandonLaunch: async (_: string, error: unknown) => {
      abandoned.push(error);
      return error;
    },
    publishStartupError: () => {},
    forgetIntroduced: () => {},
    dropMention: () => {},
  } as unknown as AgentInputDrainPorts;
  return { drain: new AgentInputDrain(ports), abandoned, ran, gate };
}

const prompt = (queue: AgentInputDrain, text: string, introduction?: true) =>
  queue.enqueue("agent-1", (completion) => ({ kind: "prompt", text, introduction, completion }));

/** The drain is on an item it cannot finish, with `waiting` queued behind it. */
async function busy(
  subject: ReturnType<typeof drain>,
  first: (completion: Parameters<Parameters<AgentInputDrain["enqueue"]>[1]>[0]) => AgentInput,
  ...waiting: Array<() => Promise<void>>
) {
  const inFlight = subject.drain.enqueue("agent-1", first).catch(() => {});
  const queued = waiting.map((enqueue) => enqueue().catch(() => {}));
  subject.drain.ensure("agent-1");
  await Promise.resolve();
  return { inFlight, queued };
}

test("retiring hands the waiting deliveries to custody and carries none into the new queue", async () => {
  const subject = drain();
  await busy(
    subject,
    (completion) => ({ kind: "delivery", message: delivery("1"), completion }),
    () =>
      subject.drain.enqueue("agent-1", (completion) => ({
        kind: "delivery",
        message: delivery("2"),
        completion,
      })),
  );
  const kept: string[] = [];

  subject.drain.retire("agent-1", (messages) =>
    kept.push(...messages.map((message) => message.deliveryId)),
  );

  expect(kept).toEqual(["delivery-2"]);
  expect(subject.drain.get("agent-1")).toBeUndefined();
  subject.gate.resolve();
});

test("a delivery queued for the launch now beginning, with no loop running, stays queued", async () => {
  const subject = drain();
  void subject.drain
    .enqueue("agent-1", (completion) => ({ kind: "delivery", message: delivery("1"), completion }))
    .catch(() => {});
  const kept: string[] = [];

  const carried = subject.drain.retire("agent-1", (messages) =>
    kept.push(...messages.map((message) => message.deliveryId)),
  );
  subject.drain.carry("agent-1", carried, false);

  expect(kept).toEqual([]);
  expect(subject.drain.get("agent-1")?.items.map((item) => item.kind)).toEqual(["delivery"]);
});

test("an introduction waiting in the retired queue is carried, ahead of the launch's own input", async () => {
  const subject = drain();
  await busy(
    subject,
    (completion) => ({ kind: "delivery", message: delivery("1"), completion }),
    () => prompt(subject.drain, "Say hello once.", true),
    () => prompt(subject.drain, "Pick it up."),
  );

  const prompts = subject.drain.retire("agent-1", () => {});
  subject.drain.carry("agent-1", prompts, true);

  // The launch carries a resume prompt of its own, so only the introduction is carried over.
  expect(
    subject.drain.get("agent-1")?.items.map((item) => item.kind === "prompt" && item.text),
  ).toEqual(["Say hello once."]);
  subject.gate.resolve();
});

test("a resume prompt waiting in the retired queue is carried when the launch has none", async () => {
  const subject = drain();
  await busy(
    subject,
    (completion) => ({ kind: "delivery", message: delivery("1"), completion }),
    () => prompt(subject.drain, "Say hello once.", true),
    () => prompt(subject.drain, "Pick it up."),
  );

  const prompts = subject.drain.retire("agent-1", () => {});
  subject.drain.carry("agent-1", prompts, false);

  expect(
    subject.drain.get("agent-1")?.items.map((item) => item.kind === "prompt" && item.text),
  ).toEqual(["Say hello once.", "Pick it up."]);
  subject.gate.resolve();
});

test("a recovery item of the ended runtime that fails in flight leaves the new launch alone", async () => {
  const subject = drain({ launching: true });
  const { inFlight } = await busy(subject, (completion) => ({
    kind: "recovery",
    context: { unreadSummary: { "#ops": 1 } },
    completion,
  }));
  subject.drain.retire("agent-1", () => {});

  // The dying process rejects what it was on: the launch that replaced it is not abandoned.
  subject.gate.reject(new Error("the session ended"));
  await inFlight;

  expect(subject.abandoned).toEqual([]);
});

test("a delivery of the ended runtime that fails in flight is kept for the next launch", async () => {
  const subject = drain({ launching: true });
  const { inFlight } = await busy(subject, (completion) => ({
    kind: "delivery",
    message: delivery("1"),
    completion,
  }));
  const kept: string[] = [];
  subject.drain.retire("agent-1", (messages) =>
    kept.push(...messages.map((message) => message.deliveryId)),
  );

  subject.gate.reject(new Error("the session ended"));
  await inFlight;

  expect(kept).toEqual(["delivery-1"]);
});
