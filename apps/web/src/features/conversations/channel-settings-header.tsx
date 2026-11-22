import { ArrowLeft } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import type { ChannelMembersView } from "./channel-members-page";
import { useChannelMembers } from "./channel-members-query";

export function MembersPageHeading({
  channelId,
  view,
  takesFocus,
  onBack,
}: {
  channelId: string;
  view: ChannelMembersView;
  takesFocus: boolean;
  onBack: () => void;
}) {
  const members = useChannelMembers(channelId);
  const count = members.data ? members.data.humans.length + members.data.agents.length : null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-secondary px-4 py-2.5 md:px-6">
      <ButtonUtility
        icon={ArrowLeft}
        size="sm"
        color="tertiary"
        className="-ml-1.5"
        autoFocus={takesFocus && view === "members"}
        tooltip={view === "add" ? m.channel_members_back_to_members() : m.channel_members_back()}
        aria-label={view === "add" ? m.channel_members_back_to_members() : m.channel_members_back()}
        onClick={onBack}
      />
      <h3 className="truncate text-md font-semibold text-primary">
        {view === "add" ? m.channel_members_add_member() : m.channel_members_page_title()}
      </h3>
      {view === "members" && count !== null && (
        <Badge size="sm" color="gray" className="shrink-0">
          {count}
        </Badge>
      )}
    </div>
  );
}
