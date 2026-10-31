# Attachment review

Part of [Conversations UI](AGENTS.md).

- Attachment review (`attachment-review.tsx`) keeps the file and its comments together; comment reads/writes use `attachment-comments.functions.ts` and recheck original-conversation authority.
- The comments pane owns its draft and paged Query; a comment is one flat row (`attachment-comment-thread.tsx`) with no reply or reaction controls, as in Raft, until comments become the message thread's replies; the dialog owns the place a new comment is about and the preview's `AnchorSurface`, which locates and jumps to anchors (`attachment-comment-anchors.ts` is their one definition, shared with the server).
- As in Raft: whole-file comments (and those whose place is gone) first, then placed ones in document order; a comment is avatar, author and short time on one line, place and body, greyed under the pointer; nothing Raft lacks is added; Enter sends a comment or reply and Shift+Enter starts a new line.
