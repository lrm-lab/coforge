import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityItemIcon } from "#src/features/inbox/activity-inbox-row";
import type { ActivityInboxItem } from "#src/server/inbox/activity-inbox.server";

/**
 * A DM's row in Activity shows the peer's face, and so does a thread in that DM: the row is named
 * by the same peer, so a thread is no reason to fall back to a blank person glyph.
 */
const dm = (thread: boolean) =>
  ({
    place: {
      kind: "direct",
      peer: {
        kind: "people",
        userId: "u2",
        displayName: "Jordan Lee",
        avatarUrl: "/avatars/person-2-1.webp",
      },
    },
    thread: thread ? { rootMessageId: "m1" } : null,
  }) as unknown as ActivityInboxItem;

test("a DM and a thread in it both show the peer's avatar", () => {
  for (const thread of [false, true]) {
    const markup = renderToStaticMarkup(<ActivityItemIcon item={dm(thread)} />);
    expect(markup).toContain("/avatars/person-2-1.webp");
  }
});
