import { useCallback, useEffect, useState } from "react";

import type { ArtifactCommentView } from "./artifact-comment-queries";
import type { ArtifactCommenting, CommentTarget } from "./artifact-commenting";
import { useCommentHandoff } from "./use-comment-handoff";

export function useThreadReveal({
  shown,
  shownPath,
  commentsOpen,
  openFile,
  openThread,
}: {
  shown: {
    latest: number;
    pinned: number | null;
    pinFailed: boolean;
    shownVersion: number;
    pin: (version: number) => void;
  };
  shownPath: string | undefined;
  commentsOpen: boolean;
  openFile: (path: null) => void;
  openThread: (target: CommentTarget) => boolean;
}) {
  const { latest, pinned, pinFailed, shownVersion, pin } = shown;
  const [reveal, postReveal, consumeReveal] = useCommentHandoff<CommentTarget>(
    (target) => commentsOpen && target.path === shownPath && target.version === shownVersion,
  );
  const [revealing, setRevealing] = useState<CommentTarget | null>(null);
  const revealThread = useCallback<ArtifactCommenting["revealThread"]>(
    (target) => {
      if (target.version !== shownVersion) openFile(null);
      setRevealing(target);
      pin(target.version);
    },
    [shownVersion, openFile, pin],
  );
  useEffect(() => {
    if (revealing === null) return;
    const pinnedForTarget = revealing.version === latest ? null : revealing.version;
    if (pinFailed || pinned !== pinnedForTarget) return setRevealing(null);
    if (revealing.version !== shownVersion) return;
    setRevealing(null);
    if (openThread(revealing)) postReveal(revealing);
  }, [revealing, latest, pinned, shownVersion, pinFailed, openThread, postReveal]);
  return { reveal, consumeReveal, revealThread };
}

export function useRevealOnArrival(
  commentId: string | undefined,
  arrival: string | undefined,
  comments: readonly ArtifactCommentView[],
  revealThread: ArtifactCommenting["revealThread"],
) {
  const [arriving, setArriving] = useState<string | null>(null);
  useEffect(() => {
    setArriving(commentId ?? null);
  }, [commentId, arrival]);
  useEffect(() => {
    if (arriving === null) return;
    const comment = comments.find(({ id }) => id === arriving);
    if (!comment) return;
    setArriving(null);
    const root =
      comment.replyTo === null ? comment : comments.find(({ id }) => id === comment.replyTo);
    if (!root || "deleted" in root || root.path === null) return;
    revealThread({ version: root.version, path: root.path, anchor: root.anchor });
  }, [arriving, comments, revealThread]);
}
