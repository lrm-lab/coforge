import { useState } from "react";
import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "#src/components/ui/empty";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { isAppErrorCode } from "#src/lib/app-error";
import { formatDateForDisplay } from "#src/lib/dates";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { APP_CATEGORY_LABELS } from "./app-list";
import { AppLogo } from "./app-logo";
import { checkPermissionGroups } from "./app-permissions";
import { permissionGroupList } from "./app-permission-copy";
import { RejectReviewDialog } from "./app-review-reject-dialog";
import { decideAppReview, type ReviewRequestSummary } from "./app-publishing.functions";

/**
 * The Marketplace review queue, for platform operators: every pending publish or offline request
 * with what the reviewer judges it by, and Approve or Reject (with a reason kept for reviewers).
 */
export function AppReviewPage({ requests }: { requests: ReviewRequestSummary[] }) {
  const slug = useWorkspaceSlug();
  return (
    <main className="w-full flex-1 overflow-y-auto px-page pb-8">
      <section aria-labelledby="app-review-title" className="grid gap-4 py-6">
        <header className="grid gap-1">
          <Link
            to="/w/$workspaceSlug/settings"
            params={{ workspaceSlug: slug }}
            search={{ section: "applications" }}
            className="flex w-fit items-center gap-1 rounded-sm text-sm text-tertiary outline-focus-ring hover:text-primary focus-visible:outline-2"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {m.apps_review_back()}
          </Link>
          <h1 id="app-review-title" className="text-lg font-semibold text-primary">
            {m.apps_review_title()}
          </h1>
          <p className="text-sm text-tertiary">{m.apps_review_description()}</p>
        </header>
        {requests.length === 0 ? (
          <Empty className="max-w-none rounded-xl border border-dashed border-secondary px-4 py-10">
            <EmptyHeader className="gap-2">
              <EmptyTitle role="heading" aria-level={2}>
                {m.apps_review_empty_title()}
              </EmptyTitle>
              <EmptyDescription>{m.apps_review_empty_description()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="grid gap-3">
            {requests.map((request) => (
              <ReviewCard key={request.requestId} request={request} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ReviewCard({ request }: { request: ReviewRequestSummary }) {
  const { app } = request;
  const router = useRouter();
  const hydrated = useHydrated();
  const decide = useServerFn(decideAppReview);
  const [rejecting, setRejecting] = useState(false);
  const [approving, guard] = useSubmitGuard();
  const [error, setError] = useState("");
  const homepage = app.homepageUrl === null ? null : new URL(app.homepageUrl);
  const groups = checkPermissionGroups(app.permissionGroups) ?? [];

  /** Sends the decision; the list is read again after it, and after a request someone else decided. */
  async function send(outcome: "approved" | "rejected", reason?: string) {
    try {
      await decide({ data: { requestId: request.requestId, outcome, reason } });
    } catch (cause) {
      if (!isAppErrorCode(cause, "CONFLICT", "NOT_FOUND")) throw cause;
      setError(m.apps_review_decided());
    }
    await router.invalidate({ sync: true });
  }

  return (
    <li className="grid gap-4 rounded-xl border border-secondary bg-primary p-4">
      <div className="flex items-start gap-3">
        <AppLogo name={app.name} url={app.logoUrl} size="md" />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-md font-semibold text-primary">{app.name}</p>
            <Badge size="sm" color={request.kind === "publish" ? "brand" : "warning"}>
              {request.kind === "publish"
                ? m.apps_review_kind_publish()
                : m.apps_review_kind_unpublish()}
            </Badge>
          </div>
          {app.description && (
            <p className="text-sm break-words whitespace-pre-line text-secondary">
              {app.description}
            </p>
          )}
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Fact label={m.apps_review_publisher()}>{request.publisherWorkspaceName}</Fact>
        <Fact label={m.apps_review_category()}>{APP_CATEGORY_LABELS[app.category]()}</Fact>
        <Fact label={m.apps_review_homepage()}>
          {homepage ? (
            <a
              href={homepage.href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs underline underline-offset-4"
            >
              {homepage.host}
            </a>
          ) : (
            m.apps_review_none()
          )}
        </Fact>
        <Fact label={m.apps_review_requested()}>
          <time dateTime={request.requestedAt}>
            {hydrated ? formatDateForDisplay(request.requestedAt, null, getLocale()) : ""}
          </time>
        </Fact>
        <Fact label={m.apps_review_scopes()}>
          <span className="font-mono text-xs">{app.allowedScopes.join(", ")}</span>
        </Fact>
        <Fact label={m.apps_review_groups()}>
          {groups.length > 0 ? permissionGroupList(groups) : m.apps_review_none()}
        </Fact>
        <Fact label={m.apps_review_events()}>
          {app.notificationEvents.length > 0 ? (
            <span className="font-mono text-xs break-words">
              {app.notificationEvents.join(", ")}
            </span>
          ) : (
            m.apps_review_none()
          )}
        </Fact>
      </dl>
      {error && <Alert color="warning" title={error} />}
      <div className="flex justify-end gap-3">
        <Button
          type="button"
          size="sm"
          color="secondary-destructive"
          isDisabled={approving}
          onPress={() => setRejecting(true)}
        >
          {m.apps_review_reject()}
        </Button>
        <Button
          type="button"
          size="sm"
          color="primary"
          isLoading={approving}
          showTextWhileLoading
          onPress={() =>
            void guard(async () => {
              setError("");
              try {
                await send("approved");
              } catch {
                setError(m.apps_review_approve_error());
              }
            })
          }
        >
          {approving ? m.apps_review_approving() : m.apps_review_approve()}
        </Button>
      </div>
      <RejectReviewDialog
        appName={app.name}
        open={rejecting}
        onOpenChange={setRejecting}
        onReject={async (reason) => {
          await send("rejected", reason);
          setRejecting(false);
        }}
      />
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-tertiary">{label}</dt>
      <dd className="text-primary">{children}</dd>
    </div>
  );
}
