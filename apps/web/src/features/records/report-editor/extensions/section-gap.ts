import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/** Where a heading's section has nothing written yet: `open` is the position right after a heading
 * followed by a heading of its own level or above, or by the end; `empty` is a lone empty paragraph that is all of a
 * section's body (someone clicked into the room and has not typed yet). */
export function sectionGaps(doc: ProseMirrorNode): {
  open: number[];
  empty: { from: number; to: number }[];
} {
  const open: number[] = [];
  const empty: { from: number; to: number }[] = [];
  const isHeading = (node: ProseMirrorNode | null) => node?.type.name === "heading";
  let pos = 0;
  for (let index = 0; index < doc.childCount; index++) {
    const node = doc.child(index);
    const next = index + 1 < doc.childCount ? doc.child(index + 1) : null;
    const afterNext = index + 2 < doc.childCount ? doc.child(index + 2) : null;
    if (isHeading(node)) {
      const end = pos + node.nodeSize;
      // A heading whose sub-headings follow is not empty: they are its body.
      if (!next || (isHeading(next) && next.attrs.level <= node.attrs.level)) open.push(end);
      else if (
        next.type.name === "paragraph" &&
        next.content.size === 0 &&
        (!afterNext || (isHeading(afterNext) && afterNext.attrs.level <= node.attrs.level))
      )
        empty.push({ from: end, to: end + next.nodeSize });
    }
    pos += node.nodeSize;
  }
  return { open, empty };
}

/** A click in the room puts an empty paragraph there and the caret in it. */
function writeIntoGap(view: EditorView, at: number) {
  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return;
  const tr = view.state.tr.insert(at, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

const sectionGapKey = new PluginKey("sectionGap");

/**
 * Room to write under a heading with nothing under it yet (jing, task #106): a weekly report
 * starts as its template's headings alone, and a reader should not have to press Enter before
 * writing. The room is drawn, not written: the report's text stays the headings until someone
 * types, so opening a report does not change it. Only while editing.
 */
export const SectionGap = Extension.create({
  name: "sectionGap",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sectionGapKey,
        props: {
          decorations(state) {
            const { open, empty } = sectionGaps(state.doc);
            return DecorationSet.create(state.doc, [
              ...open.map((at) =>
                Decoration.widget(
                  at,
                  (view) => {
                    const room = document.createElement("div");
                    room.className = "section-gap";
                    room.setAttribute("aria-hidden", "true");
                    room.contentEditable = "false";
                    room.addEventListener("mousedown", (event) => {
                      if (!view.editable) return;
                      event.preventDefault();
                      writeIntoGap(view, at);
                    });
                    return room;
                  },
                  { side: -1, key: `section-gap-${at}`, ignoreSelection: true },
                ),
              ),
              ...empty.map(({ from, to }) =>
                Decoration.node(from, to, { class: "section-gap-empty" }),
              ),
            ]);
          },
        },
      }),
    ];
  },
});
