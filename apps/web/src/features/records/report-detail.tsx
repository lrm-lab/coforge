import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { m } from "#src/paraglide/messages";
import { KEY_POINT_EXTRACTION_TAB, KeyPointExtractionPanel } from "./key-point-extraction-panel";
import { ReportTabsEditor } from "./report-tabs-editor";
import {
  readReportDraft,
  clearReportDraft,
  resolveReportEditorContent,
  waitForReportSave,
  writeReportDraft,
} from "./report-draft-cache";
import {
  deleteMemberWeeklyReport,
  markWeeklyAssignmentOpened,
  restartPersonalKeyPointExtraction,
  setWeeklyReportFavorite,
  switchWeeklyReportBodyVersion,
} from "./records.functions";
import {
  normalizeReportContent,
  reportContentToMarkdown,
  reportTabsEqual,
  withAssignmentUnread,
  type ReportBodyRestoreView,
  type ReportContent,
} from "./records-content";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { RecordsDeleteConfirmDialog } from "./records-delete-confirm-dialog";
import { RecordSidePanel } from "./record-side-panel";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import { ReportDetailHeader } from "./report-detail-header";
import type { ReportSubject } from "./record-subject";
import { useRecordChangedRefresh } from "./use-record-changed-refresh";
import { useLeaveToRecordsList, useRecordDeleteDialog } from "./use-record-delete";
import { useReportSidePanelOpen } from "./use-record-side-panel-open";
import { useReportReadingTurn } from "./use-report-reading-turn";
import { useReportDraftSave, useSettledReportSave } from "./use-report-save";

