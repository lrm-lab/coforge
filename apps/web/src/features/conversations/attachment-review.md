# Attachment review

Part of [Conversations UI](AGENTS.md).

- Attachment review (`attachment-review.tsx`) keeps the file and its comments together; comment reads/writes use `attachment-comments.functions.ts` and recheck original-conversation authority.
- The comments pane owns its draft and paged Query; a comment is one flat row (`attachment-comment-thread.tsx`) with no reply or reaction controls, as in Raft, until comments become the message thread's replies; the dialog owns the place a new comment is about and the preview's `AnchorSurface`, which locates and jumps to anchors (`attachment-comment-anchors.ts` is their one definition, shared with the server).
- As in Raft: whole-file comments (and those whose place is gone) first, then placed ones in document order; a comment is avatar, author and short time on one line, place and body, greyed under the pointer; nothing Raft lacks is added; Enter sends a comment or reply and Shift+Enter starts a new line.
- The comment field's `@` lists the page conversation's members (`comment-members.tsx`, from `ConversationPageBody`; none where no page supplies them) and pins them as the message composer does, so a comment notifies exactly them (task #269).
- The address can name an open review (`file`, and `comment` to scroll to and mark; `attachment-review-address.ts`): Activity's comment items and Chat's link carry them, and a phone opens straight into the comments. While a review is named, the landing on the file's message stays in the address, so a reload opens it again; closing the review takes them all off (a replace). One card follows the address per file.
