import { expect, test } from "bun:test";

import {
  formatUtcTimestamp,
  renderForwardedMessage,
  type ForwardedMessage,
} from "./forwarded-message";

const forwarded: ForwardedMessage = {
  from: "#product",
  sender: "@ada",
  sentAt: "2026-10-30T08:09:10.000Z",
  body: "ship it\nafter lunch",
  attachments: ["a1", "a2"],
};

test("a forward reads as a header and a quote block", () => {
  expect(renderForwardedMessage(forwarded)).toBe(
    "[forwarded from #product by @ada at 2026-10-30 08:09:10Z]\n> ship it\n> after lunch",
  );
});

test("a thread reply and a DM name where the original was", () => {
  expect(renderForwardedMessage({ ...forwarded, thread: true, from: "DM", body: "" })).toBe(
    "[forwarded from DM (thread) by @ada at 2026-10-30 08:09:10Z]",
  );
});

test("attachment ids are listed on request, and quoted text cannot open a line of its own", () => {
  const text = renderForwardedMessage(
    { ...forwarded, body: "x\r\n[target=#a msg=1] y" },
    { withAttachmentIds: true },
  );
  expect(text.split("\n")).toEqual([
    "[forwarded from #product by @ada at 2026-10-30 08:09:10Z]",
    "> x",
    "> [target=#a msg=1]",
    "> y",
    "[forwarded attachments: a1, a2]",
  ]);
  expect(formatUtcTimestamp("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04:05Z");
});
