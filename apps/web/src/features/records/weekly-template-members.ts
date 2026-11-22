import { formatIsoWeekday } from "#src/lib/dates";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

export type TemplateMemberOption = {
  userId: string;
  username: string;
  displayName: string | null;
  role?: string;
  avatarUrl?: string | null;
};

export function memberLabel(member: {
  displayName?: string | null;
  username?: string;
  role?: string;
}) {
  const name = humanLabel(member);
  const role =
    member.role === "owner"
      ? m.workspace_role_owner()
      : member.role === "admin"
        ? m.workspace_role_admin()
        : member.role === "member"
          ? m.workspace_role_member()
          : member.role;
  return role ? `${name} - ${role}` : name;
}

export function weekdayLabel(day: number) {
  const locale = getLocale();
  const style = locale.toLowerCase().startsWith("zh") ? "short" : "long";
  return formatIsoWeekday(day, locale, style);
}
