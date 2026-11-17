import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { sectionGaps } from "#src/features/records/report-editor/extensions/section-gap";

const schema = getSchema([StarterKit]);
const h = (level: number, text: string) =>
  schema.nodes.heading!.create({ level }, schema.text(text));
const p = (text?: string) => schema.nodes.paragraph!.create(null, text ? schema.text(text) : null);
const doc = (...nodes: ReturnType<typeof h>[]) => schema.nodes.doc!.create(null, nodes);

test("a template's headings alone leave room under each section but not under its title", () => {
  const summary = h(1, "Summary");
  const work = h(2, "Work Summary");
  const next = h(2, "Next Steps");
  const { open, empty } = sectionGaps(doc(summary, work, next));
  expect(open).toEqual([
    summary.nodeSize + work.nodeSize,
    summary.nodeSize + work.nodeSize + next.nodeSize,
  ]);
  expect(empty).toEqual([]);
});

test("a written section has no room; one only clicked into keeps its height", () => {
  const work = h(2, "Work Summary");
  const blank = p();
  const next = h(2, "Next Steps");
  const { open, empty } = sectionGaps(doc(work, blank, next, p("Ship #106")));
  expect(open).toEqual([]);
  expect(empty).toEqual([{ from: work.nodeSize, to: work.nodeSize + blank.nodeSize }]);
});

test("typing under the first heading leaves only the unwritten section its box", () => {
  const work = h(2, "Work Summary");
  const written = p("Shipped the gap");
  const next = h(2, "Next Steps");
  const { open, empty } = sectionGaps(doc(work, written, next));
  expect(open).toEqual([work.nodeSize + written.nodeSize + next.nodeSize]);
  expect(empty).toEqual([]);
});

test("the editor's trailing empty paragraph makes the last section's room an empty one", () => {
  const work = h(2, "Work Summary");
  const blank = p();
  const next = h(2, "Next Steps");
  const trailing = p();
  const { open, empty } = sectionGaps(doc(work, blank, next, trailing));
  expect(open).toEqual([]);
  const end = work.nodeSize + blank.nodeSize + next.nodeSize;
  expect(empty).toEqual([
    { from: work.nodeSize, to: work.nodeSize + blank.nodeSize },
    { from: end, to: end + trailing.nodeSize },
  ]);
});
