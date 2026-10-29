import { expect, test } from "bun:test";
import type { AgentAttachmentCommentsResponse } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import { handleAgentAttachmentCommentsGet } from "#src/routes/api/agent/v1/attachments/$attachmentId.comments";
import { attachmentMessageRefusal } from "#src/server/attachments/agent-attachment-messages.server";
import { agentComment } from "#src/server/attachments/agent-attachment-comments.server";

const ID = "9f0c5a52-1111-4222-8333-444455556666";
const PAGE: AgentAttachmentCommentsResponse = {
  ok: true,
  attachmentId: ID,
  viewer: {
    canComment: true,
    canResolve: true,
    resolveAction: { type: "reaction" as const, emoji: "✅" as const },
  },
  comments: [],
  hasOlder: false,
};

const ask = async (attachmentId: string, search: string, read = async () => PAGE) => {
  const seen: unknown[] = [];
  const response = await handleAgentAttachmentCommentsGet(
    new Request(
      `https://server.example/api/agent/v1/attachments/${attachmentId}/comments${search}`,
    ),
    attachmentId,
    async (options) => {
      seen.push(options);
      return read();
    },
  );
  return { response, seen };
};

test("a valid request reads with the id, the page size and the cursor", async () => {
  const { response, seen } = await ask(ID, "?limit=7&before=12");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(PAGE);
  expect(seen).toEqual([{ attachmentId: ID, limit: 7, before: 12 }]);
});

test("without a limit the page is the largest allowed one", async () => {
  expect((await ask(ID, "")).seen).toEqual([{ attachmentId: ID, limit: 100, before: undefined }]);
});

test("a bad id, limit or before is INVALID_INPUT and reads nothing", async () => {
  for (const [id, search] of [
    ["nope", ""],
    [ID, "?limit=0"],
    [ID, "?limit=101"],
    [ID, "?limit=x"],
    [ID, "?before=0"],
    [ID, "?before=1.5"],
  ] as const) {
    const { response, seen } = await ask(id, search);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, errorCode: "INVALID_INPUT" });
    expect(seen).toEqual([]);
  }
});

test("an attachment the Agent may not read is NOT_FOUND", async () => {
  const { response } = await ask(ID, "", async () => {
    throw new AppError("NOT_FOUND");
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ ok: false, errorCode: "NOT_FOUND" });
});

test("a reply target is refused with the top-level comment it should use", async () => {
  // The Web's attachment panel is one flat list: a reply would be stored where nobody sees it.
  const refusal = attachmentMessageRefusal(
    new AppError("INVALID_INPUT", { errorId: "attachment-comments-no-replies" }),
  );
  expect(refusal?.status).toBe(400);
  expect(await refusal?.json()).toEqual({
    error: `attachment comments have no replies; comment on the attachment itself with --target 'attachment:<id>'`,
    code: "INVALID_INPUT",
    retryable: false,
  });
});

test("Agent comment output does not expose the human reply target", () => {
  const output = agentComment({
    id: "comment",
    sequence: 1,
    senderKind: "user",
    senderName: "Frank",
    senderHandle: null,
    body: "hello",
    mentions: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    reactions: [],
    anchor: null,
    resolved: false,
    replyTarget: "attachment:file:comment",
    replyCount: 0,
  } as never);
  expect(output).not.toHaveProperty("replyTarget");
});
