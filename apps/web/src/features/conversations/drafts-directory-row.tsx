import { Edit03 } from "@untitledui/icons";

import { ListIconTile } from "#src/components/ui/list-icon-tile";
import { m } from "#src/paraglide/messages";
import { ConversationRow } from "./conversation-row";
import { useDraftCount } from "./use-drafts";
import { useDraftsOn } from "./use-drafts-on";

export function DraftsDirectoryRow({ current }: { current?: boolean }) {
  return useDraftsOn() ? <DraftsRow current={current} /> : null;
}

function DraftsRow({ current }: { current?: boolean }) {
  const count = useDraftCount();
  return (
    <ConversationRow
      target={{ view: "drafts" }}
      current={current}
      count={count ? { value: count, label: m.conversation_drafts_count({ count }) } : undefined}
      label={m.conversation_drafts_nav()}
      icon={<ListIconTile icon={Edit03} tone={current ? "brand" : "default"} />}
    >
      {m.conversation_drafts_nav()}
    </ConversationRow>
  );
}
