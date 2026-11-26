import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { PageLoadError } from "#src/features/errors/page-load-error";
import { FeedbackInboxPage } from "#src/features/feedback/feedback-inbox-page";
import { loadFeedbackInbox } from "#src/features/feedback/feedback.functions";
import { FEEDBACK_STATUSES } from "#src/features/feedback/feedback-types";
import { isAppErrorCode } from "#src/lib/app-error";

const feedbackSearchSchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
});

export const Route = createFileRoute("/w/$workspaceSlug/feedback")({
  validateSearch: feedbackSearchSchema,
  loaderDeps: ({ search }) => ({ status: search.status }),
  loader: async ({ deps }) => {
    try {
      return await loadFeedbackInbox({ data: { status: deps.status } });
    } catch (cause) {
      if (isAppErrorCode(cause, "ACCESS_DENIED")) throw notFound();
      throw cause;
    }
  },
  errorComponent: PageLoadError,
  component: FeedbackInboxRoute,
});

function FeedbackInboxRoute() {
  const data = Route.useLoaderData();
  const { status } = Route.useSearch();
  return (
    <FeedbackInboxPage
      items={data.items}
      routing={data.routing}
      routingOptions={data.routingOptions}
      statusFilter={status}
    />
  );
}
