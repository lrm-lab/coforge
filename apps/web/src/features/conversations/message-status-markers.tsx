import { Bookmark } from "@untitledui/icons";
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
