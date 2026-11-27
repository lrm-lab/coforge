import {
  Outlet,
  createFileRoute,
  useMatchRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { RecordsLayout, type RecordsTab } from "#src/features/records/records-layout";
import { RecordsPending } from "#src/features/records/records-pending";
import { loadRecordsCatalog } from "#src/features/records/records.functions";
import { latestWeeklyLanding } from "#src/features/records/records-sidebar";
import { catalogShouldReload } from "#src/features/records/use-record-refresh";
import { WeeklyReportsOff } from "#src/features/records/weekly-reports-off";
import {
  ensureWeeklyReportsEnabled,
  fetchWeeklyReportsEnabled,
  useWeeklyReportsEnabled,
} from "#src/features/records/weekly-reports-gate";
import { AppError, isAppErrorCode } from "#src/lib/app-error";

export const Route = createFileRoute("/w/$workspaceSlug/records")({
  validateSearch: (search: Record<string, unknown>): { tab: RecordsTab } => ({
    tab: search.tab === "notes" ? "notes" : "weekly",
  }),
  beforeLoad: async ({ context, preload, cause }) => {
    if (preload) return;
    const enabled =
      cause === "enter"
        ? await fetchWeeklyReportsEnabled(context.queryClient)
        : await ensureWeeklyReportsEnabled(context.queryClient);
    if (!enabled) {
      throw new AppError("ACCESS_DENIED");
    }
  },
  loader: () => loadRecordsCatalog(),
  shouldReload: catalogShouldReload,
  pendingComponent: RecordsPending,
  errorComponent: (props) =>
    isAppErrorCode(props.error, "ACCESS_DENIED") ? (
      <WeeklyReportsOff />
    ) : (
      <PageLoadError {...props} />
    ),
  component: RecordsPage,
});

function RecordsPage() {
  const catalog = Route.useLoaderData();
  const weeklyReports = useWeeklyReportsEnabled(true);
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const params = useParams({
    from: "/w/$workspaceSlug/records/$recordId",
    shouldThrow: false,
  });
  const weekParams = useParams({
    from: "/w/$workspaceSlug/records/weeks/$year/$week",
    shouldThrow: false,
  });
  const matchRoute = useMatchRoute();
  const selectedPanel = matchRoute({ to: "/w/$workspaceSlug/records/settings", fuzzy: false })
    ? "settings"
    : matchRoute({ to: "/w/$workspaceSlug/records/dashboard", fuzzy: false })
      ? "dashboard"
      : matchRoute({ to: "/w/$workspaceSlug/records/stats", fuzzy: false })
        ? "stats"
        : null;
  const routeRecordId = params?.recordId;
  const selectedWeekKey = weekParams ? `${weekParams.year}-${weekParams.week}` : undefined;
  const landing =
    tab === "weekly" && !selectedPanel && !routeRecordId && !selectedWeekKey
      ? latestWeeklyLanding({
          memberWeeks: catalog.memberWeeks,
        })
      : undefined;
  const landingReportId = landing?.kind === "report" ? landing.id : undefined;

  if (!weeklyReports) return <WeeklyReportsOff />;

  return (
    <RecordsLayout
      catalog={catalog}
      selectedRecordId={routeRecordId ?? landingReportId}
      selectedWeekKey={selectedWeekKey}
      detailOpen={Boolean(routeRecordId || selectedPanel || selectedWeekKey)}
      selectedPanel={selectedPanel}
      tab={tab}
      onTabChange={(next) => {
        void navigate({
          search: { tab: next },
          replace: true,
        });
      }}
    >
      <Outlet />
    </RecordsLayout>
  );
}
