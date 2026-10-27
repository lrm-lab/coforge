import { Bookmark, Check } from "@untitledui/icons";
import { BadgeWithIcon } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";

export function SavedMessageMarker() {
  return (
    <div className="flex pt-0.5">
      <BadgeWithIcon type="color" color="brand" size="sm" iconLeading={Bookmark}>
        {m.conversation_saved_marker()}
      </BadgeWithIcon>
    </div>
  );
}

export function AgentReadReceipt() {
  return (
    <div className="message-text flex items-center justify-end gap-1 font-mono text-xs leading-4 text-tertiary">
      <Check aria-hidden="true" className="size-3" />
      {m.conversation_read()}
    </div>
  );
}
