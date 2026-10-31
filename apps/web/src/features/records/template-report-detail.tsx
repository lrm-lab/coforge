import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { DotsHorizontal, MessageChatCircle as Message, Trash01 as Trash } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { useAppToast } from "#src/components/ui/toast";
import { TeamKeyPointSection } from "./team-key-point-section";
import { RECORDS_PRIMARY_BUTTON_CLASSNAME } from "./records-primary-button";
import { ReportTabsEditor } from "./report-tabs-editor";
import {
  readReportDraft,
  clearReportDraft,
  waitForReportSave,
  writeReportDraft,
} from "./report-draft-cache";
import {
  deleteOverviewReport,
  startTeamKeyPointExtraction,
  sendWeeklyReportAssignments,
  updateFormatReportMeta,
} from "./records.functions";
import {
  currentIsoWeek,
  isAutoSendCancelled,
  isValidTemplateName,
  isWeekSendDismissed,
  normalizeReportContent,
  withoutWeekSendDismissed,
  withAutoSendCancelled,
  withWeekSendDismissed,
  type ReportContent,
} from "./records-content";
import {
  BackToRecords,
  RecordsKeyPointReturnBack,
  WeekBadge,
  useFormatEditHint,
} from "./records-layout";
import { RecordsDeleteConfirmDialog } from "./records-delete-confirm-dialog";
import { RecordsReadingColumn } from "./records-reading-column";
import { RecordSidePanel } from "./record-side-panel";
import { TemplateChildrenTable } from "./template-children-table";
import { normalizeLeaderFormatTabs, resetLeaderFormatPage } from "./template-outline-sections";
import { WEEKLY_SEND_TOAST_MS, WeeklySendConfirmDialog } from "./weekly-send-confirm-dialog";
import { zonedCalendarDate } from "./weekly-report-schedule-due";
import { sendWindowEnd, useWeeklySendArmed } from "./use-send-window";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import type { ReportSubject } from "./record-subject";
import { useKeyPointGeneratingRefresh } from "./use-key-point-generating-refresh";
import { useLeaveToRecordsList, useRecordDeleteDialog } from "./use-record-delete";
import { useReportSidePanelOpen } from "./use-record-side-panel-open";
import { useReportDraftSave, useSettledReportSave } from "./use-report-save";

