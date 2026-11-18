import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  openingPosition,
  savedPosition,
  savePosition,
  setSendAsTask,
  useSendAsTask,
} from "#src/features/conversations/conversation-view-memory";
import { useMessageExpansion } from "#src/features/conversations/use-message-expansion";

function Pane() {
  const { expandedMessages } = useMessageExpansion();
  return <i>{[...expandedMessages].join(",")}</i>;
}

test("a long message opened in one pane is still open in the pane that replaces it", () => {
  let toggle: (id: string) => void = () => {};
  function Grab() {
    toggle = useMessageExpansion().toggleExpandedMessage;
    return null;
  }
  renderToStaticMarkup(<Grab />);
  toggle("m-remount");
  expect(renderToStaticMarkup(<Pane />)).toContain("m-remount");
  toggle("m-remount");
  expect(renderToStaticMarkup(<Pane />)).not.toContain("m-remount");
});

test("a position is kept per conversation and thread, and following the latest forgets it", () => {
  savePosition("c1", { rowId: "r9", offset: -40 });
  savePosition("c1:thread:t1", { rowId: "r2", offset: 8 });
  expect(savedPosition("c1")).toEqual({ rowId: "r9", offset: -40 });
  expect(savedPosition("c1:thread:t1")).toEqual({ rowId: "r2", offset: 8 });
  savePosition("c1", undefined);
  expect(savedPosition("c1")).toBeUndefined();
  expect(savedPosition("c1:thread:t1")).toEqual({ rowId: "r2", offset: 8 });
});

test("a link, a jump or the Task popup's top wins over where the reader was, and where they were wins over the first unread", () => {
  const all = { hash: true, jump: true, top: true, saved: true, boundary: true };
  expect(openingPosition(all)).toBe("latest");
  expect(openingPosition({ ...all, hash: false })).toBe("jump");
  expect(openingPosition({ ...all, hash: false, jump: false })).toBe("top");
  expect(openingPosition({ ...all, hash: false, jump: false, top: false })).toBe("saved");
  const none = { hash: false, jump: false, top: false, saved: false, boundary: false };
  expect(openingPosition({ ...none, boundary: true })).toBe("boundary");
  expect(openingPosition(none)).toBe("latest");
});

test("Send as Task stays armed for its own draft through a remount, and only for that draft", () => {
  function Composer({ draftKey }: { draftKey: string }) {
    const [asTask] = useSendAsTask(draftKey);
    return <i>{String(asTask)}</i>;
  }
  setSendAsTask("c1", true);
  expect(renderToStaticMarkup(<Composer draftKey="c1" />)).toBe("<i>true</i>");
  expect(renderToStaticMarkup(<Composer draftKey="c2" />)).toBe("<i>false</i>");
  setSendAsTask("c1", false);
  expect(renderToStaticMarkup(<Composer draftKey="c1" />)).toBe("<i>false</i>");
});
