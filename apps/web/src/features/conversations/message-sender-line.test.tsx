import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageSenderLine } from "./message-sender-line";
import type { MessageView } from "./message-view";

const sampleMessage = {
  id: "msg-1",
  senderKind: "human",
  senderUserId: "user-1",
  senderName: "Alex Mercer Long Name",
  senderAgentId: null,
  createdAt: "2026-11-25T02:00:00.000Z",
} as unknown as MessageView;

describe("MessageSenderLine", () => {
  test("reserves separator-row toolbar width statically only when hasToolbar is true", () => {
    const withToolbar = renderToStaticMarkup(
      <MessageSenderLine
        message={sampleMessage}
        displayName="Alex Mercer Long Name"
        deleted={false}
        onOpenSender={undefined}
        time="10:00"
        hasToolbar
      />,
    );
    expect(withToolbar).toContain(
      "lg:[@media(hover:hover)_and_(pointer:fine)]:[li:has(&gt;[role=separator])_&amp;]:pr-32",
    );
    expect(withToolbar).not.toContain("group-hover/message:pr-32");
    expect(withToolbar).not.toContain("group-focus-within/message:pr-32");

    const withoutToolbar = renderToStaticMarkup(
      <MessageSenderLine
        message={sampleMessage}
        displayName="Alex Mercer Long Name"
        deleted={false}
        onOpenSender={undefined}
        time="10:00"
        hasToolbar={false}
      />,
    );
    expect(withoutToolbar).toContain("pr-8");
    expect(withoutToolbar).not.toContain("pr-32");
  });
});
