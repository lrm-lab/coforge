import { createFileRoute, notFound } from "@tanstack/react-router";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { RecordDetail } from "#src/features/records/record-detail";
import { loadRecordSubject } from "#src/features/records/records.functions";
import { sanitizeRecordsReturnTo } from "#src/features/records/records-return-to";
import { isAppError } from "#src/lib/app-error";

export const Route = createFileRoute("/w/$workspaceSlug/records/$recordId")({
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } => ({
    returnTo: sanitizeRecordsReturnTo(search.returnTo),
  }),
  ssr: "data-only",
  staleTime: 0,
  loader: async ({ params }) => {
    try {
      return await loadRecordSubject({ data: { id: params.recordId } });
    } catch (error) {
      if (isAppError(error) && error.code === "NOT_FOUND") throw notFound();
      throw error;
    }
  },
  errorComponent: PageLoadError,
  component: RecordDetailPage,
});

function RecordDetailPage() {
  const subject = Route.useLoaderData();
  const { returnTo } = Route.useSearch();
  return <RecordDetail subject={subject} returnTo={returnTo} />;
}
