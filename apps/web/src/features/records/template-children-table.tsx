import { Link, useHydrated } from "@tanstack/react-router";

import { EmptyState } from "#src/components/ui/empty";
import { ActorName } from "#src/features/avatars/actor-name";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";

export type TemplateChild = {
  id: string;
  title: string;
  status: string;
  submittedAt: string | null;
  author: {
    userId: string;
    username: string;
    displayName: string;
    avatarUrl?: string | null;
  };
};

export type TemplateChildRow = {
  id: string;
  name: string;
  submitted: boolean;
  submittedAt: string | null;
};

export function isTemplateChildSubmitted(status: string): boolean {
  return status === "submitted";
}

export function templateChildRows(children: readonly TemplateChild[]): TemplateChildRow[] {
  return children.map((child) => ({
    id: child.id,
    name: child.author.displayName,
    submitted: isTemplateChildSubmitted(child.status),
    submittedAt: child.submittedAt,
  }));
}

export function TemplateChildrenTable({ children }: { children: readonly TemplateChild[] }) {
  const hydrated = useHydrated();
  const workspaceSlug = useWorkspaceSlug();
  const timeZone = useTimeZone();
  const timeFormat = useTimeFormat();
  const locale = getLocale();
  const rows = templateChildRows(children);
  const authors = new Map(children.map((child) => [child.id, child.author]));

  return (
    <div className="overflow-x-auto rounded-lg border border-secondary">
      <table className="w-full min-w-[36rem] border-collapse text-start text-sm text-primary">
        <thead>
          <tr className="border-b border-secondary">
            <th className="border-e border-secondary px-3 py-2 font-medium whitespace-nowrap">
              {m.records_template_col_name()}
            </th>
            <th className="border-e border-secondary px-3 py-2 font-medium whitespace-nowrap">
              {m.records_template_col_submitted()}
            </th>
            <th className="px-3 py-2 font-medium whitespace-nowrap">
              {m.records_template_col_submit_time()}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="p-0">
                <EmptyState size="row" title={m.empty_records_member_reports_empty()} />
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const author = authors.get(row.id);
              const name = (
                <ActorName
                  actor={{
                    kind: "user",
                    id: author?.userId,
                    name: row.name,
                    avatarUrl: author?.avatarUrl,
                  }}
                />
              );
              return (
                <tr key={row.id} className="border-b border-secondary last:border-b-0">
                  <td className="border-e border-secondary px-3 py-2">
                    {row.submitted ? (
                      <Link
                        to="/w/$workspaceSlug/records/$recordId"
                        params={{ workspaceSlug, recordId: row.id }}
                        search={(previous) => ({
                          tab: previous.tab === "notes" ? "notes" : "weekly",
                        })}
                        className="text-brand-secondary hover:underline"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="text-tertiary">{name}</span>
                    )}
                  </td>
                  <td className="border-e border-secondary px-3 py-2 whitespace-nowrap">
                    {row.submitted
                      ? m.records_template_enabled_yes()
                      : m.records_template_enabled_no()}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {row.submittedAt ? (
                      <time dateTime={new Date(row.submittedAt).toISOString()}>
                        {hydrated
                          ? formatDateForDisplay(row.submittedAt, timeZone, locale, timeFormat)
                          : "\u00A0"}
                      </time>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
