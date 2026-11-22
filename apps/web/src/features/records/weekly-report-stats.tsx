import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmptyState } from "#src/components/ui/empty";
import { RecordsWireframe } from "#src/components/ui/empty-wireframes";
import { PageHeader } from "#src/components/layout/page-header";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { formatNumber } from "#src/lib/format-number";
import { m } from "#src/paraglide/messages";
import type { loadWeeklyReportStats } from "./records.functions";
import { BackToRecords } from "./records-layout";
import { paginateRecordsMembers, RecordsMemberPagination } from "./records-member-pagination";

export type WeeklyStats = Awaited<ReturnType<typeof loadWeeklyReportStats>>;

export function WeeklyReportStats({
  stats,
  year,
  month,
}: {
  stats: WeeklyStats;
  year: number;
  month: number;
}) {
  const navigate = useNavigate({ from: "/w/$workspaceSlug/records/stats" });
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [year, month]);

  const pagination = paginateRecordsMembers(stats.members, page);

  function shiftMonth(delta: number) {
    const next = Temporal.PlainYearMonth.from({ year, month }).add({ months: delta });
    void navigate({
      search: (previous) => ({
        tab: previous.tab === "notes" ? "notes" : "weekly",
        year: next.year,
        month: next.month,
      }),
    });
  }

  return (
    <>
      <PageHeader
        heading={m.records_stats()}
        leading={<BackToRecords />}
        actions={
          <div className="flex items-center gap-1">
            <ButtonUtility
              size="sm"
              color="secondary"
              icon={ChevronLeft}
              className="*:data-icon:rtl:rotate-180"
              aria-label={m.records_stats_prev_month()}
              onClick={() => shiftMonth(-1)}
            />
            <span className="min-w-20 text-center text-sm font-medium whitespace-nowrap text-primary tabular-nums">
              {m.records_stats_month({ year, month })}
            </span>
            <ButtonUtility
              size="sm"
              color="secondary"
              icon={ChevronRight}
              className="*:data-icon:rtl:rotate-180"
              aria-label={m.records_stats_next_month()}
              onClick={() => shiftMonth(1)}
            />
          </div>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-primary">
        {pagination.total === 0 ? (
          <EmptyState
            picture={<RecordsWireframe accent={false} />}
            title={m.empty_records_stats_title()}
            description={m.empty_records_stats_description()}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-start text-sm">
                <thead className="border-b border-secondary bg-primary text-tertiary">
                  <tr>
                    <th className="px-4 py-3 text-xs font-semibold whitespace-nowrap sm:px-5">
                      {m.records_stats_member()}
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold whitespace-nowrap sm:px-5">
                      {m.records_stats_submitted()}
                    </th>
                    <th className="px-4 py-3 text-xs font-semibold whitespace-nowrap sm:px-5">
                      {m.records_stats_unsubmitted()}
                    </th>
                    {stats.weeks.map((week) => (
                      <th
                        key={week}
                        className="px-4 py-3 text-xs font-semibold whitespace-nowrap sm:px-5"
                      >
                        {m.records_stats_week({ week })}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-secondary">
                  {pagination.visible.map((member) => (
                    <tr key={member.userId}>
                      <td className="px-4 py-3 sm:px-5">
                        <div className="flex items-center gap-2">
                          <ActorAvatar
                            presence={false}
                            size="xs"
                            name={member.displayName}
                            alt=""
                            src={member.avatarUrl}
                          />
                          <span className="min-w-0 font-medium wrap-anywhere text-primary">
                            <bdi>{member.displayName}</bdi>
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-tertiary tabular-nums sm:px-5">
                        {formatNumber(member.submitted)}
                      </td>
                      <td className="px-4 py-3 text-tertiary tabular-nums sm:px-5">
                        {formatNumber(member.unsubmitted)}
                      </td>
                      {stats.weeks.map((week) => {
                        const submitted = member.weeks[week];
                        return (
                          <td key={week} className="px-4 py-3 sm:px-5">
                            {submitted === true ? (
                              <span className="inline-flex size-6 items-center justify-center rounded-full bg-success-secondary text-success-primary">
                                <Check aria-hidden="true" className="size-3.5" />
                              </span>
                            ) : (
                              <span className="text-tertiary">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <RecordsMemberPagination
              total={pagination.total}
              safePage={pagination.safePage}
              totalPages={pagination.totalPages}
              startIndex={pagination.startIndex}
              onPageChange={setPage}
              className="px-page py-4"
            />
          </>
        )}
      </div>
    </>
  );
}
