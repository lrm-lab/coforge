import { expect, test } from "bun:test";

import {
  commentThreadStates,
  sideTimeline,
} from "#src/features/records/record-side-timeline-model";
import {
  looksLikeMemberGenerateOfferAccept,
  parseRecordAssistantPayload,
} from "#src/features/records/weekly-highlight-extract";

/**
 * Task #366: the side panel reads each comment's thread state in one pass. It must answer as the
 * scans it replaced did, each over the comments after that one.
 */
type Row = { id: string; authorType: string; body: string; payload: unknown };

function scanned(comments: Row[], comment: Row) {
  const payloadOf = (row: Row) => parseRecordAssistantPayload(row.payload);
  const index = comments.findIndex((row) => row.id === comment.id);
  const later = comments.slice(index + 1);
  const payload = payloadOf(comment);
  return {
    payload,
    intentResolved: later.some((row) => {
      const next = payloadOf(row);
      return (
        next?.kind === "collect-plan" ||
        next?.kind === "intent-declined" ||
        (row.authorType === "user" && (row.body === "确认" || row.body === "不是"))
      );
    }),
    offerSuperseded: later.some(
      (row) =>
        payloadOf(row)?.kind === "offer-send" ||
        (row.authorType === "assistant" && row.body.includes("已取消本周周报")),
    ),
    collectRunFollows: later.some((row) => payloadOf(row)?.kind === "collect-run"),
    firstOfCollectRun:
      payload?.kind === "collect-run" &&
      comments.find((row) => {
        const first = payloadOf(row);
        return first?.kind === "collect-run" && first.runId === payload.runId;
      })?.id === comment.id,
  };
}

const PAYLOADS: unknown[] = [
  null,
  { kind: "offer-send", reportId: "r", year: 2026, week: 44 },
  { kind: "collect-plan", reportId: "r", year: 2026, week: 44 },
  { kind: "collect-run", runId: "run-a" },
  { kind: "collect-run", runId: "run-b" },
  { kind: "intent-declined" },
  { kind: "confirm-intent", intent: "synthesize" },
  { kind: "offer-help-generate" },
];
const BODIES = ["确认", "不是", "已取消本周周报发送", "需要", "hello"];
const AUTHORS = ["user", "assistant", "system"];

function thread(seed: number, length: number): Row[] {
  let state = seed;
  const next = (count: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % count;
  };
  return Array.from({ length }, (_, index) => ({
    id: `c${index}`,
    authorType: AUTHORS[next(AUTHORS.length)]!,
    body: BODIES[next(BODIES.length)]!,
    payload: PAYLOADS[next(PAYLOADS.length)],
  }));
}

test("each comment's thread state matches a scan of the comments after it", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const comments = thread(seed, 1 + (seed % 30));
    const { byId, generateHelpConsumed } = commentThreadStates(comments);
    for (const comment of comments) {
      expect(byId.get(comment.id)).toEqual(scanned(comments, comment));
    }
    expect(generateHelpConsumed).toBe(
      comments.some(
        (row) => row.authorType === "user" && looksLikeMemberGenerateOfferAccept(row.body),
      ),
    );
  }
});

test("the thread lists comments and messages by time, a comment first on a tie", () => {
  const comments = [
    { id: "a", createdAt: "2026-10-31T01:00:00Z" },
    { id: "b", createdAt: "2026-10-31T03:00:00Z" },
  ];
  const messages = [
    { id: "x", createdAt: "2026-10-31T01:00:00Z" },
    { id: "y", createdAt: "2026-10-31T02:00:00Z" },
  ];
  expect(sideTimeline(comments, messages).map((item) => item.id)).toEqual([
    "comment:a",
    "dm:x",
    "dm:y",
    "comment:b",
  ]);
});
