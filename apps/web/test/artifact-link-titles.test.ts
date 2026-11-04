import { expect, test } from "bun:test";

import { bodyWithArtifactTitles } from "#src/features/artifacts/artifact-link";

const ID = "0198a7c2-1111-7222-8333-444455556666";
const LINK = `https://coforge.example/en/w/acme/channel/c1?doc=${ID}`;
const titles = new Map([[ID, "Launch plan"]]);

/** Task #385 (Frank): a document's long link in a message beside its card. */
test("a body that is only a document link reads as nothing beside its card", () => {
  expect(bodyWithArtifactTitles(`  ${LINK}\n`, titles)).toBe("");
});

/** Task #514 (Raft): a link on its own line above its card says the same thing twice. */
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
  // A ``` line inside a ~~~ fence does not close it.
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
