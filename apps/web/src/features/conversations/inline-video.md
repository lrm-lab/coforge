# Videos in messages

Part of [Conversations UI](AGENTS.md).

- A message's video plays in the message (`inline-video.tsx`) in the browser's own player
  (`<video controls>`, as on Raft; Frank, 2026-10-28: no special needs, so no player library), the
  size of a lone image, widened for its controls when narrower than 240px. Nothing is read until
  it comes within 160px of the screen.
- It shows its first frame and plays when the reader presses play, with sound, as on Raft (Frank,
  2026-10-28): nothing plays on its own. The page plays one video at a time
  (`inline-video-exclusive.ts`): playing one pauses another, and one scrolled off screen pauses.
- It streams from the signed delivery URL (`media-source.ts`), which the CDN serves with range
  requests; once the URL expires, the attachment route signs a fresh one and playback resumes where
  it was. Without delivery the whole file is read through the route, up to 50 MB; a larger one is a
  file card. A file the browser cannot read says so and offers the download; a failed load offers a
  retry too (`inlineVideoErrorOutcome`). A tap on the player never opens the message's action sheet.
- Expanding a video carries on in the preview from where the message's player was, playing if it
  played, and closing the preview carries its place back (`video-handoff.ts`, task #284; Telegram
  does the same). Both stream the same signed URL, which the CDN serves as `private, max-age=1800`,
  so the browser reuses what it already read; a file held in memory (no delivery) is handed over
  as it is rather than read again.
- Videos are not transcoded: an MP4 whose index sits at its end (no faststart) still plays, only
  starts later.
