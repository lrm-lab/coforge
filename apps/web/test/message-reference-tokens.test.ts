import { expect, test } from "bun:test";

import {
  patternAlternation,
  rehypeReferenceChips,
} from "#src/features/conversations/message-markdown";
import { CHANNEL_CHIP_CLASS } from "#src/features/conversations/message-reference-chips";
import { escapeLiteralHtml } from "#src/lib/message-syntax";

function text(value: string) {
  return { type: "text", value };
}

function paragraph(children: unknown[]) {
  return { type: "element", tagName: "p", properties: {}, children };
}

const CHANNEL_ID = "33333333-3333-4333-8333-333333333333";
const CHANNEL_TOKEN = `<@channel:${CHANNEL_ID}:product>`;

function channelChipify(children: unknown[], currentNames?: ReadonlyMap<string, string>) {
  const tree = { type: "root", children } as never;
  rehypeReferenceChips({ mentions: new Map(), channelNames: currentNames })(tree);
  return tree as { children: Array<{ children: Array<Record<string, unknown>> }> };
}

test("a channel token keeps its angle brackets through the HTML escape", () => {
  expect(escapeLiteralHtml(`see ${CHANNEL_TOKEN} now`)).toBe(`see ${CHANNEL_TOKEN} now`);
});

test("a channel token becomes a chip carrying the channel id and its current name", () => {
  const tree = channelChipify(
    [paragraph([text(`see ${CHANNEL_TOKEN} now`)])],
    new Map([[CHANNEL_ID, "launch"]]),
  );
  const [before, chip, after] = tree.children[0]!.children;
  expect(before).toEqual(text("see "));
  expect(chip).toMatchObject({
    tagName: "span",
    properties: { className: CHANNEL_CHIP_CLASS.split(" "), "data-channel-id": CHANNEL_ID },
    children: [text("#launch")],
  });
  expect(after).toEqual(text(" now"));
});

test("a channel token whose id the Workspace does not have reads as plain #name, with no link", () => {
  // A token is a claim, checked against the Workspace's channels (closed ones included): an unknown
  // or forged id gets no chip and no link, only the name as text — what typing `#name` gives.
  const tree = channelChipify([paragraph([text(CHANNEL_TOKEN)])], new Map());
  expect(tree.children[0]!.children).toEqual([text("#product")]);
});

test("without a place to navigate from, a channel token reads as plain #name", () => {
  const tree = channelChipify([paragraph([text(`see ${CHANNEL_TOKEN}`)])]);
  expect(tree.children[0]!.children).toEqual([text("see "), text("#product")]);
});

test("a channel token inside a link reads as plain #name, never a link in a link", () => {
  const tree = channelChipify(
    [
      paragraph([
        {
          type: "element",
          tagName: "a",
          properties: { href: "/x" },
          children: [text(CHANNEL_TOKEN)],
        },
      ]),
    ],
    new Map(),
  );
  const link = tree.children[0]!.children[0]!;
  expect(link.children).toEqual([text("#product")]);
});

test("a channel token inside code, and a plain #name anywhere, stay as written", () => {
  const tree = channelChipify(
    [
      paragraph([
        { type: "element", tagName: "code", properties: {}, children: [text(CHANNEL_TOKEN)] },
        text(" and #product"),
      ]),
    ],
    new Map([[CHANNEL_ID, "product"]]),
  );
  const [code, prose] = tree.children[0]!.children;
  expect(code!.children).toEqual([text(CHANNEL_TOKEN)]);
  expect(prose).toEqual(text(" and #product"));
});

test("an alternation reads each match as its own pattern's groups, a `u` pattern included", () => {
  const { pattern, read } = patternAlternation([
    /<@x:(\d+)>/gi,
    /(?<![\p{L}])@(\p{L}+)/gu,
    /#([a-z]+)-(\d+)/g,
  ]);
  const reads = [..."ask @élodie about <@X:5> and #plan-2".matchAll(pattern)].map(read);
  expect(reads).toEqual([
    { index: 1, groups: ["élodie"] },
    { index: 0, groups: ["5"] },
    { index: 2, groups: ["plan", "2"] },
  ]);
});