export function ReportDetail({
  report,
  streamPositions,
  returnTo,
}: {
  report: ReportSubject["report"];
  streamPositions: ReportSubject["streamPositions"];
  returnTo?: string;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const saveDraft = useReportDraftSave();
  const leaveToRecordsList = useLeaveToRecordsList();
  const deleteDialog = useRecordDeleteDialog();
  const switchBody = useServerFn(switchWeeklyReportBodyVersion);
  const removeReport = useServerFn(deleteMemberWeeklyReport);
  const markOpened = useServerFn(markWeeklyAssignmentOpened);
  const setFavorite = useServerFn(setWeeklyReportFavorite);
  const restartKeyPoints = useServerFn(restartPersonalKeyPointExtraction);
  const editable = report.editable === true;
  const [content, setContent] = useState(() =>
    editable
      ? resolveReportEditorContent({
          serverContent: report.content,
          draft: readReportDraft(report.id),
        })
      : normalizeReportContent(report.content),
  );
  const contentRef = useRef(content);
  contentRef.current = content;
  const [editorRevision, setEditorRevision] = useState(0);
  const [restoreView, setRestoreView] = useState(report.bodyRestoreView ?? null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const seenRestoreRevisionRef = useRef<number | null>(null);
  const reportIdRef = useRef(report.id);
  reportIdRef.current = report.id;
  const isAssignment = Boolean(report.sourceTemplateId);
  const leaderReading = report.kind === "member" && report.editable !== true;
  const memberAssignee = report.kind === "member" && editable && isAssignment;
  const memberSurface = leaderReading
    ? ("member-leader" as const)
    : memberAssignee
      ? ("member-assignee" as const)
      : ("plain" as const);
  const [sideOpen, setSideOpen] = useReportSidePanelOpen(report.id, memberSurface);
  const [saving, setSaving] = useState(false);
  const [favorited, setFavorited] = useState(Boolean(report.favorited));
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [keyPointRestartBusy, setKeyPointRestartBusy] = useState(false);
  const [status, setStatus] = useState(report.status);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submitInFlightRef = useRef(false);
  const sendAckTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sendAck, setSendAck] = useState(false);
  const sent = status === "submitted" || status === "shared";
  const receivedBaseline = useMemo(() => {
    if (!memberAssignee) return null;
    return normalizeReportContent(report.content).received?.tabs ?? null;
  }, [memberAssignee, report.content]);
  const assignmentUnchanged =
    receivedBaseline != null && reportTabsEqual(content, { tabs: receivedBaseline });
  // Leader reads a submitted assignment; the assignee turns the same pages while filling it in.
  const readingScroll = (leaderReading && sent) || memberAssignee;
  const readingTurn = useReportReadingTurn(report.id, report.cycle, readingScroll);

  useEffect(() => {
    setFavorited(Boolean(report.favorited));
  }, [report.favorited, report.id]);

  useEffect(() => {
    return () => {
      if (sendAckTimerRef.current) clearTimeout(sendAckTimerRef.current);
    };
  }, []);

  function replaceContent(next: ReportContent) {
    setContent(next);
    contentRef.current = next;
  }

  function exportReport() {
    const markdown = reportContentToMarkdown(contentRef.current);
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${report.title}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function toggleFavorite() {
    if (favoriteBusy || report.kind !== "member") return;
    setFavoriteBusy(true);
    const next = !favorited;
    setFavorited(next);
    try {
      const result = await setFavorite({ data: { reportId: report.id, favorited: next } });
      setFavorited(result.favorited);
      await router.invalidate({ sync: true });
    } catch {
      setFavorited(!next);
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function persist(
    next: ReportContent,
    nextStatus?: "draft" | "submitted" | "shared",
    reportId = reportIdRef.current,
  ) {
    if (!editable) return;
    setSaving(true);
    const { normalized, saved } = saveDraft(reportId, next, { status: nextStatus });
    try {
      await saved;
      if (reportId === reportIdRef.current) {
        replaceContent(normalized);
        if (nextStatus) setStatus(nextStatus);
      }
      if (nextStatus === "submitted" || nextStatus === "shared") {
        showSendAck();
        await router.invalidate({ sync: true });
      }
    } finally {
      if (reportId === reportIdRef.current) setSaving(false);
    }
  }

  function clearScheduledPersist() {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
  }

  function showSendAck() {
    setSendAck(true);
    if (sendAckTimerRef.current) clearTimeout(sendAckTimerRef.current);
    sendAckTimerRef.current = setTimeout(() => {
      sendAckTimerRef.current = undefined;
      setSendAck(false);
    }, 1600);
  }

  async function submitReport() {
    if (submitInFlightRef.current || assignmentUnchanged) return;
    submitInFlightRef.current = true;
    clearScheduledPersist();
    try {
      await waitForReportSave(report.id);
      await persist(contentRef.current, "submitted");
    } catch {
      // Leave the label on 发送 / 重新发送 when the write fails.
    } finally {
      submitInFlightRef.current = false;
    }
  }

  function schedulePersist(next: ReportContent) {
    if (!editable) return;
    replaceContent(next);
    writeReportDraft(reportIdRef.current, next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const reportId = reportIdRef.current;
    // Autosave delay: 900ms, debounced per keystroke.
    saveTimerRef.current = setTimeout(() => {
      void persist(contentRef.current, undefined, reportId);
    }, 900);
  }

  async function removeCurrentReport() {
    if (!editable || saving) return;
    setSaving(true);
    deleteDialog.setError("");
    try {
      clearScheduledPersist();
      await waitForReportSave(report.id);
      await removeReport({ data: { reportId: report.id } });
      clearReportDraft(report.id);
      deleteDialog.close();
      await leaveToRecordsList();
    } catch {
      deleteDialog.setError(m.records_delete_error());
    } finally {
      setSaving(false);
    }
  }

  useSettledReportSave(report.id, editable, () => {
    if (!editable) return;
    const draft = readReportDraft(report.id);
    if (draft) replaceContent(draft);
  });

  useEffect(() => {
    if (!editable) {
      replaceContent(normalizeReportContent(report.content));
      return;
    }
    const next = resolveReportEditorContent({
      serverContent: report.content,
      draft: readReportDraft(report.id),
    });
    writeReportDraft(report.id, next);
    if (
      JSON.stringify(normalizeReportContent(contentRef.current)) ===
      JSON.stringify(normalizeReportContent(next))
    ) {
      return;
    }
    replaceContent(next);
  }, [editable, report.content, report.id]);

  useEffect(() => {
    const revision = report.bodyRestoreView?.revision ?? 0;
    if (seenRestoreRevisionRef.current === null) {
      seenRestoreRevisionRef.current = revision;
      setRestoreView(report.bodyRestoreView ?? null);
      return;
    }
    setRestoreView(report.bodyRestoreView ?? null);
    if (seenRestoreRevisionRef.current === revision) return;
    seenRestoreRevisionRef.current = revision;
    applyAssistantBody(report.id, normalizeReportContent(report.content));
  }, [report.bodyRestoreView, report.content, report.id]);

  function applyAssistantBody(
    reportId: string,
    next: ReportContent,
    restore?: ReportBodyRestoreView | null,
  ) {
    if (reportId !== report.id) return;
    clearScheduledPersist();
    const normalized = normalizeReportContent(next);
    writeReportDraft(report.id, normalized);
    replaceContent(normalized);
    if (restore) {
      setRestoreView(restore);
      seenRestoreRevisionRef.current = restore.revision;
    }
    // TipTap keeps a dirty buffer; remount so the inserted body is visible immediately.
    setEditorRevision((value) => value + 1);
  }

  async function onSwitchBodyVersion() {
    if (!editable || restoreBusy) return;
    setRestoreBusy(true);
    try {
      const result = await switchBody({ data: { reportId: report.id } });
      applyAssistantBody(report.id, result.content, result.bodyRestoreView);
      await router.invalidate({ sync: true });
    } finally {
      setRestoreBusy(false);
    }
  }

  useEffect(() => {
    if (!editable || !isAssignment || !report.unread) return;
    let cancelled = false;
    void markOpened({ data: { reportId: report.id } }).then(() => {
      if (cancelled) return;
      const next = withAssignmentUnread(contentRef.current, false);
      replaceContent(next);
      writeReportDraft(report.id, next);
      void router.invalidate({ sync: true });
    });
    return () => {
      cancelled = true;
    };
  }, [editable, isAssignment, markOpened, report.id, report.unread, router]);

  useEffect(() => {
    return () => {
      if (!editable || !saveTimerRef.current) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      saveDraft(report.id, contentRef.current);
    };
  }, [editable, report.id, saveDraft]);

  useRecordChangedRefresh(report.id, streamPositions, leaderReading);

  async function restartPersonalKeyPoints() {
    if (!leaderReading || keyPointRestartBusy) return;
    setKeyPointRestartBusy(true);
    try {
      await restartKeyPoints({ data: { reportId: report.id } });
      await router.invalidate({ sync: true });
    } finally {
      setKeyPointRestartBusy(false);
    }
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <div
        className={`${sideOpen ? "hidden lg:flex" : "flex"} relative min-w-0 flex-1 flex-col overflow-hidden`}
      >
        <ReportDetailHeader
          report={report}
          returnTo={returnTo}
          editable={editable}
          isAssignment={isAssignment}
          restoreView={restoreView}
          restoreBusy={restoreBusy}
          onSwitchBodyVersion={() => void onSwitchBodyVersion()}
          sendAck={sendAck}
          sent={sent}
          assignmentUnchanged={assignmentUnchanged}
          onSubmit={() => void submitReport()}
          favorited={favorited}
          favoriteBusy={favoriteBusy}
          onToggleFavorite={() => void toggleFavorite()}
          sideOpen={sideOpen}
          onOpenSide={() => setSideOpen(true)}
          saving={saving}
          onExport={exportReport}
          onRequestDelete={deleteDialog.request}
        />

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <ReportTabsEditor
            content={content}
            editable={editable}
            contentRevision={editorRevision}
            placeholder={m.records_report_body_placeholder()}
            onUploadFile={editable ? fileToDataUrlUpload : undefined}
            trailingTabs={
              leaderReading && sent
                ? [{ id: KEY_POINT_EXTRACTION_TAB, label: KEY_POINT_EXTRACTION_TAB }]
                : undefined
            }
            renderTrailingTab={(id) =>
              id === KEY_POINT_EXTRACTION_TAB ? (
                <KeyPointExtractionPanel
                  extraction={content.keyPointExtraction}
                  restartBusy={keyPointRestartBusy}
                  onRestart={() => void restartPersonalKeyPoints()}
                  scrollable={!readingScroll}
                  editPrompt={{
                    slot: "personal",
                    returnTo: `/w/${workspaceSlug}/records/${report.id}`,
                  }}
                />
              ) : null
            }
            readingTurn={readingTurn}
            onChange={schedulePersist}
            onBlur={() => {
              if (!editable || submitInFlightRef.current) return;
              clearScheduledPersist();
              void persist(contentRef.current);
            }}
          />
        </div>
      </div>

      <RecordsDeleteConfirmDialog
        open={deleteDialog.open}
        title={m.records_report_delete_confirm_title({ name: report.title })}
        description={m.records_report_delete_confirm_body()}
        busy={saving}
        error={deleteDialog.error}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => void removeCurrentReport()}
      />

      <RecordSidePanel
        key={report.id}
        subjectType="report"
        subjectId={report.id}
        surface={memberSurface}
        open={sideOpen}
        onOpenChange={setSideOpen}
        onBodyApplied={applyAssistantBody}
        bodyRestoreView={restoreView}
        onSwitchBodyVersion={() => void onSwitchBodyVersion()}
        keyPointExtraction={leaderReading ? content.keyPointExtraction : undefined}
        keyPointRestartBusy={keyPointRestartBusy}
        onRestartKeyPointExtraction={
          leaderReading ? () => void restartPersonalKeyPoints() : undefined
        }
      />
    </div>
  );
}
