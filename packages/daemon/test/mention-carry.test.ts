import { expect, spyOn, test } from "bun:test";
import type { MentionDeliveryPorts } from "#src/daemon-runtime/mention-delivery-ports";
import { MentionEntries } from "#src/daemon-runtime/mention-delivery-entries";
import {
  MentionDeliveryTracker,
  type TrackedMentionDelivery,
} from "#src/daemon-runtime/mention-delivery-tracker";

const AGENT = "agent-a";

/** A tracker over fake ports: the Agent last reported launch `l1`, no process runs (a restart is
 * coming), and every notice is accepted. */
function subject(options: { process?: object; busy?: boolean } = {}) {
  const state = {
    process: options.process as object | undefined,
    remembered: { launchId: "l1", sessionId: "s1" },
    acks: [] as TrackedMentionDelivery[],
    terminals: [] as string[],
  };
  const ports: MentionDeliveryPorts = {
    transition: async () => {},
    terminalError: async (report) => void state.terminals.push(report.code),
    acknowledge: async (message) => void state.acks.push(message),
    running: () => state.remembered,
    consumed: () => false,
    told: () => false,
    announce: async () => "told",
    busy: () => options.busy === true,
    blocked: () => undefined,
    process: () => state.process,
    relaunching: () => false,
    remembered: () => state.remembered,
    pull: () => {},
  };
  const tracker = new MentionDeliveryTracker("computer-1", ports);
  return { tracker, carry: tracker.carry, state };
}

function mention(
  sequence: number,
  { agentId = AGENT, launchId = "l1", sessionId = "s1" } = {},
): TrackedMentionDelivery {
  return {
    protocolMajor: 1,
    requestId: `request-${sequence}`,
    messageId: `message-${sequence}`,
    deliveryId: `delivery-${sequence}`,
    sequence,
    workspaceId: "workspace-1",
    conversationId: "conversation-a",
    agentId,
    target: "#general",
    body: `body-${sequence}`,
    method: "agent:v1:message:deliver",
    mentionDelivery: {
      messageId: `message-${sequence}`,
      launchId,
      sessionId,
      computerId: "computer-1",
    },
  } as unknown as TrackedMentionDelivery;
}

const ids = (messages: readonly TrackedMentionDelivery[]) =>
  messages.map((message) => message.deliveryId);

test("a restart takes back a mention its previous launch's input had already taken", () => {
  const { carry } = subject();
  carry.hold(mention(1));
  expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-1"]);
  expect(carry.takeCarried(AGENT)).toEqual([]);

  // That launch ended before telling it: the next launch's input takes it again.
  carry.carryForRelaunch(AGENT, false);
  expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-1"]);
});

test("a mention moved out of an ended runtime's input waits for the next launch to take it", () => {
  const { carry } = subject();
  carry.hold(mention(1));
  carry.takeCarried(AGENT);

  expect(carry.hold(mention(1), true)).toBe(true);
  expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-1"]);
});

test("a mention told to a process that has since gone is kept for the next launch", async () => {
  const { tracker, carry, state } = subject({ process: {}, busy: true });
  await tracker.deliver(mention(1));
  expect(carry.hasCarried(AGENT)).toBe(false);

  // Its process went away with no restart to carry it; a repeat arrives for the wake.
  state.process = undefined;
  expect(carry.hold(mention(1))).toBe(true);
  expect(carry.hasCarried(AGENT)).toBe(true);

  // The ended turn does not settle it as rejected: the next launch tells it.
  tracker.settleTurnEnd(AGENT);
  expect(state.terminals).toEqual([]);
  expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-1"]);
});

test("a repeat for a process that still runs is not kept", async () => {
  const { tracker, carry } = subject({ process: {}, busy: true });
  await tracker.deliver(mention(1));

  expect(carry.hold(mention(1))).toBe(true);
  expect(carry.hasCarried(AGENT)).toBe(false);
});

test("a carried mention keeps the newest envelope the server issued while it waited", async () => {
  const { tracker, carry, state } = subject();
  const first = mention(1);
  carry.hold(first);
  const [taken] = carry.takeCarried(AGENT);

  // The server issues it again for a newer launch before the input tells the taken copy.
  state.remembered = { launchId: "l2", sessionId: "s2" };
  carry.hold(mention(1, { launchId: "l2", sessionId: "s2" }));
  await tracker.deliver(taken!);

  expect(state.acks.map((ack) => ack.mentionDelivery.launchId)).toEqual(["l2"]);
});

test("a repeat of a mention carried for one Agent does not touch another's", () => {
  const { carry } = subject();
  carry.hold(mention(1, { agentId: "agent-b" }));
  carry.hold(mention(2));

  expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-2"]);
  expect(carry.hasCarried("agent-b")).toBe(true);
  carry.refuseCarried("agent-b", "IDENTITY_UNKNOWN");
  expect(carry.hasCarried("agent-b")).toBe(false);
});

test("an Agent's carried mentions are found without walking every tracked mention", async () => {
  const { tracker, carry } = subject();
  for (let sequence = 1; sequence <= 5; sequence += 1)
    await tracker.deliver(mention(sequence, { agentId: "agent-b" }));
  carry.hold(mention(10));
  const walked = spyOn(MentionEntries.prototype, "all");
  try {
    expect(carry.hasCarried(AGENT)).toBe(true);
    expect(ids(carry.takeCarried(AGENT))).toEqual(["delivery-10"]);
    expect(carry.hasCarried("agent-c")).toBe(false);
    expect(walked).not.toHaveBeenCalled();
  } finally {
    walked.mockRestore();
  }
});

test("a mention settled while carried is no longer carried", async () => {
  const { tracker, carry } = subject();
  carry.hold(mention(1));
  const [taken] = carry.takeCarried(AGENT);
  await tracker.deliver(taken!);

  expect(carry.hasCarried(AGENT)).toBe(false);
  carry.hold(mention(2));
  await tracker.cancelAgent(AGENT);
  expect(carry.hasCarried(AGENT)).toBe(false);
  expect(carry.takeCarried(AGENT)).toEqual([]);
});

test("an Agent's cancellation runs the hook its waits registered, once", async () => {
  const { tracker } = subject();
  const cancelled: string[] = [];
  tracker.whenCancelled(AGENT, () => cancelled.push(AGENT));
  tracker.whenCancelled("agent-b", () => cancelled.push("agent-b"));

  await tracker.cancelAgent(AGENT);
  await tracker.cancelAgent(AGENT);
  expect(cancelled).toEqual([AGENT]);

  tracker.cancelAll();
  expect(cancelled).toEqual([AGENT, "agent-b"]);
});
