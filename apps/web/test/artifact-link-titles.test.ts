import { expect, test } from "bun:test";

import { bodyWithArtifactTitles } from "#src/features/artifacts/artifact-link";

const ID = "0198a7c2-1111-7222-8333-444455556666";
const LINK = `https://coforge.example/en/w/acme/channel/c1?doc=${ID}`;
const titles = new Map([[ID, "Launch plan"]]);

/** Task #385 (Frank): a document's long link in a message beside its card. */
test("a body that is only a document link reads as nothing beside its card", () => {
  expect(bodyWithArtifactTitles(`  ${LINK}\n`, titles)).toBe("");
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
