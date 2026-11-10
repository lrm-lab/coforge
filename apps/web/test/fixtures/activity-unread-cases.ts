/**
 * The Activity unread count rules (task #62) as one case table: the Web page applies a message to
 * the count it holds (`applyActivityMessage`), and the server counts the same items from the
 * database (`unreadCount`/`unreadKeys` of the nav attention read).
 *
 * The backend's integration test of the server count must run these same cases against the
 * database — the viewer's unread items before the message, the message, the count after — so the
 * two sides are checked against one table. A change to a rule changes a case here, and both
 * suites follow.
 *
 * Item keys: `conversation:<conversationId>` (a channel's, DM's or Task conversation's top-level
 * messages) and `thread:<rootMessageId>` (a followed thread). `mention:<id>` and `comment:<id>`
 * keys come from the server alone and are carried through unchanged.
 */

export const VIEWER = "viewer";

export type UnreadCountState = {
  hasUnread: boolean;
  unreadCount?: number;
  unreadKeys?: string[];
};

export type UnreadCountMessage = {
  conversationId: string;
  senderUserId?: string;
  sender: { kind: "user" | "agent" | "system"; name: string };
  threadRootId?: string;
  muted?: true;
};

export type UnreadCountCase = {
  name: string;
  /** What the viewer's Activity counts before the message. */
  before: UnreadCountState;
  message: UnreadCountMessage;
  /** The conversation or thread the viewer has open right now. */
  viewingKey?: string;
  after: UnreadCountState;
  /** The page cannot decide alone and reads the count from the server (throttled). */
  reread: boolean;
};

const person = { kind: "user", name: "Ada" } as const;
const noneUnread: UnreadCountState = { hasUnread: false, unreadCount: 0, unreadKeys: [] };
const oneUnread: UnreadCountState = {
  hasUnread: true,
  unreadCount: 1,
  unreadKeys: ["conversation:channel-1"],
};

/** A count already at the cap: 100 means "100 or more", and its key set may be incomplete. */
const keys = (count: number) => Array.from({ length: count }, (_, i) => `conversation:full-${i}`);
const capped: UnreadCountState = { hasUnread: true, unreadCount: 100, unreadKeys: keys(100) };

export const unreadCountCases: UnreadCountCase[] = [
  {
    name: "a message from another person in a channel counts its conversation",
    before: noneUnread,
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person },
    after: oneUnread,
    reread: false,
  },
  {
    name: "an Agent's message counts, though no user id wrote it",
    before: noneUnread,
    message: { conversationId: "channel-1", sender: { kind: "agent", name: "Builder" } },
    after: oneUnread,
    reread: false,
  },
  {
    name: "the viewer's own message changes nothing",
    before: noneUnread,
    message: { conversationId: "channel-1", senderUserId: VIEWER, sender: person },
    after: noneUnread,
    reread: false,
  },
  {
    name: "a system message changes nothing",
    before: noneUnread,
    message: { conversationId: "channel-1", sender: { kind: "system", name: "CoForge" } },
    after: noneUnread,
    reread: false,
  },
  {
    name: "a second message in an already unread conversation does not count again",
    before: oneUnread,
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person },
    after: oneUnread,
    reread: false,
  },
  {
    name: "a message in another conversation adds one",
    before: oneUnread,
    message: { conversationId: "dm-1", senderUserId: "ada", sender: person },
    after: {
      hasUnread: true,
      unreadCount: 2,
      unreadKeys: ["conversation:channel-1", "conversation:dm-1"],
    },
    reread: false,
  },
  {
    name: "a Done item receiving a new message counts again: it is a key not in the set",
    // The server lists a Done conversation again once `latest.sequence > doneThroughSequence`
    // (`conversationPastDoneSql`); the Done item was out of the set, so the message adds it.
    before: { hasUnread: true, unreadCount: 1, unreadKeys: ["thread:root-9"] },
    message: { conversationId: "channel-done", senderUserId: "ada", sender: person },
    after: {
      hasUnread: true,
      unreadCount: 2,
      unreadKeys: ["thread:root-9", "conversation:channel-done"],
    },
    reread: false,
  },
  {
    name: "a thread reply counts the thread, not its conversation",
    // A reply is published only to the thread's followers (server side), so a reply to a thread
    // the viewer does not follow never arrives; the page counts whatever arrives.
    before: noneUnread,
    message: {
      conversationId: "channel-1",
      senderUserId: "ada",
      sender: person,
      threadRootId: "root-1",
    },
    after: { hasUnread: true, unreadCount: 1, unreadKeys: ["thread:root-1"] },
    reread: false,
  },
  {
    name: "a thread reply and a top-level message in the same conversation are two items",
    before: { hasUnread: true, unreadCount: 1, unreadKeys: ["thread:root-1"] },
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person },
    after: {
      hasUnread: true,
      unreadCount: 2,
      unreadKeys: ["thread:root-1", "conversation:channel-1"],
    },
    reread: false,
  },
  {
    name: "a muted conversation's message changes nothing and asks for a read",
    // Only the server knows whether it mentions the viewer: a muted channel counts only with an
    // unread mention of the viewer.
    before: noneUnread,
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person, muted: true },
    after: noneUnread,
    reread: true,
  },
  {
    name: "a message in the conversation the viewer has open changes nothing",
    before: noneUnread,
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person },
    viewingKey: "conversation:channel-1",
    after: noneUnread,
    reread: false,
  },
  {
    name: "a reply in the thread the viewer has open changes nothing",
    before: noneUnread,
    message: {
      conversationId: "channel-1",
      senderUserId: "ada",
      sender: person,
      threadRootId: "root-1",
    },
    viewingKey: "thread:root-1",
    after: noneUnread,
    reread: false,
  },
  {
    name: "a reply in a thread whose conversation is open still counts the thread",
    before: noneUnread,
    message: {
      conversationId: "channel-1",
      senderUserId: "ada",
      sender: person,
      threadRootId: "root-1",
    },
    viewingKey: "conversation:channel-1",
    after: { hasUnread: true, unreadCount: 1, unreadKeys: ["thread:root-1"] },
    reread: false,
  },
  {
    name: "an old server's answer, without a count, only lights the dot",
    before: { hasUnread: false },
    message: { conversationId: "channel-1", senderUserId: "ada", sender: person },
    after: { hasUnread: true },
    reread: false,
  },
  {
    name: "a count capped at 100 stays 100 and keeps its keys",
    before: capped,
    message: { conversationId: "channel-new", senderUserId: "ada", sender: person },
    after: capped,
    reread: false,
  },
  {
    name: "the 100th item reaches the cap",
    before: { hasUnread: true, unreadCount: 99, unreadKeys: keys(99) },
    message: { conversationId: "channel-new", senderUserId: "ada", sender: person },
    after: {
      hasUnread: true,
      unreadCount: 100,
      unreadKeys: [...keys(99), "conversation:channel-new"],
    },
    reread: false,
  },
];
