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

/** A click in the room puts an empty paragraph there and the caret in it. The paragraph is not
 * writing yet: it is no edit (`preventUpdate`, nothing to undo) until someone types in it. */
function writeIntoGap(view: EditorView, at: number) {
  const paragraph = view.state.schema.nodes.paragraph;
  if (!paragraph) return;
  const tr = view.state.tr.insert(at, paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, at + 1));
  tr.setMeta("preventUpdate", true).setMeta("addToHistory", false);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

/** Leaving a section's room without writing in it takes the empty paragraph away again, so
 * clicking in and out leaves the report as it was. `keep`: the caret, which may stay. */
function leaveUnwritten(view: EditorView, keep: number | null) {
  if (view.isDestroyed) return;
  const unwritten = sectionGaps(view.state.doc).empty.filter(
    ({ from, to }) => keep === null || keep < from || keep > to,
  );
  if (unwritten.length === 0) return;
  const tr = view.state.tr;
  for (const { from, to } of unwritten.reverse()) tr.delete(from, to);
  view.dispatch(tr.setMeta("preventUpdate", true).setMeta("addToHistory", false));
}

const sectionGapKey = new PluginKey("sectionGap");

/**
 * Room to write under a heading with nothing under it yet (jing, task #106): a weekly report
 * starts as its template's headings alone, and a reader should not have to press Enter before
 * writing. The room is drawn, not written: the report's text stays the headings until someone
 * types, so opening a report does not change it. Only while editing.
 */
export const SectionGap = Extension.create<{ placeholder: string }>({
  name: "sectionGap",
  addOptions() {
    return { placeholder: "" };
  },
  addProseMirrorPlugins() {
    // What the room says until someone writes in it (a weekly report draws it as an input box).
    const { placeholder } = this.options;
    return [
      new Plugin({
        key: sectionGapKey,
        view: () => ({
          update(view, prevState) {
            if (view.state.selection.eq(prevState.selection) || !view.hasFocus()) return;
            // Not while this update is still being applied.
            queueMicrotask(() => leaveUnwritten(view, view.state.selection.from));
          },
        }),
        props: {
          handleDOMEvents: {
            blur: (view) => {
              leaveUnwritten(view, null);
              return false;
            },
          },
          decorations(state) {
            const { open, empty } = sectionGaps(state.doc);
            return DecorationSet.create(state.doc, [
              ...open.map((at) =>
                Decoration.widget(
                  at,
                  (view) => {
                    const room = document.createElement("div");
                    room.className = "section-gap";
                    room.dataset.placeholder = placeholder;
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
                Decoration.node(from, to, {
                  class: "section-gap-empty",
                  "data-section-placeholder": placeholder,
                }),
              ),
            ]);
          },
        },
      }),
    ];
  },
});
