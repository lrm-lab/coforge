import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { isAppError, isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { useAppToast } from "#src/components/ui/toast";
import { TeamKeyPointSection } from "./team-key-point-section";
import {
  ReportTabsEditor,
  type ReportTabsChangeMeta,
  type ReportTabsEditorRef,
} from "./report-tabs-editor";
import { TemplateReportHeader } from "./template-report-header";
import {
  readReportDraft,
  clearReportDraft,
  waitForReportSave,
  writeReportDraft,
  writeReportVersion,
} from "./report-draft-cache";
import {
  deleteOverviewReport,
  sendWeeklyReportAssignments,
  updateFormatReportMeta,
} from "./records.functions";
import {
  isAutoSendCancelled,
  isValidTemplateName,
  isWeekSendDismissed,
  normalizeReportContent,
  withoutWeekSendDismissed,
  withAutoSendCancelled,
  withWeekSendDismissed,
  type ReportContent,
} from "./records-content";
import { useFormatEditHint } from "./records-layout";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { RecordsReadingColumn } from "./records-reading-column";
import { RecordSidePanel } from "./record-side-panel";
import { RecordSplitLayout } from "./record-split-layout";
import { TemplateChildrenTable } from "./template-children-table";
import { normalizeLeaderFormatTabs, resetLeaderFormatPage } from "./template-outline-sections";
import { WEEKLY_SEND_TOAST_MS, WeeklySendConfirmDialog } from "./weekly-send-confirm-dialog";
import { currentScheduledIsoWeek } from "./weekly-report-schedule-due";
import { sendWindowEnd, useWeeklySendArmed } from "./use-send-window";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import type { ReportSubject } from "./record-subject";
import { useRecordChangedRefresh } from "./use-record-changed-refresh";
import { useLeaveToRecordsList, useRecordDeleteDialog } from "./use-record-delete";
import { useReportSidePanelOpen } from "./use-record-side-panel-open";
import { useReportDraftSave, useSettledReportSave } from "./use-report-save";
import { ReportSaveFailureBar, useReportSaveState } from "./report-save-state";
import { useRecordRefresh } from "./use-record-refresh";
import { useTeamKeyPointStart } from "./use-team-key-point-start";

export function TemplateReportDetail({
  report,
  streamPositions,
  returnTo,
}: {
  report: ReportSubject["report"];
  streamPositions: ReportSubject["streamPositions"];
  returnTo?: string;
}) {
  const refresh = useRecordRefresh();
  const toast = useAppToast();
  const setFormatEditing = useFormatEditHint();
  const saveDraft = useReportDraftSave();
  const leaveToRecordsList = useLeaveToRecordsList();
  const deleteDialog = useRecordDeleteDialog();
  const saveFormatMeta = useServerFn(updateFormatReportMeta);
  const sendAssignments = useServerFn(sendWeeklyReportAssignments);
  const removeOverview = useServerFn(deleteOverviewReport);
  const isOverview = report.surface === "overview";
  const isOverviewLeader = isOverview && report.editable === true;
  const formatSurface = isOverview ? ("plain" as const) : ("format" as const);
  const [content, setContent] = useState(() =>
    normalizeLeaderFormatTabs(readReportDraft(report.id) ?? normalizeReportContent(report.content)),
  );
  const [titleDraft, setTitleDraft] = useState(report.title);
  const [editorRevision, setEditorRevision] = useState(0);
  const formatPageRef = useRef("");
  const tabsEditorRef = useRef<ReportTabsEditorRef>(null);
  const teamKeyPoints = useTeamKeyPointStart(report.id, isOverviewLeader);
  const contentRef = useRef(content);
  const reportIdRef = useRef(report.id);
  const scheduleWeek = currentScheduledIsoWeek(new Date());
  const formatCancelled = isAutoSendCancelled(content, scheduleWeek.year, scheduleWeek.week);
  const weekDismissed = isWeekSendDismissed(content, scheduleWeek.year, scheduleWeek.week);
  const [sideOpen, setSideOpen] = useReportSidePanelOpen(report.id, formatSurface);

  useEffect(() => {
    reportIdRef.current = report.id;
  }, [report.id]);

  useEffect(() => {
    setTitleDraft(report.title);
  }, [report.id, report.title]);
  const { saving, failure, begin, track } = useReportSaveState();
  const [sending, setSending] = useState(false);
  const [dirty, setDirty] = useState(() => {
    const draft = readReportDraft(report.id);
    if (!draft) return false;
    return (
      JSON.stringify(normalizeReportContent(draft)) !==
      JSON.stringify(normalizeReportContent(report.content))
    );
  });
  const dirtyRef = useRef(dirty);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [canSendAssignments, setCanSendAssignments] = useState(Boolean(report.canSendAssignments));
  const [sideRefresh, setSideRefresh] = useState(0);
  const sendSchedule = report.sendSchedule;
  const metaDirty = !isOverview && titleDraft.trim() !== report.title;
  const hasUnsavedEdits = dirty || metaDirty;

  const sendWindow = useMemo(
    () =>
      sendSchedule
        ? {
            alreadySent: sendSchedule.alreadySent,
            sendWeekday: sendSchedule.sendWeekday,
            sendTime: sendSchedule.sendTime,
            scheduleEnabled: sendSchedule.scheduleEnabled,
            autoSendCancelled: sendSchedule.autoSendCancelled || formatCancelled || weekDismissed,
          }
        : null,
    [sendSchedule, formatCancelled, weekDismissed],
  );
  const sendArmed = useWeeklySendArmed(sendWindow);
  const countdownUntil = useMemo(
    () => (sendWindow ? sendWindowEnd(sendWindow, sendArmed) : null),
    [sendWindow, sendArmed],
  );
  useEffect(() => {
    setCanSendAssignments(Boolean(report.canSendAssignments));
    dirtyRef.current = false;
    setDirty(false);
    setConfirmOpen(false);
  }, [report.canSendAssignments, report.id]);

  useEffect(() => {
    return () => {
      tabsEditorRef.current?.flush();
    };
  }, []);

  useEffect(() => {
    writeReportVersion(report.id, report.updatedAt);
  }, [report.id, report.updatedAt]);

  useEffect(() => {
    if (isOverview) {
      setFormatEditing(false);
      return;
    }
    setFormatEditing(hasUnsavedEdits);
    return () => setFormatEditing(false);
  }, [hasUnsavedEdits, isOverview, setFormatEditing]);

  function replaceContent(next: ReportContent) {
    contentRef.current = next;
    setContent(next);
  }

  function updateDirty(next: boolean) {
    dirtyRef.current = next;
    setDirty(next);
  }

  function onConflict(cause: unknown) {
    if (isAppErrorCode(cause, "CONFLICT")) void refresh.record();
  }

  async function persist(
    next: ReportContent,
    reportId = reportIdRef.current,
    options?: { askToSend?: boolean },
  ) {
    const { normalized, saved } = saveDraft(reportId, next, {
      askToSend: options?.askToSend,
    });
    let result: Awaited<typeof saved> | undefined;
    const ok = await track(
      async () => {
        result = await saved;
      },
      () => {
        tabsEditorRef.current?.flush();
        void persist(contentRef.current, undefined, options);
      },
      () => reportId === reportIdRef.current,
      onConflict,
    );
    if (!ok || !result) return false;
    if (reportId === reportIdRef.current) {
      const editedDuringSave = contentRef.current !== next;
      const baseContent = editedDuringSave ? contentRef.current : normalized;
      const nextContent = result.autoSendJustCancelled
        ? withAutoSendCancelled(baseContent, report.cycle.year, report.cycle.week)
        : baseContent;
      if (editedDuringSave) {
        contentRef.current = nextContent;
        if (result.autoSendJustCancelled) setContent(nextContent);
      } else {
        replaceContent(nextContent);
        updateDirty(false);
        tabsEditorRef.current?.markClean();
      }
      writeReportDraft(reportId, nextContent);
      if (result.assistantPosted) {
        setSideOpen(true);
        setSideRefresh((token) => token + 1);
      }
      if (result.autoSendJustCancelled) {
        await refresh.records();
      }
    }
    return true;
  }

  function markLocalContent(next: ReportContent, meta?: ReportTabsChangeMeta) {
    const merged: ReportContent = {
      ...contentRef.current,
      tabs: next.tabs,
      tabOrder: next.tabOrder,
    };
    contentRef.current = merged;
    if (meta?.structural) setContent(merged);
    updateDirty(true);
    writeReportDraft(reportIdRef.current, merged);
  }

  async function saveFormatEdits() {
    tabsEditorRef.current?.flush();
    if (metaDirty) {
      const nextTitle = titleDraft.trim();
      if (!isValidTemplateName(nextTitle)) {
        setTitleError(m.records_format_meta_invalid());
        return;
      }
      let meta: Awaited<ReturnType<typeof saveFormatMeta>> | undefined;
      const saved = await track(
        async () => {
          meta = await saveFormatMeta({
            data: {
              reportId: reportIdRef.current,
              title: nextTitle,
            },
          });
        },
        () => void saveFormatEdits(),
        undefined,
        onConflict,
      );
      if (!saved || !meta) return;
      writeReportVersion(reportIdRef.current, meta.updatedAt);
      await refresh.records();
    }
    if (dirtyRef.current) {
      await persist(contentRef.current, undefined, { askToSend: true });
    }
  }

  async function onSendAssignments() {
    tabsEditorRef.current?.flush();
    if (sending || hasUnsavedEdits || dirtyRef.current) return;
    if (sendSchedule?.alreadySent) {
      setSendError(m.records_report_send_assignments_error());
      setConfirmOpen(false);
      return;
    }
    const week = currentScheduledIsoWeek(new Date());
    const draft = withoutWeekSendDismissed(
      normalizeReportContent(contentRef.current),
      week.year,
      week.week,
    );
    replaceContent(draft);
    writeReportDraft(report.id, draft);
    setSending(true);
    setSendError(null);
    try {
      await waitForReportSave(report.id);
      if (!(await persist(draft))) {
        setSendError(m.records_report_send_assignments_error());
        setConfirmOpen(false);
        return;
      }
      try {
        await sendAssignments({
          data: {
            sourceReportId: report.id,
            content: normalizeReportContent(draft),
          },
        });
      } catch (error) {
        const cause =
          error && typeof error === "object" && "cause" in error
            ? (error as { cause: unknown }).cause
            : error;
        const appError = isAppError(cause) ? cause : isAppError(error) ? error : null;
        const errorId = appError?.errorId;
        setSendError(
          errorId === "weekly-send-no-settings"
            ? m.records_report_send_no_settings()
            : errorId === "weekly-send-no-recipients"
              ? m.records_report_send_no_recipients()
              : m.records_report_send_assignments_error(),
        );
        setConfirmOpen(false);
        return;
      }
      setCanSendAssignments(false);
      setConfirmOpen(false);
      toast.success(m.records_report_shared_toast(), { durationMs: WEEKLY_SEND_TOAST_MS });
      try {
        await refresh.records();
      } catch {}
    } finally {
      setSending(false);
    }
  }

  useSettledReportSave(report.id, report.content, () => {
    const draft = readReportDraft(report.id);
    if (!draft) return;
    const normalized = normalizeLeaderFormatTabs(draft);
    replaceContent(normalized);
    updateDirty(
      JSON.stringify(normalizeReportContent(normalized)) !==
        JSON.stringify(normalizeReportContent(report.content)),
    );
  });

  useEffect(() => {
    if (!isOverview) return;
    replaceContent(normalizeReportContent(report.content));
  }, [isOverview, report.content, report.id]);

  useRecordChangedRefresh(report.id, streamPositions, isOverviewLeader);

  async function removeOverviewNode() {
    if (!isOverviewLeader || saving || sending) throw new Error("The summary is busy");
    const end = begin();
    try {
      await removeOverview({ data: { reportId: report.id } });
      clearReportDraft(report.id);
      deleteDialog.close();
      await leaveToRecordsList();
    } finally {
      end();
    }
  }

  return (
    <RecordSplitLayout
      sideOpen={sideOpen}
      onSideOpenChange={setSideOpen}
      main={
        <>
          <TemplateReportHeader
            week={report.cycle.week}
            title={report.title}
            returnTo={returnTo}
            isOverview={isOverview}
            isOverviewLeader={isOverviewLeader}
            titleDraft={titleDraft}
            titleError={titleError}
            onTitleDraftChange={(value) => {
              setTitleDraft(value);
              setTitleError(null);
            }}
            saving={saving}
            sending={sending}
            hasUnsavedEdits={hasUnsavedEdits}
            alreadySent={Boolean(sendSchedule?.alreadySent)}
            canSendAssignments={canSendAssignments}
            weekDismissed={weekDismissed}
            onOpenConfirmSend={() => setConfirmOpen(true)}
            onSaveFormatEdits={() => void saveFormatEdits()}
            sideOpen={sideOpen}
            onOpenSide={() => setSideOpen(true)}
            onRequestDeleteOverview={deleteDialog.request}
            onResetPage={() => {
              tabsEditorRef.current?.flush();
              const page = formatPageRef.current || Object.keys(contentRef.current.tabs ?? {})[0];
              if (!page) return;
              markLocalContent(resetLeaderFormatPage(contentRef.current, page), {
                structural: true,
              });
              setEditorRevision((revision) => revision + 1);
            }}
          />
          {failure && <ReportSaveFailureBar failure={failure} retrying={saving} />}
          {isOverview || !(titleError ?? sendError) ? null : (
            <p
              id={titleError ? "report-title-error" : undefined}
              className="border-b border-secondary px-4 py-2 text-sm text-error-primary sm:px-6"
            >
              {titleError ?? sendError}
            </p>
          )}

          {isOverview ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <RecordsReadingColumn>
                <TemplateChildrenTable children={report.children ?? []} />
                {isOverviewLeader ? (
                  <TeamKeyPointSection
                    overviewReportId={report.id}
                    extraction={content.keyPointExtraction}
                    busy={teamKeyPoints.busy}
                    onStart={teamKeyPoints.start}
                  />
                ) : null}
              </RecordsReadingColumn>
            </div>
          ) : (
            <ReportTabsEditor
              editorRef={tabsEditorRef}
              content={content}
              editable={report.editable !== false}
              editableTabs
              contentRevision={editorRevision}
              placeholder={m.records_report_body_placeholder()}
              onUploadFile={fileToDataUrlUpload}
              onDirty={() => updateDirty(true)}
              onChange={markLocalContent}
              onActiveTabChange={(name) => {
                formatPageRef.current = name;
              }}
            />
          )}
        </>
      }
      side={
        <RecordSidePanel
          key={report.id}
          subjectType="report"
          subjectId={report.id}
          surface={formatSurface}
          countdownUntil={countdownUntil}
          refreshToken={sideRefresh}
          open={sideOpen}
          onOpenChange={setSideOpen}
          sendOfferActive={canSendAssignments && !weekDismissed && !hasUnsavedEdits}
          onRequestSend={() => {
            if (hasUnsavedEdits) return;
            setConfirmOpen(true);
          }}
          onWeekSendDismissed={() => {
            tabsEditorRef.current?.flush();
            const week = currentScheduledIsoWeek(new Date());
            const next = withWeekSendDismissed(contentRef.current, week.year, week.week);
            replaceContent(next);
            writeReportDraft(report.id, next);
            setCanSendAssignments(false);
            void refresh.records();
          }}
        />
      }
    >
      <WeeklySendConfirmDialog
        open={confirmOpen}
        busy={sending}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void onSendAssignments()}
      />

      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={deleteDialog.setOpen}
        title={m.records_week_delete_confirm_title({ name: titleDraft.trim() || report.title })}
        description={m.records_week_delete_confirm_body()}
        confirmLabel={m.records_week_delete_action()}
        pendingLabel={m.records_delete_pending()}
        errorMessage={m.records_week_delete_failed()}
        onConfirm={removeOverviewNode}
      />
    </RecordSplitLayout>
  );
}
