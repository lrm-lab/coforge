import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  openingPosition,
  savedPosition,
  savePosition,
  setSendAsTask,
  toggleExpanded,
  useMessageExpanded,
  useSendAsTask,
} from "#src/features/conversations/conversation-view-memory";
import {
  ConversationUiStoreProvider,
  createConversationUiStore,
  useMessageHighlighted,
  useQuotedDraft,
} from "#src/features/conversations/conversation-ui-store";

function Pane() {
  const expanded = useMessageExpanded("m-remount");
  return <i>{expanded ? "m-remount" : ""}</i>;
}

test("a long message opened in one pane is still open in the pane that replaces it", () => {
  toggleExpanded("m-remount");
  expect(renderToStaticMarkup(<Pane />)).toContain("m-remount");
  toggleExpanded("m-remount");
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

test("useMessageExpanded tracks only its own key", () => {
  function Row({ id }: { id?: string }) {
    return <i>{String(useMessageExpanded(id))}</i>;
  }
  toggleExpanded("m-single");
  try {
    expect(renderToStaticMarkup(<Row id="m-single" />)).toBe("<i>true</i>");
    expect(renderToStaticMarkup(<Row id="m-other" />)).toBe("<i>false</i>");
    expect(renderToStaticMarkup(<Row />)).toBe("<i>false</i>");
  } finally {
    toggleExpanded("m-single");
  }
});

test("ConversationUiStore exposes quoted draft and per-message highlight slices", () => {
  const store = createConversationUiStore();
  function Probe() {
    const quoted = useQuotedDraft();
    const hit = useMessageHighlighted("m-1");
    const miss = useMessageHighlighted("m-2");
    return <i>{`${quoted?.text ?? ""}|${hit}|${miss}`}</i>;
  }
  expect(
    renderToStaticMarkup(
      <ConversationUiStoreProvider store={store}>
        <Probe />
      </ConversationUiStoreProvider>,
    ),
  ).toBe("<i>|false|false</i>");

  store.setState((current) => ({
    ...current,
    quotedDraft: { id: 1, text: "> quote" },
    jumpHighlightId: "m-1",
  }));
  expect(
    renderToStaticMarkup(
      <ConversationUiStoreProvider store={store}>
        <Probe />
      </ConversationUiStoreProvider>,
    ),
  ).toBe("<i>&gt; quote|true|false</i>");
});
