import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { toggleExpanded } from "#src/features/conversations/conversation-view-memory";
import {
  MessageExpansionContext,
  useExpansion,
} from "#src/features/conversations/message-expansion-context";

function Probe({ expansionKey }: { expansionKey?: string }) {
  const { expanded, collapsible } = useExpansion(expansionKey);
  return <i>{`${expanded}/${collapsible}`}</i>;
}

const shared = (expanded: string[], collapsible: boolean, toggled: string[] = []) => ({
  expanded: new Set(expanded),
  toggle: (key: string) => void toggled.push(key),
  collapsible,
});

test("a forwarded original reads its own key from the conversation's expansion", () => {
  const html = renderToStaticMarkup(
    <MessageExpansionContext.Provider value={shared(["m1:forward:1"], true)}>
      <Probe expansionKey="m1:forward:0" />
      <Probe expansionKey="m1:forward:1" />
    </MessageExpansionContext.Provider>,
  );
  expect(html).toBe("<i>false/true</i><i>true/true</i>");
});

test("the viewer's preference reaches the card, and the card toggles its own key", () => {
  const toggled: string[] = [];
  let toggle = () => {};
  function Grab() {
    toggle = useExpansion("m2:forward:0").toggle;
    return null;
  }
  const html = renderToStaticMarkup(
    <MessageExpansionContext.Provider value={shared([], false, toggled)}>
      <Probe expansionKey="m2:forward:0" />
      <Grab />
    </MessageExpansionContext.Provider>,
  );
  toggle();
  expect(html).toBe("<i>false/false</i>");
  expect(toggled).toEqual(["m2:forward:0"]);
});

test("outside a conversation (the Forward dialog's preview) a card folds on its own", () => {
  expect(renderToStaticMarkup(<Probe />)).toBe("<i>false/true</i>");
});

test("when the provider omits an expanded set, useExpansion reads per-key expansion from view memory", () => {
  toggleExpanded("m3:forward:1");
  try {
    const html = renderToStaticMarkup(
      <MessageExpansionContext.Provider value={{ toggle: toggleExpanded, collapsible: true }}>
        <Probe expansionKey="m3:forward:0" />
        <Probe expansionKey="m3:forward:1" />
      </MessageExpansionContext.Provider>,
    );
    expect(html).toBe("<i>false/true</i><i>true/true</i>");
  } finally {
    toggleExpanded("m3:forward:1");
  }
});
