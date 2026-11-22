import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CheckCircle } from "@untitledui/icons";

import { PageHeader } from "#src/components/layout/page-header";
import { EmptyState } from "#src/components/ui/empty";
import { RecordsWireframe } from "#src/components/ui/empty-wireframes";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";
import type { loadWeeklyReportDashboard } from "./records.functions";
import { BackToRecords } from "./records-layout";
import { paginateRecordsMembers, RecordsMemberPagination } from "./records-member-pagination";

type Dashboard = Awaited<ReturnType<typeof loadWeeklyReportDashboard>>;

export function WeeklyReportDashboard({ dashboard }: { dashboard: Dashboard }) {
  const workspaceSlug = useWorkspaceSlug();
  const [page, setPage] = useState(0);
  const latest = dashboard.weeks[0];
  const pagination = paginateRecordsMembers(dashboard.members, page);

  return (
    <>
      <PageHeader heading={m.records_dashboard()} leading={<BackToRecords />} />
      <div className="min-h-0 flex-1 overflow-auto bg-primary px-page py-5">
        <div className="mx-auto w-full max-w-6xl space-y-6">
          <div>
            <h2 className="text-md font-semibold text-primary">{m.records_dashboard_title()}</h2>
            <p className="mt-1 text-sm text-tertiary">{m.records_dashboard_hint()}</p>
          </div>
          {dashboard.weeks.length === 0 ? (
            <div className="rounded-xl border border-secondary py-6">
              <EmptyState
                picture={<RecordsWireframe accent={false} />}
                title={m.records_dashboard_empty()}
                description={m.empty_records_dashboard_description()}
              />
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric
                  label={m.records_dashboard_weeks()}
                  value={formatNumber(dashboard.weeks.length)}
                />
                <Metric
                  label={m.records_dashboard_members()}
                  value={formatNumber(pagination.total)}
                />
                <Metric
                  label={m.records_dashboard_latest_submitted()}
                  value={`${formatNumber(latest.submitted)}/${formatNumber(latest.total)}`}
                />
              </div>
              <div className="space-y-4">
                {pagination.visible.map((member) => (
                  <section
                    key={member.userId}
                    className="overflow-hidden rounded-xl border border-secondary bg-primary"
                  >
                    <div className="flex items-center gap-2 border-b border-secondary px-4 py-3">
                      <ActorAvatar
                        presence={false}
                        size="xs"
                        name={member.displayName}
                        alt=""
                        src={member.avatarUrl}
                        className="size-5 shrink-0"
                      />
                      <h3 className="min-w-0 font-semibold wrap-anywhere text-primary">
                        <bdi>{member.displayName}</bdi>
                      </h3>
                    </div>
                    <div className="grid divide-y divide-secondary md:grid-cols-3 md:divide-y-0">
                      {dashboard.weeks.map((week) => {
                        const report = week.reports.find((item) => item.authorId === member.userId);
                        return (
                          <div
                            key={`${member.userId}-${week.year}-${week.week}`}
                            className="min-w-0 border-secondary p-4 md:border-e md:nth-[3n]:border-e-0 md:nth-[n+4]:border-t"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-tertiary tabular-nums">
                                {week.year} W{week.week}
                              </span>
                              {report ? (
                                <CheckCircle
                                  aria-hidden="true"
                                  className="size-4 text-success-primary"
                                />
                              ) : null}
                            </div>
                            <p className="mt-2 line-clamp-3 min-h-10 text-sm wrap-anywhere text-primary">
                              {report?.summary || m.records_dashboard_not_submitted()}
                            </p>
                            {report ? (
                              <Link
                                to="/w/$workspaceSlug/records/$recordId"
                                params={{ workspaceSlug, recordId: report.id }}
                                search={{ tab: "weekly" }}
                                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-secondary hover:underline any-pointer-coarse:min-h-11"
                              >
                                {m.records_dashboard_open_report()}
                                <ArrowUpRight aria-hidden="true" className="size-3" />
                              </Link>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
              <RecordsMemberPagination
                total={pagination.total}
                safePage={pagination.safePage}
                totalPages={pagination.totalPages}
                startIndex={pagination.startIndex}
                onPageChange={setPage}
                className="pt-4"
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-secondary bg-primary p-4">
      <p className="text-xs text-tertiary">{label}</p>
      <p className="mt-1 text-display-xs font-semibold text-primary tabular-nums">{value}</p>
    </div>
  );
}
