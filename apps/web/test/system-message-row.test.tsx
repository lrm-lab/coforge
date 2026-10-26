import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SystemMessageRow } from "#src/features/conversations/system-message-row";

/**
 * A notice is one line (task #184): the ellipsis cuts the end of the body, so a long task title
 * is what gives way, never its number before it. On a touch screen the hover-only time is not
 * laid out, so the notice has the row's whole width.
 */
test("a notice is one line, and a touch screen gives the hover time's width to it", () => {
  const body =
    '📋 1 new task created: #183 "Revoke the realtime channel subscriptions of a member who lost access to the Workspace"';
  const markup = renderToStaticMarkup(
    <SystemMessageRow
      message={{
        id: "m1",
        sequence: 1,
        senderKind: "system",
        senderName: "",
        body,
        createdAt: "2026-10-26T12:00:00Z",
        attachments: [],
      }}
    />,
  );
  expect(markup).toContain("truncate");
  expect(markup).toContain("pointer-coarse:hidden");
  expect(markup.replaceAll("&quot;", '"')).toContain(body);
});
