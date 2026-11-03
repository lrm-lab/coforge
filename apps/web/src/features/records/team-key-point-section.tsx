import { useRef, useState } from "react";
import { Download01 as Download, Stars01 as Stars } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { KeyPointExtractionMeta } from "./records-content";
import { KeyPointExtractionPanel } from "./key-point-extraction-panel";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";

/** Failed because nobody submitted — toast-only, never a parked panel state. */
export function isNoneSubmittedKeyPointFailure(
  extraction: KeyPointExtractionMeta | undefined,
): boolean {
  return extraction?.status === "failed" && extraction.error === "no_submitted_member_reports";
}

/** Overview-page team key-point block: start button + shared extraction panel. */
export function TeamKeyPointSection({
  overviewReportId,
  extraction,
  assistantAgentId,
  busy,
  onStart,
}: {
  overviewReportId: string;
  extraction: KeyPointExtractionMeta | undefined;
  assistantAgentId?: string | null;
  busy?: boolean;
  /** Starts the extraction; throws when it could not be started. */
  onStart: () => Promise<void>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  // Stale persisted none-submitted failures stay invisible; waiting copy replaces them.
  const panelExtraction = isNoneSubmittedKeyPointFailure(extraction) ? undefined : extraction;
  const status = panelExtraction?.status;
  const canStart =
    status !== "generating" &&
    (status === undefined ||
      status === "ready" ||
      status === "failed" ||
      status === "pending_setup");
  const willOverwrite = status === "ready";
  // Where focus lands when the button gives way to the running extraction.
  const sectionRef = useRef<HTMLElement>(null);
  // A first start has no popover to show a refusal in, so the section says it.
  const [startError, setStartError] = useState<string | null>(null);

  function startFirst() {
    setStartError(null);
    onStart().catch(() => setStartError(m.records_key_points_failed()));
  }

  async function restart() {
    setStartError(null);
    await onStart();
  }

  const startButton = (
    <Button
      type="button"
      size="sm"
      color="primary"
      className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
      iconLeading={Stars}
      isDisabled={busy}
      // Overwriting asks first: the popconfirm around the button owns its press.
      onPress={willOverwrite ? undefined : startFirst}
    >
      {status ? m.records_key_points_team_restart() : m.records_key_points_team_start()}
    </Button>
  );

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="mt-8 space-y-4 border-t border-secondary pt-6 outline-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-primary">
            {m.records_key_points_team_section_title()}
          </h2>
          <p className="text-sm text-tertiary">{m.records_key_points_team_section_hint()}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/w/$workspaceSlug/records/settings"
            params={{ workspaceSlug }}
            search={{
              tab: "weekly",
              section: "key_points",
              slot: "team",
              returnTo: `/w/${workspaceSlug}/records/${overviewReportId}`,
            }}
            className="text-sm font-medium text-brand-secondary hover:underline"
          >
            {m.records_key_points_edit_prompt()}
          </Link>
          <a
            href={`/api/workspaces/${encodeURIComponent(workspaceSlug)}/weekly-reports/${overviewReportId}/presentation`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-secondary hover:underline"
            download
          >
            <Download aria-hidden="true" className="size-4" />
            {m.records_weekly_export_ppt()}
          </a>
          <a
            href={`/api/workspaces/${encodeURIComponent(workspaceSlug)}/weekly-reports/${overviewReportId}/html`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-secondary hover:underline"
            download
          >
            <Download aria-hidden="true" className="size-4" />
            {m.records_weekly_export_html()}
          </a>
          {canStart ? (
            // One element for both states, so focus stays on the button; a first start has
            // nothing to confirm.
            <Popconfirm
              isDisabled={!willOverwrite}
              title={m.records_key_points_team_restart_confirm_title()}
              description={m.records_key_points_team_restart_confirm_body()}
              confirmLabel={m.records_key_points_team_restart()}
              errorMessage={m.records_key_points_failed()}
              placement="bottom end"
              fallbackFocus={() => sectionRef.current}
              onConfirm={restart}
            >
              {startButton}
            </Popconfirm>
          ) : null}
        </div>
      </div>

      {startError && (
        <p role="alert" className="text-sm text-error-primary">
          {startError}
        </p>
      )}

      {status ? (
        <KeyPointExtractionPanel
          extraction={panelExtraction}
          assistantAgentId={assistantAgentId}
          waitingLabel={m.records_key_points_team_waiting()}
          framed={false}
        />
      ) : (
        <p className="text-sm text-tertiary">{m.records_key_points_team_waiting()}</p>
      )}
    </section>
  );
}
