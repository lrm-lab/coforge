import { expect, test } from "bun:test";

import {
  normalizeReportContent,
  orderedReportTabNames,
} from "#src/features/records/records-content";
import {
  alignMarkdownToSections,
  alignReportContentToSections,
  markdownToSections,
  normalizeLeaderFormatTabs,
  parseLevel2Blocks,
  resetLeaderFormatPage,
  parseTemplateSections,
  reportContentFromSections,
  sectionsFromReportContent,
  sectionsToMarkdown,
  serializeLevel2Blocks,
} from "#src/features/records/template-outline-sections";

test("parseTemplateSections accepts legacy string dimensions", () => {
  expect(parseTemplateSections(["Summary", "Research"])).toEqual([
    { title: "Summary", children: [] },
    { title: "Research", children: [] },
  ]);
});

test("parseTemplateSections accepts nested section objects", () => {
  expect(
    parseTemplateSections([
      { title: "Summary", children: ["Current Works", "Next Steps"] },
      { title: "Technique", children: [] },
    ]),
  ).toEqual([
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
});

test("sectionsToMarkdown and markdownToSections round-trip H1/H2", () => {
  const sections = [
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
    { title: "Achievements", children: [] },
    { title: "Research", children: [] },
  ];
  const markdown = sectionsToMarkdown(sections);
  expect(markdown).toBe(
    "# Summary\n## Current Works\n## Next Steps\n# Technique\n# Achievements\n# Research",
  );
  expect(markdownToSections(markdown)).toEqual(sections);
});

test("alignMarkdownToSections keeps body under matching headings", () => {
  const existing = "# Summary\nkept-a\n## Current Works\nkept-b\n# Old\ngone";
  const next = alignMarkdownToSections(existing, [
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
  expect(next).toBe("# Summary\nkept-a\n## Current Works\nkept-b\n## Next Steps\n# Technique");
});

test("reportContentFromSections uses each H1 as a tab and H2 as that tab's markdown", () => {
  const content = reportContentFromSections([
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
  expect(content).toEqual({
    tabs: {
      Summary: { markdown: "## Current Works\n## Next Steps" },
      Technique: { markdown: "" },
    },
    tabOrder: ["Summary", "Technique"],
  });
  expect(sectionsFromReportContent(content)).toEqual([
    { title: "Summary", children: ["Current Works", "Next Steps"] },
    { title: "Technique", children: [] },
  ]);
});

test("sectionsFromReportContent still reads a legacy single tab with H1 headings", () => {
  expect(
    sectionsFromReportContent({
      tabs: {
        Summary: { markdown: "# Summary\n## Current Works\n# Technique" },
      },
    }),
  ).toEqual([
    { title: "Summary", children: ["Current Works"] },
    { title: "Technique", children: [] },
  ]);
});

test("normalizeLeaderFormatTabs splits a legacy H1 document into tabs", () => {
  expect(
    normalizeLeaderFormatTabs({
      tabs: {
        Summary: { markdown: "# Summary\nkept-a\n## Current Works\nkept-b\n# Technique" },
      },
    }),
  ).toEqual({
    tabs: {
      Summary: { markdown: "kept-a\n## Current Works\nkept-b" },
      Technique: { markdown: "" },
    },
    tabOrder: ["Summary", "Technique"],
  });
});

test("alignReportContentToSections keeps bodies under matching H2 titles across tabs", () => {
  expect(
    alignReportContentToSections(
      {
        tabs: {
          Summary: { markdown: "kept-a\n## Current Works\nkept-b" },
        },
      },
      [
        { title: "Summary", children: ["Current Works", "Next Steps"] },
        { title: "Technique", children: [] },
      ],
    ),
  ).toEqual({
    tabs: {
      Summary: { markdown: "kept-a\n## Current Works\nkept-b\n## Next Steps" },
      Technique: { markdown: "" },
    },
    tabOrder: ["Summary", "Technique"],
  });
});

test("section builders preserve multi-tab order across jsonb key-length sorting", () => {
  const sections = [
    { title: "本周工作总结", children: ["已完成"] },
    { title: "下周计划", children: [] },
    { title: "A", children: [] },
  ];
  const created = reportContentFromSections(sections);
  expect(created.tabOrder).toEqual(["本周工作总结", "下周计划", "A"]);

  const afterJsonb = normalizeReportContent({
    tabs: {
      A: created.tabs!.A!,
      下周计划: created.tabs!.下周计划!,
      本周工作总结: created.tabs!.本周工作总结!,
    },
    tabOrder: created.tabOrder,
  });
  expect(orderedReportTabNames(afterJsonb)).toEqual(["本周工作总结", "下周计划", "A"]);
  expect(sectionsFromReportContent(afterJsonb)).toEqual(sections);

  const aligned = alignReportContentToSections(afterJsonb, [
    { title: "本周工作总结", children: ["已完成"] },
    { title: "A", children: [] },
    { title: "下周计划", children: [] },
  ]);
  expect(aligned.tabOrder).toEqual(["本周工作总结", "A", "下周计划"]);
});

test("resetLeaderFormatPage clears the current page body and leaves other pages", () => {
  expect(
    resetLeaderFormatPage(
      {
        tabs: {
          Summary: { markdown: "## Current Works\ncurrent work\n## Next Steps\nfuture work" },
          Research: { markdown: "## Papers\nkeep me" },
        },
        assignment: { unread: true },
      },
      "Summary",
    ),
  ).toEqual({
    tabs: {
      Summary: { markdown: "## Current Works\n## Next Steps" },
      Research: { markdown: "## Papers\nkeep me" },
    },
    assignment: { unread: true },
  });
});

test("parseLevel2Blocks and serializeLevel2Blocks round-trip H2 cards", () => {
  const markdown = "## Current Works\nplease fill\n## Next Steps\n";
  const blocks = parseLevel2Blocks(markdown);
  expect(blocks).toEqual([
    { title: "Current Works", body: "please fill" },
    { title: "Next Steps", body: "" },
  ]);
  expect(parseLevel2Blocks(serializeLevel2Blocks(blocks))).toEqual(blocks);
});
