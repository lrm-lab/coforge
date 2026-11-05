import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import {
  INBOX_PREVIEW_LIMIT,
  INBOX_PREVIEW_MAX_CHARS,
  inboxPreviewLimit,
  inboxPreviewLine,
  previewShowsWholeMessage,
} from "#src/daemon-runtime/inbox-preview";

const message = (overrides: Partial<AgentMessageDelivery> = {}): AgentMessageDelivery =>
  ({
    protocolMajor: 1,
    requestId: "request-1",
    messageId: "message-1",
    deliveryId: "delivery-1",
    sequence: 7,
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    agentId: "agent-1",
    body: "looks good to me",
    method: "agent:v1:message:deliver",
    target: "#coforge",
    latestSenderKind: "human",
    latestSenderHandle: "frank",
    attachmentCount: 0,
    ...overrides,
  }) as AgentMessageDelivery;

test("a preview is one indented line: sender, first sentence, folded", () => {
  expect(inboxPreviewLine(message())).toBe("@frank: looks good to me");
  expect(inboxPreviewLine(message({ body: "one line\nand another" }))).toBe(
    "@frank: one line and another",
  );
  expect(inboxPreviewLine(message({ body: "First sentence. Second one follows." }))).toBe(
    "@frank: First sentence. (truncated)",
  );
});

test("a long body is capped and marked, and a closing bracket cannot end the notice early", () => {
  const long = inboxPreviewLine(message({ body: "x".repeat(INBOX_PREVIEW_MAX_CHARS + 20) }))!;
  expect(long.startsWith("@frank: ")).toBe(true);
  expect(long.endsWith(" (truncated)")).toBe(true);
  expect(inboxPreviewLine(message({ body: "a ] b" }))).toBe("@frank: a \\] b");
});

test("the preview count comes from the environment, with 0 turning previews off", () => {
  expect(inboxPreviewLimit({})).toBe(INBOX_PREVIEW_LIMIT);
  expect(inboxPreviewLimit({ COFORGE_INBOX_PREVIEW_LIMIT: "2" })).toBe(2);
  expect(inboxPreviewLimit({ COFORGE_INBOX_PREVIEW_LIMIT: "0" })).toBe(0);
  expect(inboxPreviewLimit({ COFORGE_INBOX_PREVIEW_LIMIT: "-1" })).toBe(INBOX_PREVIEW_LIMIT);
  expect(inboxPreviewLimit({ COFORGE_INBOX_PREVIEW_LIMIT: "many" })).toBe(INBOX_PREVIEW_LIMIT);
});

test("only a whole, plain message counts as shown", () => {
  expect(previewShowsWholeMessage(message())).toBe(true);
  // Cut by sentence or length.
  expect(previewShowsWholeMessage(message({ body: "One. Two." }))).toBe(false);
  expect(previewShowsWholeMessage(message({ body: "x".repeat(200) }))).toBe(false);
  // Unknown or present attachments, App events, a tracked mention, an attachment target.
  expect(previewShowsWholeMessage(message({ attachmentCount: undefined }))).toBe(false);
  expect(previewShowsWholeMessage(message({ attachmentCount: 2 }))).toBe(false);
  expect(previewShowsWholeMessage(message({ source: "app" }))).toBe(false);
  expect(previewShowsWholeMessage(message({ mentionDelivery: {} as never }))).toBe(false);
  expect(previewShowsWholeMessage(message({ target: "attachment:abc" }))).toBe(false);
  // A system notice or an unprintable sender is never previewed.
  expect(inboxPreviewLine(message({ latestSenderKind: "system", latestSenderHandle: "" }))).toBe(
    undefined,
  );
  expect(inboxPreviewLine(message({ latestSenderHandle: "not a handle" }))).toBe(undefined);
  expect(previewShowsWholeMessage(message({ latestSenderKind: "system" }))).toBe(false);
});
