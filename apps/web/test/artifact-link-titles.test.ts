import { expect, test } from "bun:test";

import {
  analyzeBodyArtifacts,
  bodyWithArtifactTitles,
  splitBodyWithInlineEmbeds,
} from "#src/features/artifacts/artifact-link";

const ID = "0198a7c2-1111-7222-8333-444455556666";
const ID_B = "0198a7c2-1111-7222-8333-444455557777";
const LINK = `https://coforge.example/en/w/acme/channel/c1?doc=${ID}`;
const titles = new Map([[ID, "Launch plan"]]);

test("a body that is only a document link reads as nothing beside its card", () => {
  expect(bodyWithArtifactTitles(`  ${LINK}\n`, titles)).toBe("");
});

test("a line that is only a document link reads as nothing beside its card", () => {
  const other = `https://coforge.example/en/w/acme/channel/c1?doc=${ID.replace("4444", "9999")}`;
  expect(bodyWithArtifactTitles(`Both are up:\n${LINK}\n${other}\n`, titles)).toBe(
    `Both are up:\n${other}`,
  );
  const fenced = `\`\`\`\n${LINK}\n\`\`\``;
  expect(bodyWithArtifactTitles(fenced, titles)).toBe(fenced);
});

test("a document link in ~~~ fenced or indented code stays as written", () => {
  const tildes = `Run this:\n~~~\n${LINK}\n~~~`;
  expect(bodyWithArtifactTitles(tildes, titles)).toBe(tildes);
  const mixed = `~~~\n\`\`\`\n${LINK}\n~~~`;
  expect(bodyWithArtifactTitles(mixed, titles)).toBe(mixed);
  const indented = `Run this:\n\n    ${LINK}\n\t${LINK}`;
  expect(bodyWithArtifactTitles(indented, titles)).toBe(indented);
});

test("a document link among other words reads as the document's title, still a link", () => {
  expect(bodyWithArtifactTitles(`Draft is here: ${LINK} — have a look`, titles)).toBe(
    `Draft is here: [Launch plan](${LINK}) — have a look`,
  );
});

test("a link the writer named, an unknown document, and no card leave the body as written", () => {
  const named = `See [the plan](${LINK})`;
  expect(bodyWithArtifactTitles(named, titles)).toBe(named);
  const other = `See ${LINK.replace("4444", "9999")}`;
  expect(bodyWithArtifactTitles(other, titles)).toBe(other);
  expect(bodyWithArtifactTitles(LINK, new Map())).toBe(LINK);
});

test("a title's Markdown characters stay text", () => {
  expect(bodyWithArtifactTitles(`x ${LINK}`, new Map([[ID, "Q3 [draft]"]]))).toBe(
    `x [Q3 \\[draft\\]](${LINK})`,
  );
});

test("a sentence's last mark stays outside the link, and code and <link> stay as written", () => {
  expect(bodyWithArtifactTitles(`See ${LINK}.`, titles)).toBe(`See [Launch plan](${LINK}).`);
  const code = `Run \`open ${LINK}\`\n\`\`\`\n${LINK}\n\`\`\``;
  expect(bodyWithArtifactTitles(code, titles)).toBe(code);
  const angled = `See <${LINK}>`;
  expect(bodyWithArtifactTitles(angled, titles)).toBe(angled);
});

test("a link with a placeholder card drops its own line but keeps its place in a sentence", () => {
  const placeholders = new Set([ID]);
  expect(bodyWithArtifactTitles(`Have a look\n\n${LINK}`, new Map(), placeholders)).toBe(
    "Have a look",
  );
  const inline = `See ${LINK} first`;
  expect(bodyWithArtifactTitles(inline, new Map(), placeholders)).toBe(inline);
});

test("a standalone ?embed=1 artifact link drops its own line beside the inline embed", () => {
  const embedLink = `https://coforge.example/w/acme/artifacts/${ID}?embed=1&version=2`;
  expect(bodyWithArtifactTitles(`Chart:\n${embedLink}`, titles)).toBe("Chart:");
  expect(bodyWithArtifactTitles(`See ${embedLink} now`, titles)).toBe(
    `See [Launch plan](${embedLink}) now`,
  );
});

test("splitBodyWithInlineEmbeds places standalone ?embed=1 links inline between prose blocks", () => {
  const embedA = `https://coforge.example/w/acme/artifacts/${ID}?embed=1&version=2`;
  const cardB = `https://coforge.example/w/acme/artifacts/${ID_B}`;
  const allTitles = new Map([
    [ID, "Signup funnel"],
    [ID_B, "Spec doc"],
  ]);
  const result = splitBodyWithInlineEmbeds(
    `Intro paragraph.\n\n${embedA}\n\nConclusion referencing ${cardB}.`,
    new Set([ID]),
    allTitles,
  );
  expect(result).toEqual([
    { kind: "text", text: "Intro paragraph." },
    { kind: "embed", link: { id: ID, embed: true, version: 2 } },
    { kind: "text", text: `Conclusion referencing [Spec doc](${cardB}).` },
  ]);
});

test("splitBodyWithInlineEmbeds ignores embeds inside code blocks and deduplicates repeated standalone embeds", () => {
  const embedA = `https://coforge.example/w/acme/artifacts/${ID}?embed=1`;
  const result = splitBodyWithInlineEmbeds(
    `Example:\n\`\`\`\n${embedA}\n\`\`\`\n${embedA}\n${embedA}\nDone.`,
    new Set([ID]),
    new Map([[ID, "Widget"]]),
  );
  expect(result).toEqual([
    { kind: "text", text: `Example:\n\`\`\`\n${embedA}\n\`\`\`` },
    { kind: "embed", link: { id: ID, embed: true } },
    { kind: "text", text: "Done." },
  ]);
});

test("splitBodyWithInlineEmbeds returns only the embed segment for an embed-only message", () => {
  const embedA = `https://coforge.example/w/acme/artifacts/${ID}?embed=1`;
  expect(
    splitBodyWithInlineEmbeds(`  ${embedA}\n`, new Set([ID]), new Map([[ID, "Widget"]])),
  ).toEqual([{ kind: "embed", link: { id: ID, embed: true } }]);
});

test("analyzeBodyArtifacts computes segments, trailingLinks, and text block indices in one pass", () => {
  const embedA = `https://coforge.example/w/acme/artifacts/${ID}?embed=1&version=2`;
  const cardB = `https://coforge.example/w/acme/artifacts/${ID_B}`;
  const result = analyzeBodyArtifacts(
    `Short intro.\n\n${embedA}\n\nMuch longer detailed conclusion referencing ${cardB}.`,
    [
      { id: ID, embed: true, version: 2 },
      { id: ID_B, embed: false },
    ],
    new Set([ID]),
    new Map([
      [ID, "Funnel"],
      [ID_B, "Spec"],
    ]),
  );
  expect(result.segments).toEqual([
    { kind: "text", text: "Short intro." },
    { kind: "embed", link: { id: ID, embed: true, version: 2 } },
    { kind: "text", text: `Much longer detailed conclusion referencing [Spec](${cardB}).` },
  ]);
  expect([...result.inlineEmbedIds]).toEqual([ID]);
  expect(result.trailingLinks).toEqual([{ id: ID_B, embed: false }]);
  expect(result.lastTextIndex).toBe(2);
  expect(result.longestTextIndex).toBe(2);
  expect(result.hasText).toBe(true);
});
