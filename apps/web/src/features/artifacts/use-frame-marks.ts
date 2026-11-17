import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { m } from "#src/paraglide/messages";
import { useCommentDraftActions, useCommentDrafts } from "./artifact-comment-drafts-context";
import type { CommentAnchor } from "./artifact-comment-inputs";
import {
  useArtifactCommenting,
  useCommentRequests,
  useCommentThreads,
} from "./artifact-commenting";
import { isFrameAnchor, markPlaces, sameAnchor, type PageMark } from "./artifact-page-annotations";
import type { PageBridge } from "./artifact-page-bridge";

type Report = { revision: number; ids: readonly string[] };

function draftLabel(anchor: CommentAnchor) {
  const quote = typeof anchor.data.quote === "string" ? anchor.data.quote : "";
  return quote ? m.av_dr_mark_label({ quote }) : m.av_dr_mark_unnamed();
}

function markLabel(anchor: CommentAnchor, count: number) {
  const quote = typeof anchor.data.quote === "string" ? anchor.data.quote : "";
  return quote ? m.av_cm_mark_label({ count, quote }) : m.av_cm_mark_unnamed({ count });
}

export function useFrameMarks({
  bridge,
  composing,
  path,
}: {
  bridge: PageBridge;
  composing: RefObject<boolean>;
  path: string;
}) {
  const { commenting, panelOpen, publishPlaces, openThread } = useArtifactCommenting();
  const { drafts } = useCommentDrafts();
  const { openDraft } = useCommentDraftActions();
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const { reveal, consumeReveal } = useCommentRequests();
  const anchored = useCommentThreads();
  const [sentRevision, setSentRevision] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const active = commenting || panelOpen;

  const computed = useMemo<readonly PageMark[]>(() => {
    if (!active) return [];
    const threads = anchored.flatMap(({ root, replies }) => {
      if ("deleted" in root || root.path !== path || !isFrameAnchor(root.anchor)) return [];
      const count = 1 + replies.filter((reply) => !("deleted" in reply)).length;
      return [{ id: root.id, anchor: root.anchor, count, label: markLabel(root.anchor, count) }];
    });
    const unsent = drafts.flatMap((draft) =>
      draft.path === path && isFrameAnchor(draft.anchor)
        ? [
            {
              id: draft.id,
              anchor: draft.anchor,
              count: 0,
              label: draftLabel(draft.anchor),
              draft: true as const,
            },
          ]
        : [],
    );
    return [...threads, ...unsent];
  }, [active, anchored, drafts, path]);
  const held = useRef(computed);
  if (JSON.stringify(held.current) !== JSON.stringify(computed)) held.current = computed;
  const marks = held.current;

  useEffect(() => {
    setSentRevision(bridge.annotations.setMarks(marks));
  }, [bridge, marks]);

  useEffect(
    () =>
      bridge.annotations.listen((event) => {
        if (event.kind === "found") setReport({ revision: event.revision, ids: event.ids });
        else if (event.kind === "activated" && !composing.current) {
          const draft = draftsRef.current.find(({ id }) => id === event.id);
          if (draft) openDraft(draft);
          else openThread(event.id);
        }
      }),
    [bridge, composing, openThread, openDraft],
  );

  const foundIds = report && report.revision === sentRevision ? report.ids : null;
  const places = useMemo(() => markPlaces(marks, foundIds), [marks, foundIds]);
  useEffect(() => {
    publishPlaces(path, places);
  }, [publishPlaces, path, places]);
  useEffect(() => () => publishPlaces(path, null), [publishPlaces, path]);

  useEffect(() => {
    if (!reveal || reveal.path !== path || !reveal.anchor || !foundIds) return;
    const { anchor } = reveal;
    const target = marks.find((mark) => sameAnchor(mark.anchor, anchor));
    if (target && foundIds.includes(target.id)) bridge.annotations.focus(target.id);
    consumeReveal();
  }, [reveal, path, foundIds, marks, bridge, consumeReveal]);
}
