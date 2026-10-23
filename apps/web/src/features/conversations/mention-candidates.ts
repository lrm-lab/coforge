import { useMemo } from "react";

import type { Mentionable } from "./mention-text";

/**
 * The composer's @-completion candidates, or none where a mention stays plain text.
 *
 * The member list keeps every member, the viewer included, because it is also what *resolves* a
 * mention of the viewer in a body or preview. Offering the viewer to the viewer is a different
 * question, and the composer answers it with its own rule: you never mention yourself.
 */
export function useMentionCandidates(
  mentionables: readonly Mentionable[] | undefined,
  viewerId: string | undefined,
  enabled: boolean,
): readonly Mentionable[] | undefined {
  return useMemo(
    () =>
      enabled
        ? mentionables?.filter((mention) => !(mention.kind === "user" && mention.id === viewerId))
        : undefined,
    [enabled, mentionables, viewerId],
  );
}
