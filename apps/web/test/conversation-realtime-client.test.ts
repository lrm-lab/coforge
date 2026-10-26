import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { subscribeToConversationRealtime } from "#src/features/conversations/conversation-realtime-client";

type PublicationListener = (context: { data: unknown }) => void;
type SubscribedListener = (context: { wasRecovering: boolean; recovered: boolean }) => void;

function fakeClient() {
  let created = 0;
  let stopped = 0;
  let removed = 0;
  const publications: PublicationListener[] = [];
  const subscribedListeners: SubscribedListener[] = [];
  const subscription = {
    state: "subscribing",
    on(event: string, listener: PublicationListener | SubscribedListener) {
      if (event === "publication") publications.push(listener as PublicationListener);
      if (event === "subscribed") subscribedListeners.push(listener as SubscribedListener);
      return subscription;
    },
    subscribe() {},
    unsubscribe() {
      stopped++;
    },
  };
  return {
    client: {
      newSubscription: () => {
        created++;
        return subscription;
      },
      removeSubscription() {
        removed++;
      },
    } as unknown as Parameters<typeof subscribeToConversationRealtime>[0],
    counts: () => ({ created, stopped, removed }),
    publish(data: unknown) {
      for (const listener of publications) listener({ data });
    },
    subscribed(context: { wasRecovering: boolean; recovered: boolean }) {
      subscription.state = "subscribed";
      for (const listener of subscribedListeners) listener(context);
    },
  };
}

const originals = { document: globalThis.document, window: globalThis.window };

/** The page's `document`: its visibility, and the visibility listeners the subscription added. */
let page: { visibilityState: string; visibilityListeners: (() => void)[] };

/** The tab becomes hidden or visible again. */
function setVisibility(state: "hidden" | "visible") {
  page.visibilityState = state;
  for (const listener of page.visibilityListeners) listener();
}

beforeEach(() => {
  const target = { addEventListener() {}, removeEventListener() {} };
  const visibilityListeners: (() => void)[] = [];
  page = {
    visibilityState: "visible",
    visibilityListeners,
  };
  const document = {
    removeEventListener() {},
    addEventListener(event: string, listener: () => void) {
      if (event === "visibilitychange") visibilityListeners.push(listener);
    },
    get visibilityState() {
      return page.visibilityState;
    },
  };
  Object.assign(globalThis, {
    document,
    window: { ...target, setInterval: () => 0, clearInterval() {} },
  });
});

afterEach(() => {
  Object.assign(globalThis, originals);
});

