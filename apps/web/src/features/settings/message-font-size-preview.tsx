import { useHydrated } from "@tanstack/react-router";
import { useMemo } from "react";

import type { ChipMention } from "#src/features/conversations/message-reference-chips";
import { MessageRow } from "#src/features/conversations/message-row";
import type { MessageView } from "#src/features/conversations/message-view";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

const SAMPLE_CHANNEL_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_CHANNEL_NAMES: ReadonlyMap<string, string> = new Map([
  [SAMPLE_CHANNEL_ID, "proj-uiux"],
]);
const SAMPLE_MENTIONS = new Map<string, ChipMention>([
  ["joy", { actorId: "sample-joy", handle: "joy", label: "Joy" }],
]);
const noop = () => {};

export function MessageFontSizePreview({
  senderName,
  senderAvatarUrl,
}: {
  senderName: string;
  senderAvatarUrl: string | null;
}) {
  const hydrated = useHydrated();
  const message = useMemo<MessageView>(
    () => ({
      id: "message-font-size-preview",
      sequence: 0,
      senderKind: "user",
      senderName,
      senderAvatarUrl,
      body: `@joy <@channel:${SAMPLE_CHANNEL_ID}:proj-uiux> ${m.preferences_message_font_size_sample()}`,
      createdAt: new Date(),
      attachments: [],
    }),
    [senderName, senderAvatarUrl],
  );
  if (!hydrated) return null;
  return (
    <ul
      inert
      aria-label={m.preferences_message_font_size_preview()}
      className="-mx-4 md:-mx-6 [&_.message-markdown-channel-reference]:[direction:ltr] [&_.message-markdown-channel-reference]:[unicode-bidi:isolate] [&_.message-markdown-mention]:[direction:ltr] [&_.message-markdown-mention]:[unicode-bidi:isolate]"
    >
      <MessageRow
        message={message}
        own={false}
        dayChanged={false}
        grouped={false}
        expanded={false}
        onToggleExpanded={noop}
        collapsible={false}
        dateLocale={getLocale()}
        plainMentions={SAMPLE_MENTIONS}
        channelNames={SAMPLE_CHANNEL_NAMES}
      />
    </ul>
  );
}
