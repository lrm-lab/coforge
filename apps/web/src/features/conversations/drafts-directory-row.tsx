import { Edit03 } from "@untitledui/icons";

import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { ConversationRow } from "./conversation-row";
import { useDraftCount } from "./use-drafts";
import { useDraftsOn } from "./use-drafts-on";

/** The Chat list's Drafts entry, under Saved, while the Drafts experiment is on. A component of its
 * own so a keystroke in a composer renders this row when the count moves, not the directory around
 * it. */
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
      icon={
        <Edit03
          aria-hidden="true"
          className={cx("size-4", current ? "text-brand-secondary" : "text-primary")}
        />
      }
    >
      {m.conversation_drafts_nav()}
    </ConversationRow>
  );
}