describe("subscribeToConversationRealtime", () => {
  test("hands the sender's idempotency key to the page along with the message it became", () => {
    const { client, publish } = fakeClient();
    const sent: [string, string][] = [];
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onSentMessage: (idempotencyKey, messageId) => sent.push([idempotencyKey, messageId]),
    });

    publish({
      type: "message.available.v1",
      conversationId: "conversation-a",
      messageId: "message-a",
      sequence: 3,
      idempotencyKey: "request-a",
    });
    publish({
      type: "message.available.v1",
      conversationId: "conversation-a",
      messageId: "message-b",
      sequence: 4,
    });

    expect(sent).toEqual([["request-a", "message-a"]]);
    expect(reconciled).toBe(2);
  });

  test("a member change refreshes this conversation's member list, not its messages", () => {
    const { client, publish } = fakeClient();
    let memberChanges = 0;
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onMemberChanged: () => {
        memberChanges += 1;
      },
    });

    publish({ type: "member.changed.v1", conversationId: "conversation-a", workspaceId: "w" });
    publish({ type: "member.changed.v1", conversationId: "conversation-b", workspaceId: "w" });

    expect(memberChanges).toBe(1);
    expect(reconciled).toBe(0);
  });

  test("a rename or archive of this channel refreshes the open page, not its messages", () => {
    const { client, publish } = fakeClient();
    let channelUpdates = 0;
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onChannelUpdated: () => {
        channelUpdates += 1;
      },
    });

    publish({ type: "channel.updated.v1", conversationId: "conversation-a", workspaceId: "w" });
    publish({ type: "channel.updated.v1", conversationId: "conversation-b", workspaceId: "w" });

    expect(channelUpdates).toBe(1);
    expect(reconciled).toBe(0);
  });

  test("the first subscribe refreshes only what the page payload carried; a lost stream refreshes the whole member directory", () => {
    const { client, subscribed, publish } = fakeClient();
    const memberChanges: string[] = [];
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onMemberChanged: (stale) => {
        memberChanges.push(stale);
      },
    });

    // The first subscribe covers what changed while the page loaded: only the copies the page
    // payload carried were read before it. A list the browser first reads after hydration is not.
    subscribed({ wasRecovering: false, recovered: false });
    expect(memberChanges).toEqual(["page-payload"]);
    expect(reconciled).toBe(1);

    // A recovered resubscribe replays every missed publication, so it needs no refetch.
    subscribed({ wasRecovering: true, recovered: true });
    expect(memberChanges).toEqual(["page-payload"]);
    expect(reconciled).toBe(1);

    // A resubscribe that lost the stream, like a member change itself, may have missed a change
    // to any member list.
    subscribed({ wasRecovering: true, recovered: false });
    publish({ type: "member.changed.v1", conversationId: "conversation-a", workspaceId: "w" });
    expect(memberChanges).toEqual(["page-payload", "all", "all"]);
    expect(reconciled).toBe(2);
  });

  test("a reaction event reaches the page whether or not the tab is visible, and reads nothing", () => {
    const { client, publish } = fakeClient();
    const heard: unknown[] = [];
    let reconciled = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {
        reconciled += 1;
      },
      onReaction: (event) => heard.push(event),
    });
    const event = {
      type: "message.reaction.v1",
      conversationId: "conversation-a",
      messageId: "reply-a",
      threadRootId: "root-a",
      version: 4,
      reactions: [{ emoji: "👍", count: 1, reactors: [{ id: "user-a", label: "Ada" }] }],
    };

    publish(event);
    page.visibilityState = "hidden";
    publish({ ...event, version: 5, reactions: null });
    // Another conversation's, and a malformed one, are not this page's.
    publish({ ...event, conversationId: "conversation-b" });
    publish({ ...event, version: "6" });

    expect(heard).toEqual([event, { ...event, version: 5, reactions: null }]);
    expect(reconciled).toBe(0);
  });

  test("only a resubscribe that lost publications says reactions may be stale", () => {
    const { client, subscribed } = fakeClient();
    let lost = 0;
    subscribeToConversationRealtime(client, {
      conversationId: "conversation-a",
      getToken: async () => "token",
      reconcile: () => {},
      onPublicationsLost: () => {
        lost += 1;
      },
    });

    subscribed({ wasRecovering: false, recovered: false });
    subscribed({ wasRecovering: true, recovered: true });
    // Events apply while the tab is hidden, so becoming visible again repairs nothing.
    setVisibility("hidden");
    setVisibility("visible");
    expect(lost).toBe(0);
    subscribed({ wasRecovering: true, recovered: false });
    expect(lost).toBe(1);
  });
});

test("conversation views share one physical subscription until the last release", () => {
  const { client, publish, counts } = fakeClient();
  let first = 0;
  let second = 0;
  const releaseFirst = subscribeToConversationRealtime(client, {
    conversationId: "c",
    getToken: async () => "token",
    reconcile: () => first++,
  });
  const releaseSecond = subscribeToConversationRealtime(client, {
    conversationId: "c",
    getToken: async () => "token",
    reconcile: () => second++,
  });
  try {
    expect(counts()).toEqual({ created: 1, stopped: 0, removed: 0 });
    publish({ type: "message.available.v1", conversationId: "c", messageId: "m1", sequence: 1 });
    expect([first, second]).toEqual([1, 1]);
    releaseFirst();
    releaseFirst();
    expect(counts()).toEqual({ created: 1, stopped: 0, removed: 0 });
    publish({ type: "message.available.v1", conversationId: "c", messageId: "m2", sequence: 2 });
    expect([first, second]).toEqual([1, 2]);
    releaseSecond();
    expect(counts()).toEqual({ created: 1, stopped: 1, removed: 1 });
  } finally {
    releaseFirst();
    releaseSecond();
  }
});
