import type { Params } from "./artifact-page-bridge-core";
import type { CommentAnchor } from "./artifact-comment-inputs";
import {
  MARKS_MAX,
  MARK_LABEL_MAX,
  clipAnchor,
  parseFoundIds,
  parsePicked,
  type PageAnnotationMode,
  type PageMark,
  type PickedAnchor,
} from "./artifact-page-annotations";

export type PageAnnotationEvent =
  | ({ kind: "selected" } & PickedAnchor)
  | { kind: "unselected" }
  | { kind: "unanchorable" }
  | { kind: "found"; revision: number; ids: string[] }
  | { kind: "activated"; id: string };

type Listener = (event: PageAnnotationEvent) => void;

const OFF: PageAnnotationMode = { picking: false, selecting: false, showMarks: false };

export function createAnnotationChannel(
  send: (message: object) => void,
  userActive: () => boolean,
) {
  const listeners = new Set<Listener>();
  let mode = OFF;
  let revision = 0;
  let marks: PageMark[] = [];
  let knownIds = new Set<string>();
  let draft: CommentAnchor | null = null;

  const emit = (event: PageAnnotationEvent) => listeners.forEach((listener) => listener(event));
  const sendMode = () => send({ method: "coforge/annotate/mode", params: mode });
  const sendMarks = () =>
    send({
      method: "coforge/annotate/marks",
      params: {
        revision,
        marks: marks.map(({ id, anchor, count, label, draft }) => ({
          id,
          anchor,
          count,
          label,
          ...(draft ? { draft } : {}),
        })),
      },
    });
  const sendDraft = () => send({ method: "coforge/annotate/draft", params: { anchor: draft } });

  return {
    listen(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    configure(next: PageAnnotationMode) {
      if (
        next.picking === mode.picking &&
        next.selecting === mode.selecting &&
        next.showMarks === mode.showMarks
      )
        return;
      mode = next;
      sendMode();
    },
    setMarks(next: readonly PageMark[]): number {
      marks = next.slice(0, MARKS_MAX).map((mark) => ({
        ...mark,
        anchor: clipAnchor(mark.anchor),
        label: mark.label.slice(0, MARK_LABEL_MAX),
      }));
      knownIds = new Set(marks.map((mark) => mark.id));
      revision += 1;
      sendMarks();
      return revision;
    },
    setDraft(next: CommentAnchor | null) {
      draft = next && clipAnchor(next);
      sendDraft();
    },
    focus(id: string) {
      send({ method: "coforge/annotate/focus", params: { id } });
    },
    ready() {
      sendMode();
      if (marks.length > 0) sendMarks();
      if (draft) sendDraft();
    },
    notify(method: string, params: Params) {
      switch (method) {
        case "coforge/notifications/annotate-selected": {
          const picked = parsePicked(params);
          if (!picked) return;
          const admitted =
            picked.anchor.type === "element" ? mode.picking && userActive() : mode.selecting;
          if (!admitted) return;
          emit({ kind: "selected", ...picked });
          return;
        }
        case "coforge/notifications/annotate-unselected":
          if (mode.selecting) emit({ kind: "unselected" });
          return;
        case "coforge/notifications/annotate-unanchorable":
          if (mode.picking && userActive()) emit({ kind: "unanchorable" });
          return;
        case "coforge/notifications/annotate-found":
          if (params.revision === revision)
            emit({ kind: "found", revision, ids: parseFoundIds(params.ids, knownIds) });
          return;
        case "coforge/notifications/annotate-activated":
          if (mode.showMarks && typeof params.id === "string" && knownIds.has(params.id))
            emit({ kind: "activated", id: params.id });
          return;
        default:
          return;
      }
    },
  };
}
