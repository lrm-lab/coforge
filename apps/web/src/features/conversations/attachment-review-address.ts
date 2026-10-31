import { createContext, use, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";
import { z } from "zod";

/**
 * A file's review in the address, so a reload or a shared link reopens it: `file` names the
 * attachment whose review dialog is open over the conversation and `comment` the comment its
 * comments panel scrolls to. Each falls back to absent when malformed, like the page's other
 * fields. A link into a comment (Activity's) writes both; a card opened by hand writes `file`.
 */
export const attachmentReviewSearchShape = {
  file: z.uuid().optional().catch(undefined),
  comment: z.uuid().optional().catch(undefined),
};

/** The fields as the loose `to: "."` navigation sees them: any route's search. */
type AttachmentReviewSearch = {
  file?: unknown;
  comment?: unknown;
  message?: string;
  msg?: string;
};

/**
 * The message a file's review lands on when its address is opened again: the top-level message the
 * card is in, set by its row. Absent for a reply (its thread is in the address already), the Files
 * tab and a hosted pane's own rows' replies.
 */
export const ReviewLanding = createContext<string | undefined>(undefined);

/** The one card that follows the address for each file: the first to ask. A file shown twice at
 * once (a thread root in the stream and in its open thread) opens one review, not two. Keyed by
 * file, valued by the asking card's token. */
const following = new Map<string, symbol>();

/**
 * Whether the address asks for this attachment's review, and at which comment, plus how a card
 * opened by hand writes it there (`show`) and how the review closes it (`clear`). Both replace the
 * entry, as closing a thread or a Task popup does, so neither becomes a Back stop.
 *
 * Opening by hand writes `file` and, where the address lands nowhere yet, the message the card is
 * in as the landing (`message`, or a host's `msg`; `ReviewLanding`), so a reload or a copied
 * address opens the same review. Closing takes off what the review put there: a link's landing
 * (kept while a review is named, `keepsLandingForReview`), or the one opening wrote, never one the
 * address had already (a thread shown alone is named by its `msg`). Reads only its two fields, so
 * another param changing re-renders no card.
 */
export function useAttachmentReviewAddress(attachmentId: string) {
  return useAttachmentReviewAddressAmong([attachmentId]);
}

/**
 * `useAttachmentReviewAddress` for a set of files shown together (a message's images): which of
 * them the address names (`fileId`), if any, and the same follow, release and clear, by file.
 */
export function useAttachmentReviewAddressAmong(attachmentIds: readonly string[]) {
  const router = useRouter();
  const landing = use(ReviewLanding);
  const token = useRef(Symbol("attachment review"));
  // Each a string or `undefined`, so an unrelated change re-renders nothing.
  const fileId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.file === "string" && attachmentIds.includes(search.file)
        ? search.file
        : undefined,
  });
  const commentId = useSearch({
    strict: false,
    select: (search) => (fileId && typeof search.comment === "string" ? search.comment : undefined),
  });
  // Whether the landing in the address was there before this review, so closing leaves it.
  const keepsLanding = useRef(false);
  const release = useCallback(() => {
    for (const [id, owner] of following) if (owner === token.current) following.delete(id);
  }, []);
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
          ...(keepsLanding.current ? {} : { message: undefined, msg: undefined }),
        }),
      }),
    [router],
  );
  const show = useCallback(
    (attachmentId: string) => {
      release();
      following.set(attachmentId, token.current);
      // A hosted pane (`open`) lands by `msg`, a conversation page by `message`.
      const current = router.state.location.search as AttachmentReviewSearch & { open?: unknown };
      const key = current.open ? "msg" : "message";
      keepsLanding.current = current[key] !== undefined;
      void router.navigate({
        to: ".",
        replace: true,
        resetScroll: false,
        search: (previous: AttachmentReviewSearch) => ({
          ...previous,
          file: attachmentId,
          comment: undefined,
          ...(landing && !keepsLanding.current ? { [key]: landing } : {}),
        }),
      });
    },
    [router, release, landing],
  );
  return {
    requested: fileId !== undefined,
    fileId,
    commentId,
    /** Takes the named file's review for this card, unless another card already follows it. */
    follow: () => {
      if (!fileId) return false;
      const owner = following.get(fileId);
      if (owner && owner !== token.current) return false;
      following.set(fileId, token.current);
      // A link's landing is the review's: closing takes it off.
      keepsLanding.current = false;
      return true;
    },
    release,
    show,
    clear,
  };
}

/** Whether a one-shot landing stays in the address after it is used: while a file's review is named
 * there, so a reload or a shared link lands on the file's message, whose card opens the review. */
export function keepsLandingForReview(search: { file?: unknown }) {
  return typeof search.file === "string";
}
