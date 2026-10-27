import { createFileRoute, notFound } from "@tanstack/react-router";

import { AppReviewPage } from "#src/features/apps/app-review-page";
import { loadAppReviews } from "#src/features/apps/app-publishing.functions";
import { PageLoadError } from "#src/features/errors/page-load-error";
import { isAppErrorCode } from "#src/lib/app-error";

export const Route = createFileRoute("/w/$workspaceSlug/app-review")({
  // Only platform operators see this page: for anyone else it does not exist.
  loader: async () => {
    try {
      return await loadAppReviews();
    } catch (cause) {
      if (isAppErrorCode(cause, "ACCESS_DENIED")) throw notFound();
      throw cause;
    }
  },
  errorComponent: PageLoadError,
  component: AppReviewRoute,
});

function AppReviewRoute() {
  return <AppReviewPage requests={Route.useLoaderData()} />;
}
