import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { useLiveChannelRow } from "#src/features/conversations/sidebar-lists";

/**
 * Where a new Task goes, in the New task dialog's trail. A channel shows as the sidebar draws it:
 * its group avatar and its name without `#` (Frank, 11-10). The sidebar's rows live only in the
 * browser, so they are read here, in the open dialog, not by the dialog that stays mounted (and
 * is rendered on the server) while closed.
 */
export function TaskDialogWhere({ label, channelId }: { label: string; channelId?: string }) {
  const members = useLiveChannelRow(channelId ?? "")?.members;
  return (
    <span className="flex min-w-0 items-center gap-1.5 px-2.5">
      {members?.length ? <GroupAvatar members={members} className="avatar-group-xs" /> : null}
      <span className="truncate">{members ? label.replace(/^#/, "") : label}</span>
    </span>
  );
}