export function TemplateReportDetail({
  report,
  returnTo,
}: {
  report: ReportSubject["report"];
  returnTo?: string;
}) {
  const router = useRouter();
  const toast = useAppToast();
  const setFormatEditing = useFormatEditHint();
  const saveDraft = useReportDraftSave();
  const leaveToRecordsList = useLeaveToRecordsList();
  const deleteDialog = useRecordDeleteDialog();
  const saveFormatMeta = useServerFn(updateFormatReportMeta);
  const sendAssignments = useServerFn(sendWeeklyReportAssignments);
  const startTeamKeyPoints = useServerFn(startTeamKeyPointExtraction);
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
  const [teamKeyPointBusy, setTeamKeyPointBusy] = useState(false);
  const contentRef = useRef(content);
  contentRef.current = content;
  const reportIdRef = useRef(report.id);
  reportIdRef.current = report.id;
  // Schedule cancel/dismiss keys follow the calendar week (same as the tick), not the document cycle.
  const scheduleWeek = currentIsoWeek(zonedCalendarDate(new Date()));
  const formatCancelled = isAutoSendCancelled(content, scheduleWeek.year, scheduleWeek.week);
  const weekDismissed = isWeekSendDismissed(content, scheduleWeek.year, scheduleWeek.week);
  const [sideOpen, setSideOpen] = useReportSidePanelOpen(report.id, formatSurface);

  useEffect(() => {
    setTitleDraft(report.title);
  }, [report.id, report.title]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [dirty, setDirty] = useState(() => {
    const draft = readReportDraft(report.id);
    if (!draft) return false;
    return (
      JSON.stringify(normalizeReportContent(draft)) !==
      JSON.stringify(normalizeReportContent(report.content))
    );
  });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
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
    setDirty(false);
    setConfirmOpen(false);
  }, [report.canSendAssignments, report.id]);

  useEffect(() => {
    if (isOverview) {
      setFormatEditing(false);
      return;
    }
    setFormatEditing(hasUnsavedEdits);
    return () => setFormatEditing(false);
  }, [hasUnsavedEdits, isOverview, setFormatEditing]);

  function replaceContent(next: ReportContent) {
    setContent(next);
    contentRef.current = next;
  }

  async function persist(
    next: ReportContent,
    status?: "draft" | "submitted" | "shared",
    reportId = reportIdRef.current,
    options?: { askToSend?: boolean },
  ) {
    setSaving(true);
    const { normalized, saved } = saveDraft(reportId, next, {
      status,
      askToSend: options?.askToSend,
    });
    try {
      const result = await saved;
      if (reportId === reportIdRef.current) {
        const nextContent = result.autoSendJustCancelled
          ? withAutoSendCancelled(normalized, report.cycle.year, report.cycle.week)
          : normalized;
        replaceContent(nextContent);
        writeReportDraft(reportId, nextContent);
        setDirty(false);
        if (result.assistantPosted) {
          setSideOpen(true);
          setSideRefresh((token) => token + 1);
        }
        if (result.autoSendJustCancelled) {
          await router.invalidate({ sync: true });
        }
      }
    } finally {
      if (reportId === reportIdRef.current) setSaving(false);
    }
  }

  function markLocalContent(next: ReportContent) {
    replaceContent(next);
    setDirty(true);
    writeReportDraft(reportIdRef.current, next);
  }

  async function saveFormatEdits() {
    if (metaDirty) {
      const nextTitle = titleDraft.trim();
      if (!isValidTemplateName(nextTitle)) {
        toast.error(m.records_format_meta_invalid());
        return;
      }
      setSaving(true);
      try {
        await saveFormatMeta({
          data: {
            reportId: reportIdRef.current,
            title: nextTitle,
          },
        });
        await router.invalidate({ sync: true });
      } finally {
        setSaving(false);
      }
    }
    if (dirty) {
      await persist(contentRef.current, undefined, undefined, { askToSend: true });
    }
  }

  async function onSendAssignments() {
    if (sending || hasUnsavedEdits) return;
    if (sendSchedule?.alreadySent) {
      setSendError(m.records_report_send_assignments_error());
      setConfirmOpen(false);
      return;
    }
    const week = currentIsoWeek(zonedCalendarDate(new Date()));
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
      try {
        await persist(draft);
      } catch {
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
        await router.invalidate({ sync: true });
      } catch {
        // Assignments already persisted; catalog refresh can retry on navigation.
      }
    } finally {
      setSending(false);
    }
  }

  useSettledReportSave(report.id, () => {
    const draft = readReportDraft(report.id);
    if (!draft) return;
    const normalized = normalizeLeaderFormatTabs(draft);
    replaceContent(normalized);
    setDirty(
      JSON.stringify(normalizeReportContent(normalized)) !==
        JSON.stringify(normalizeReportContent(report.content)),
    );
  });

  useEffect(() => {
    if (!isOverview) return;
    replaceContent(normalizeReportContent(report.content));
  }, [isOverview, report.content, report.id]);

  useKeyPointGeneratingRefresh(
    isOverviewLeader && content.keyPointExtraction?.status === "generating",
  );

  async function removeOverviewNode() {
    if (!isOverviewLeader || saving || sending) return;
    setSaving(true);
    deleteDialog.setError("");
    try {
      await removeOverview({ data: { reportId: report.id } });
      clearReportDraft(report.id);
      deleteDialog.close();
      await leaveToRecordsList();
    } catch {
      deleteDialog.setError(m.records_week_delete_failed());
    } finally {
      setSaving(false);
    }
  }

  async function onStartTeamKeyPoints() {
    if (!isOverviewLeader || teamKeyPointBusy) return;
    setTeamKeyPointBusy(true);
    try {
      const result = await startTeamKeyPoints({
        data: { overviewReportId: report.id, force: true },
      });
      if (result.error === "no_submitted_member_reports") {
        toast.error(m.records_key_points_team_none_submitted());
        return;
      }
      await router.invalidate({ sync: true });
    } finally {
      setTeamKeyPointBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        className={`${sideOpen ? "hidden lg:flex" : "flex"} relative min-w-0 flex-1 flex-col overflow-hidden`}
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-secondary px-4 sm:px-6">
          <span className="flex shrink-0 items-center gap-2">
            {returnTo ? <RecordsKeyPointReturnBack returnTo={returnTo} /> : <BackToRecords />}
            <WeekBadge week={report.cycle.week} />
          </span>
          {isOverview ? (
            <h1 className="min-w-0 truncate text-md font-semibold text-primary sm:text-lg">
              {report.title}
            </h1>
          ) : (
            <input
              type="text"
              aria-label={m.records_template_name()}
              value={titleDraft}
              disabled={saving || sending}
              onChange={(event) => setTitleDraft(event.target.value)}
              className="min-w-0 flex-1 truncate bg-transparent text-md font-semibold text-primary outline-none placeholder:text-tertiary focus-visible:outline-none disabled:opacity-60 sm:text-lg"
            />
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {isOverview ? null : (
              <>
                <Button
                  size="sm"
                  color="primary"
                  className={RECORDS_PRIMARY_BUTTON_CLASSNAME}
                  isDisabled={
                    saving ||
                    sending ||
                    hasUnsavedEdits ||
                    Boolean(sendSchedule?.alreadySent) ||
                    (!canSendAssignments && !weekDismissed)
                  }
                  onPress={() => setConfirmOpen(true)}
                >
                  {m.records_report_send()}
                </Button>
                {hasUnsavedEdits ? (
                  <Button
                    size="sm"
                    color="secondary"
                    isDisabled={saving || sending}
                    onPress={() => void saveFormatEdits()}
                  >
                    {m.records_report_save()}
                  </Button>
                ) : null}
              </>
            )}
            {sideOpen ? null : (
              <ButtonUtility
                size="sm"
                color="tertiary"
                icon={Message}
                aria-label={m.records_side_chat()}
                onClick={() => setSideOpen(true)}
              />
            )}
            {isOverview ? (
              isOverviewLeader ? (
                <Dropdown.Root>
                  <ButtonUtility
                    size="sm"
                    color="tertiary"
                    icon={DotsHorizontal}
                    aria-label={m.records_report_actions()}
                    isDisabled={saving || sending}
                  />
                  <Dropdown.Popover placement="bottom end" className="w-44">
                    <Dropdown.Menu onAction={deleteDialog.request}>
                      <Dropdown.Item id="delete" icon={Trash} label={m.records_week_delete()} />
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown.Root>
              ) : null
            ) : (
              <Dropdown.Root>
                <ButtonUtility
                  size="sm"
                  color="tertiary"
                  icon={DotsHorizontal}
                  aria-label={m.records_report_actions()}
                  isDisabled={saving || sending}
                />
                <Dropdown.Popover placement="bottom end" className="w-44">
                  <Dropdown.Menu
                    onAction={() => {
                      const page =
                        formatPageRef.current || Object.keys(contentRef.current.tabs ?? {})[0];
                      if (!page) return;
                      markLocalContent(resetLeaderFormatPage(contentRef.current, page));
                      setEditorRevision((revision) => revision + 1);
                    }}
                  >
                    <Dropdown.Item id="reset" icon={Trash} label={m.records_report_reset()} />
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown.Root>
            )}
          </div>
        </header>
        {isOverview || !sendError ? null : (
          <p className="border-b border-secondary px-4 py-2 text-sm text-error-primary sm:px-6">
            {sendError}
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
                  busy={teamKeyPointBusy}
                  onStart={() => void onStartTeamKeyPoints()}
                />
              ) : null}
            </RecordsReadingColumn>
          </div>
        ) : (
          <ReportTabsEditor
            content={content}
            editableTabs
            contentRevision={editorRevision}
            placeholder={m.records_report_body_placeholder()}
            onUploadFile={fileToDataUrlUpload}
            onChange={markLocalContent}
            onActiveTabChange={(name) => {
              formatPageRef.current = name;
            }}
          />
        )}
      </div>

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
          const week = currentIsoWeek(zonedCalendarDate(new Date()));
          const next = withWeekSendDismissed(contentRef.current, week.year, week.week);
          replaceContent(next);
          writeReportDraft(report.id, next);
          setCanSendAssignments(false);
          void router.invalidate({ sync: true });
        }}
      />

      <WeeklySendConfirmDialog
        open={confirmOpen}
        busy={sending}
        onOpenChange={setConfirmOpen}
        onConfirm={() => void onSendAssignments()}
      />

      <RecordsDeleteConfirmDialog
        open={deleteDialog.open}
        title={m.records_week_delete_confirm_title({ name: titleDraft.trim() || report.title })}
        description={m.records_week_delete_confirm_body()}
        busy={saving}
        error={deleteDialog.error}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => void removeOverviewNode()}
      />
    </div>
  );
}
