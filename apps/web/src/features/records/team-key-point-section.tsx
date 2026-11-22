import { useRef, useState } from "react";
import { Download01 as Download, Stars01 as Stars } from "@untitledui/icons";
import { Link } from "@tanstack/react-router";

import { Button } from "#src/components/base/buttons/button";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import type { KeyPointExtractionMeta } from "./records-content";
import { KeyPointExtractionPanel } from "./key-point-extraction-panel";

export class KeyPointStartRefusal extends Error {}

function startFailure(cause: unknown) {
  return cause instanceof KeyPointStartRefusal ? cause.message : m.records_key_points_failed();
}

export function isNoneSubmittedKeyPointFailure(
  extraction: KeyPointExtractionMeta | undefined,
): boolean {
  return extraction?.status === "failed" && extraction.error === "no_submitted_member_reports";
}

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
  onStart: () => Promise<void>;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const panelExtraction = isNoneSubmittedKeyPointFailure(extraction) ? undefined : extraction;
  const status = panelExtraction?.status;
  const canStart =
    status !== "generating" &&
    (status === undefined ||
      status === "ready" ||
      status === "failed" ||
      status === "pending_setup");
  const willOverwrite = status === "ready";
  const sectionRef = useRef<HTMLElement>(null);
  const [startError, setStartError] = useState<string | null>(null);

  function startFirst() {
    setStartError(null);
    onStart().catch((cause: unknown) => setStartError(startFailure(cause)));
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
      iconLeading={Stars}
      isDisabled={busy}
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
            <Popconfirm
              isDisabled={!willOverwrite}
              title={m.records_key_points_team_restart_confirm_title()}
              description={m.records_key_points_team_restart_confirm_body()}
              confirmLabel={m.records_key_points_team_restart()}
              errorMessage={startFailure}
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
