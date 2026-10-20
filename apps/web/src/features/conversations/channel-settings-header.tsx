import type { ReactNode } from "react";
import { Heading } from "react-aria-components";
import { ArrowLeft } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import type { ChannelMembersView } from "./channel-members-page";
import { useChannelMembers } from "./channel-members-query";

/**
 * The channel settings panel's header, on the settings and on the members pages alike. It has no
 * close button: Escape and a click outside close the panel, and a members page leads back with its
 * arrow. `SlideoutMenu.Header` always draws one, so these classes copy its frame
 * (slideout-menu.tsx); keep the two in sync.
 */
export function SettingsPanelHeader({ children }: { children: ReactNode }) {
  return (
    <header className="relative z-1 w-full border-b border-secondary px-4 pt-6 pb-4 md:px-6">
      {children}
    </header>
  );
}

/** The members page's header: Back (to the roster from the add view, else to the settings), its
 * title and, on the roster, the member count. No close button: Back is the way out. */
export function MembersPageHeading({
  channelId,
  view,
  takesFocus,
  onBack,
}: {
  channelId: string;
  view: ChannelMembersView;
  /** False when the roster returns focus to a row instead. */
  takesFocus: boolean;
  onBack: () => void;
}) {
  const members = useChannelMembers(channelId);
  const count = members.data ? members.data.humans.length + members.data.agents.length : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ButtonUtility
        icon={ArrowLeft}
        size="sm"
        color="tertiary"
        // Focus follows the view switch (the add view's search takes it instead).
        autoFocus={takesFocus && view === "members"}
        tooltip={view === "add" ? m.channel_members_back_to_members() : m.channel_members_back()}
        aria-label={view === "add" ? m.channel_members_back_to_members() : m.channel_members_back()}
        onClick={onBack}
      />
      <Heading slot="title" className="truncate text-lg font-semibold text-primary">
        {view === "add" ? m.channel_members_add_member() : m.channel_members_page_title()}
      </Heading>
      {view === "members" && count !== null && (
        <Badge size="sm" color="gray" className="shrink-0">
          {count}
        </Badge>
      )}
    </div>
  );
}
