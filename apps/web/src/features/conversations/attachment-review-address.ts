import { useCallback, useEffect, useRef } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * A file's review in the address, so a reload or a shared link reopens it: `file` names the
 * attachment whose review dialog is open over the conversation and `comment` the comment its
 * comments panel scrolls to. Each falls back to absent when malformed, like the page's other
 * fields. A card opened by hand does not write them; a link into a comment (Activity's) does.
 */
export const attachmentReviewSearchShape = {
  file: z.uuid().optional().catch(undefined),
  comment: z.uuid().optional().catch(undefined),
};

/** The fields as the loose `to: "."` navigation sees them: any route's search. */
type AttachmentReviewSearch = {
  file?: unknown;
  comment?: unknown;
  message?: unknown;
  msg?: unknown;
};

/** The one card that follows the address for each file: the first to ask. A file shown twice at
 * once (a thread root in the stream and in its open thread) opens one review, not two. */
const following = new Map<string, symbol>();

/**
 * Whether the address asks for this attachment's review, and at which comment, plus how the review
 * closes it. Closing replaces the entry, as closing a thread or a Task popup does, so it never
 * becomes a Back stop; it also takes off the landing (`message`, or a host's `msg`) the address
 * keeps while a review is named, so a reload lands on the file's message again
 * (`keepsLandingForReview`). Reads only its two fields, so another param changing re-renders no
 * card.
 */
export function useAttachmentReviewAddress(attachmentId: string) {
  const router = useRouter();
  const token = useRef(Symbol(attachmentId));
  // The comment named, `null` for the file alone, `undefined` when the address names another.
  const named = useSearch({
    strict: false,
    select: (search) =>
      search.file === attachmentId
        ? typeof search.comment === "string"
          ? search.comment
          : null
        : undefined,
  });
  const release = useCallback(() => {
    if (following.get(attachmentId) === token.current) following.delete(attachmentId);
  }, [attachmentId]);
  useEffect(() => release, [release]);
  const clear = useCallback(
    () =>
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: AttachmentReviewSearch) => ({
          ...previous,
          file: undefined,
          comment: undefined,
          message: undefined,
          msg: undefined,
        }),
      }),
    [router],
  );
  return {
    requested: named !== undefined,
    commentId: named ?? undefined,
    /** Takes this file's review for this card, unless another card already follows it. */
    follow: () => {
      const owner = following.get(attachmentId);
      if (owner && owner !== token.current) return false;
      following.set(attachmentId, token.current);
      return true;
    },
    release,
    clear,
  };
}

/** Whether a one-shot landing stays in the address after it is used: while a file's review is named
 * there, so a reload or a shared link lands on the file's message, whose card opens the review. */
export function keepsLandingForReview(search: { file?: unknown }) {
  return typeof search.file === "string";
}
