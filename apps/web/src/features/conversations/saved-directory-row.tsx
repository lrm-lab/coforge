import { Bookmark } from "@untitledui/icons";

import { ListIconTile } from "#src/components/ui/list-icon-tile";
import { m } from "#src/paraglide/messages";
import { ConversationRow } from "./conversation-row";
import { useSavedEntries } from "./conversation-host";

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
      icon={<ListIconTile icon={Bookmark} tone={current ? "brand" : "default"} />}
    >
      {m.conversation_saved_nav()}
    </ConversationRow>
  );
}
