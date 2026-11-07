import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { INBOX_PREVIEW_LIMIT } from "#src/daemon-runtime/inbox-preview";
import { delivery, session } from "./fixtures/attention-delivery";

function subject(options: { rejectNotice?: boolean } = {}) {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    {
      session: () =>
        session((notice) => {
          if (options.rejectNotice) throw new Error("notice refused");
          notices.push(notice);
        }),
    },
    async () => {},
  );
  return { index, notices };
}

const message = (id: string, overrides: Partial<AgentMessageDelivery> = {}) =>
  ({
    ...delivery(id, "human", "ada"),
    target: "#coforge",
    body: `body ${id}`,
    attachmentCount: 0,
    ...overrides,
  }) as AgentMessageDelivery;

test("a notice shows up to five previews per target, newest last", async () => {
  const { index, notices } = subject();
  // One notice for a whole held batch, which is when one target can carry many bodies.
  await index.flush(
    "agent-1",
    Array.from({ length: INBOX_PREVIEW_LIMIT + 2 }, (_, index) =>
      message(String(index + 1), { sequence: index + 1 }),
    ),
  );
  const notice = notices.at(-1)!;
  expect(notice).toContain("#coforge 7 new messages");
  // The newest five, oldest first; the two oldest fall outside the window.
  expect(notice).toContain(
    ["  @ada: body 3", "  @ada: body 4", "  @ada: body 5", "  @ada: body 6", "  @ada: body 7"].join(
      "\n",
    ),
  );
  expect(notice).not.toContain("body 1");
});

test("a whole, plain message a notice showed counts as seen for a send", async () => {
  const { index } = subject();
  await index.receive(message("one", { sequence: 4 }));
  expect(index.seenExactSequences("agent-1", "#coforge")).toEqual([4]);
  expect(index.hasExactSeen("agent-1", "#coforge")).toBe(true);
});

test("a cut, attached or App message is shown but not counted as seen", async () => {
  const { index } = subject();
  await index.receive(message("long", { sequence: 2, body: "x".repeat(200) }));
  await index.receive(
    message("attached", { sequence: 3, deliveryId: "delivery-attached", attachmentCount: 1 }),
  );
  await index.receive(message("app", { sequence: 4, deliveryId: "delivery-app", source: "app" }));
  expect(index.seenExactSequences("agent-1", "#coforge")).toEqual([]);
});

test("a redelivery of a message the notice already showed whole stays quiet", async () => {
  const { index, notices } = subject();
  const first = message("one", { sequence: 4 });
  await index.receive(first);
  const count = notices.length;
  await index.receive({ ...first, deliveryId: "delivery-one-again" });
  expect(notices).toHaveLength(count);
});

test("a new context drops what the previews had shown, so the messages read as unread again", async () => {
  const { index } = subject();
  await index.receive(message("one", { sequence: 4 }));
  expect(index.seenExactSequences("agent-1", "#coforge")).toEqual([4]);
  index.clearPreviewSeen("agent-1");
  expect(index.seenExactSequences("agent-1", "#coforge")).toEqual([]);
  // The same message may then be noticed again.
  const { notices } = subject();
  expect(notices).toHaveLength(0);
});

test("a notice the session refused records nothing as seen", async () => {
  const { index } = subject({ rejectNotice: true });
  await index.receive(message("one", { sequence: 4 })).catch(() => undefined);
  expect(index.seenExactSequences("agent-1", "#coforge")).toEqual([]);
});

test("a whole previewed message stops holding the send gate without settling pending", async () => {
  const { index } = subject();
  await index.receive(message("one", { sequence: 4 }));
  // Shown in full: the send gate must not hold for it, and no hold window shows it again.
  expect(index.pendingMessageCount("agent-1", "#coforge")).toBe(0);
  expect(index.pendingMaxSequence("agent-1", "#coforge")).toBe(0);
  expect(index.pendingWindow("agent-1", "#coforge", 10)).toHaveLength(0);
  expect(index.unreadDeliveries("agent-1")).toEqual([]);
  // Volatile only: attention still counts it until a read or continue settles it.
  expect(index.check("agent-1")[0]).toMatchObject({ pendingCount: 1 });
});

test("pending reads skip only the previewed sequences", async () => {
  const { index } = subject();
  await index.receive(message("one", { sequence: 4 }));
  // A truncated preview is shown but never counts as seen whole.
  await index.receive(
    message("long", {
      sequence: 5,
      deliveryId: "delivery-long",
      body: "x".repeat(200),
    }),
  );
  expect(index.pendingMessageCount("agent-1", "#coforge")).toBe(1);
  expect(index.pendingMaxSequence("agent-1", "#coforge")).toBe(5);
  expect(
    index.pendingWindow("agent-1", "#coforge", 10).map((entry) => entry.delivery.sequence),
  ).toEqual([5]);
  expect(index.unreadDeliveries("agent-1")).toEqual([{ target: "#coforge", count: 1 }]);
});

test("a new context restores the pending hold a preview had cleared", async () => {
  const { index } = subject();
  await index.receive(message("one", { sequence: 4 }));
  expect(index.pendingMessageCount("agent-1", "#coforge")).toBe(0);
  index.clearPreviewSeen("agent-1");
  expect(index.pendingMessageCount("agent-1", "#coforge")).toBe(1);
  expect(index.pendingMaxSequence("agent-1", "#coforge")).toBe(4);
  expect(index.pendingWindow("agent-1", "#coforge", 10)).toHaveLength(1);
  expect(index.unreadDeliveries("agent-1")).toEqual([{ target: "#coforge", count: 1 }]);
});
