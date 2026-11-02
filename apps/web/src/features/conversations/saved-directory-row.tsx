import { Bookmark } from "@untitledui/icons";

import { cx } from "#src/utils/cx";
import { m } from "#src/paraglide/messages";
import { ConversationRow } from "./conversation-row";
import { useSavedEntries } from "./conversation-host";

/** The Chat list's Saved entry, at the top of the list, with how many messages are saved. */
export function SavedDirectoryRow({ current }: { current?: boolean }) {
  const savedCount = useSavedEntries()?.length;
  return (
    <ConversationRow
      target={{ view: "saved" }}
      current={current}
      count={
        savedCount
          ? { value: savedCount, label: m.conversation_saved_count({ count: savedCount }) }
          : undefined
      }
      label={m.conversation_saved_nav()}
      icon={
        <Bookmark
          aria-hidden="true"
          className={cx("size-4", current ? "text-brand-secondary" : "text-primary")}
        />
      }
    >
      {m.conversation_saved_nav()}
    </ConversationRow>
  );
}
