import {
  looksLikeMemberGenerateOfferAccept,
  parseRecordAssistantPayload,
  type RecordAssistantPayload,
} from "./weekly-highlight-extract";

type ThreadComment = { id: string; authorType: string; body: string; payload: unknown };

/** What the comments after one in the side panel's thread settled about its card. */
export type CommentThreadState = {
  payload: RecordAssistantPayload | null;
  /** A plan, a decline, or the member's yes or no answered its intent question. */
  intentResolved: boolean;
  /** A newer send offer replaced it, or the assistant said this week's send was cancelled. */
  offerSuperseded: boolean;
  /** A collect run followed it, so its collect plan was submitted. */
  collectRunFollows: boolean;
  /** The first comment of its collect run: only it shows the run's card. */
  firstOfCollectRun: boolean;
};

/**
 * Every comment's thread state, read in one pass from the newest back (task #366: each card
 * scanned the comments after it, so a 200-comment thread did 20,000 reads per render), and
 * whether the member already accepted the offer to help write.
 */
export function commentThreadStates(comments: readonly ThreadComment[]) {
  const byId = new Map<string, CommentThreadState>();
  let intentResolved = false;
  let offerSuperseded = false;
  let collectRunFollows = false;
  let generateHelpConsumed = false;
  const firstOfRun = new Map<string, CommentThreadState>();
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const row = comments[index]!;
    const payload = parseRecordAssistantPayload(row.payload);
    const state = {
      payload,
      intentResolved,
      offerSuperseded,
      collectRunFollows,
      firstOfCollectRun: false,
    };
    // Read newest first, so a repeated id keeps its first comment's state, as `findIndex` did.
    byId.set(row.id, state);
    if (
      payload?.kind === "collect-plan" ||
      payload?.kind === "intent-declined" ||
      (row.authorType === "user" && (row.body === "确认" || row.body === "不是"))
    ) {
      intentResolved = true;
    }
    if (
      payload?.kind === "offer-send" ||
      (row.authorType === "assistant" && row.body.includes("已取消本周周报"))
    ) {
      offerSuperseded = true;
    }
    if (payload?.kind === "collect-run") {
      collectRunFollows = true;
      // Read newest first, so the last one set is the run's first comment.
      firstOfRun.set(payload.runId, state);
    }
    if (row.authorType === "user" && looksLikeMemberGenerateOfferAccept(row.body)) {
      generateHelpConsumed = true;
    }
  }
  for (const state of firstOfRun.values()) state.firstOfCollectRun = true;
  return { byId, generateHelpConsumed };
}

/** The thread's comments and assistant messages in time order, a comment first on a tie. */
export function sideTimeline<
  C extends { id: string; createdAt: string },
  D extends { id: string; createdAt: string },
>(comments: readonly C[], messages: readonly D[]) {
  type Item =
    | { source: "comment"; at: number; id: string; comment: C }
    | { source: "dm"; at: number; id: string; message: D };
  const items: Item[] = [
    ...comments.map((comment) => ({
      source: "comment" as const,
      at: Date.parse(comment.createdAt),
      id: `comment:${comment.id}`,
      comment,
    })),
    ...messages.map((message) => ({
      source: "dm" as const,
      at: Date.parse(message.createdAt),
      id: `dm:${message.id}`,
      message,
    })),
  ];
  items.sort((left, right) => {
    if (left.at !== right.at) return left.at - right.at;
    return left.source === right.source ? 0 : left.source === "comment" ? -1 : 1;
  });
  return items;
}
