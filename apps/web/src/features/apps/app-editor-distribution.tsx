import { useState, type ReactNode } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { appFormProblem } from "./app-form";
import { canRequestPublish, type AppPublishStatus } from "./app-publish-status";
import { publishStatusLabel } from "./app-publish-status-badge";
import { EditorSection } from "./app-editor-fields";

/** The requests the Distribution section makes; each throws when the server refuses it. */
export type PublishingActions = {
  /** Saves the editor's changes, then asks for publication. */
  requestPublish: () => Promise<void>;
  withdraw: () => Promise<void>;
};

/**
 * The editor's Distribution section (behind `app-marketplace`): the app's Marketplace status, a
 * hint while a request waits, and what can be done in that status: withdraw a pending publish
 * request; request publication when private or rejected (saving the editor first); a note once
 * published. Asking for removal from the Marketplace is the Danger zone's. Each action acts at
 * once, apart from the form's Save.
 */
export function DistributionSection({
  id,
  status,
  actions,
}: {
  id: string;
  status: AppPublishStatus;
  actions: PublishingActions;
}) {
  const [running, setRunning] = useState<"request" | "withdraw" | null>(null);
  const [error, setError] = useState("");
  async function run(which: "request" | "withdraw", action: () => Promise<void>) {
    setRunning(which);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        appFormProblem(
          cause,
          which === "request" ? m.apps_publish_request_error : m.apps_publish_withdraw_error,
        ).message,
      );
    } finally {
      setRunning(null);
    }
  }
  return (
    <EditorSection
      id={id}
      title={m.apps_section_distribution()}
      status={publishStatusLabel(status, "editor")}
      description={m.apps_section_distribution_description()}
    >
      {error && <Alert color="error" title={error} />}
      {status === "publish_requested" && (
        <>
          <Alert color="warning" title={m.apps_publish_hint_review_pending()} />
          <Row
            title={m.apps_publish_withdraw_title()}
            description={m.apps_publish_withdraw_description()}
            action={
              <Button
                type="button"
                size="sm"
                color="secondary"
                isDisabled={running !== null}
                isLoading={running === "withdraw"}
                showTextWhileLoading
                onPress={() => void run("withdraw", actions.withdraw)}
              >
                {running === "withdraw" ? m.apps_publish_withdrawing() : m.apps_publish_withdraw()}
              </Button>
            }
          />
        </>
      )}
      {status === "unpublish_requested" && (
        <Alert color="warning" title={m.apps_publish_hint_offline_pending()} />
      )}
      {canRequestPublish(status) && (
        <Row
          title={m.apps_publish_request_title()}
          description={m.apps_publish_request_description()}
          action={
            <Button
              type="button"
              size="sm"
              color="primary"
              isDisabled={running !== null}
              isLoading={running === "request"}
              showTextWhileLoading
              onPress={() => void run("request", actions.requestPublish)}
            >
              {running === "request" ? m.apps_publish_requesting() : m.apps_publish_request()}
            </Button>
          }
        />
      )}
      {status === "published" && <Alert color="success" title={m.apps_publish_published_note()} />}
    </EditorSection>
  );
}

function Row({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-secondary p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid min-w-0 gap-1">
        <p className="text-sm font-medium text-primary">{title}</p>
        <p className="text-sm text-tertiary">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
