import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { KEY_POINT_EXTRACTION_TAB, KeyPointExtractionPanel } from "./key-point-extraction-panel";
import {
  ReportTabsEditor,
  type ReportTabsChangeMeta,
  type ReportTabsEditorRef,
} from "./report-tabs-editor";
import {
  readReportDraft,
  clearReportDraft,
  resolveReportEditorContent,
  waitForReportSave,
  writeReportDraft,
  writeReportVersion,
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
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { RecordSidePanel } from "./record-side-panel";
import { RecordSplitLayout } from "./record-split-layout";
import { fileToDataUrlUpload } from "./file-data-url-upload";
import { ReportDetailHeader } from "./report-detail-header";
import type { ReportSubject } from "./record-subject";
import { useRecordChangedRefresh } from "./use-record-changed-refresh";
import { useLeaveToRecordsList, useRecordDeleteDialog } from "./use-record-delete";
import { useReportSidePanelOpen } from "./use-record-side-panel-open";
import { useReportReadingTurn } from "./use-report-reading-turn";
import { useReportDraftSave, useSettledReportSave } from "./use-report-save";
import { ReportSaveFailureBar, reportSaveFailure, useReportSaveState } from "./report-save-state";
import { useRecordRefresh } from "./use-record-refresh";

export function ReportDetail({
  report,
  streamPositions,
  returnTo,
}: {
  report: ReportSubject["report"];
  streamPositions: ReportSubject["streamPositions"];
  returnTo?: string;
}) {
  const refresh = useRecordRefresh();
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
  const tabsEditorRef = useRef<ReportTabsEditorRef>(null);
  const [editorRevision, setEditorRevision] = useState(0);
  const [restoreView, setRestoreView] = useState(report.bodyRestoreView ?? null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const seenRestoreRevisionRef = useRef<number | null>(null);
  const reportIdRef = useRef(report.id);
  const isAssignment = Boolean(report.sourceTemplateId);
  const leaderReading = report.kind === "member" && report.editable !== true;
  const memberAssignee = report.kind === "member" && editable && isAssignment;
  const memberSurface = leaderReading
    ? ("member-leader" as const)
    : memberAssignee
      ? ("member-assignee" as const)
      : ("plain" as const);
  const [sideOpen, setSideOpen] = useReportSidePanelOpen(report.id, memberSurface);
  const { saving, failure, setFailure, begin, track } = useReportSaveState();
  const [favorited, setFavorited] = useState(Boolean(report.favorited));
  const [favoriteBusy, setFavoriteBusy] = useState(false);
  const [keyPointRestartBusy, setKeyPointRestartBusy] = useState(false);
  const [status, setStatus] = useState(report.status);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submitInFlightRef = useRef(false);
  const sendAckTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sendAck, setSendAck] = useState(false);
  const sent = status === "submitted";
  const receivedBaseline = useMemo(() => {
    if (!memberAssignee) return null;
    return normalizeReportContent(report.content).received ?? null;
  }, [memberAssignee, report.content]);
  const [assignmentUnchanged, setAssignmentUnchanged] = useState(
    () => receivedBaseline != null && reportTabsEqual(content, receivedBaseline),
  );
  const readingScroll = (leaderReading && sent) || memberAssignee;
  const readingTurn = useReportReadingTurn(report.id, report.cycle, readingScroll);

  useEffect(() => {
    reportIdRef.current = report.id;
  }, [report.id]);

  useEffect(() => {
    setAssignmentUnchanged(
      receivedBaseline != null && reportTabsEqual(contentRef.current, receivedBaseline),
    );
  }, [receivedBaseline]);

  useEffect(() => {
    setFavorited(Boolean(report.favorited));
  }, [report.favorited, report.id]);

  useEffect(() => {
    setStatus(report.status);
  }, [report.status, report.id]);

  useEffect(() => {
    writeReportVersion(report.id, report.updatedAt);
  }, [report.id, report.updatedAt]);

  useEffect(() => {
    return () => {
      if (sendAckTimerRef.current) clearTimeout(sendAckTimerRef.current);
    };
  }, []);

  function syncAssignmentUnchanged(next: ReportContent) {
    setAssignmentUnchanged(receivedBaseline != null && reportTabsEqual(next, receivedBaseline));
  }

  function replaceContent(next: ReportContent) {
    contentRef.current = next;
    setContent(next);
    syncAssignmentUnchanged(next);
  }

  function exportReport() {
    tabsEditorRef.current?.flush();
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
      await refresh.records();
    } catch {
      setFavorited(!next);
    } finally {
      setFavoriteBusy(false);
    }
  }

  async function persist(
    next: ReportContent,
    nextStatus?: "submitted",
    reportId = reportIdRef.current,
  ) {
    if (!editable) return true;
    const { saved } = saveDraft(reportId, next, { status: nextStatus });
    const ok = await track(
      () => saved,
      () => {
        tabsEditorRef.current?.flush();
        void persist(contentRef.current, nextStatus);
      },
      () => reportId === reportIdRef.current,
      (cause) => {
        if (isAppErrorCode(cause, "CONFLICT")) void refresh.record();
      },
    );
    if (!ok) return false;
    if (reportId === reportIdRef.current && nextStatus) {
      setStatus(nextStatus);
    }
    if (nextStatus === "submitted") {
      showSendAck();
      await refresh.records();
    }
    return true;
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
    tabsEditorRef.current?.flush();
    const unchanged =
      receivedBaseline != null && reportTabsEqual(contentRef.current, receivedBaseline);
    if (submitInFlightRef.current || unchanged) return;
    submitInFlightRef.current = true;
    clearScheduledPersist();
    try {
      await waitForReportSave(report.id);
      await persist(contentRef.current, "submitted");
    } catch (cause) {
      setFailure(reportSaveFailure(cause, () => void submitReport()));
    } finally {
      submitInFlightRef.current = false;
    }
  }

  function schedulePersist(next: ReportContent, meta?: ReportTabsChangeMeta) {
    if (!editable) return;
    const merged: ReportContent = {
      ...contentRef.current,
      tabs: next.tabs,
      tabOrder: next.tabOrder,
    };
    contentRef.current = merged;
    if (meta?.structural) setContent(merged);
    syncAssignmentUnchanged(merged);
    writeReportDraft(reportIdRef.current, merged);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const reportId = reportIdRef.current;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      void persist(contentRef.current, undefined, reportId);
    }, 900);
  }

  async function removeCurrentReport() {
    if (!editable) throw new Error("This report cannot be deleted");
    const end = begin();
    try {
      clearScheduledPersist();
      await waitForReportSave(report.id);
      await removeReport({ data: { reportId: report.id } });
      clearReportDraft(report.id);
      deleteDialog.close();
      await leaveToRecordsList();
    } finally {
      end();
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
    setEditorRevision((value) => value + 1);
  }

  async function onSwitchBodyVersion() {
    if (!editable || restoreBusy) return;
    setRestoreBusy(true);
    try {
      const result = await switchBody({ data: { reportId: report.id } });
      writeReportVersion(report.id, result.updatedAt);
      applyAssistantBody(report.id, result.content, result.bodyRestoreView);
      await refresh.record();
    } finally {
      setRestoreBusy(false);
    }
  }

  useEffect(() => {
    if (!editable || !isAssignment || !report.unread) return;
    let cancelled = false;
    void markOpened({ data: { reportId: report.id } }).then((result) => {
      if (cancelled) return;
      if (result.updatedAt) writeReportVersion(report.id, result.updatedAt);
      const next = withAssignmentUnread(contentRef.current, false);
      contentRef.current = next;
      writeReportDraft(report.id, next);
      void refresh.records();
    });
    return () => {
      cancelled = true;
    };
  }, [editable, isAssignment, markOpened, report.id, report.unread, refresh]);

  useEffect(() => {
    return () => {
      if (!editable) return;
      tabsEditorRef.current?.flush();
      if (!saveTimerRef.current) return;
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
      await refresh.record();
    } finally {
      setKeyPointRestartBusy(false);
    }
  }

  return (
    <RecordSplitLayout
      sideOpen={sideOpen}
      onSideOpenChange={setSideOpen}
      main={
        <>
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

          {failure && <ReportSaveFailureBar failure={failure} retrying={saving} />}

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <ReportTabsEditor
              editorRef={tabsEditorRef}
              content={content}
              editable={editable}
              contentRevision={editorRevision}
              placeholder={m.records_report_body_placeholder()}
              onUploadFile={editable ? fileToDataUrlUpload : undefined}
              trailingTabs={
                leaderReading && sent
                  ? [{ id: KEY_POINT_EXTRACTION_TAB, label: m.records_key_points_tab() }]
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
        </>
      }
      side={
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
      }
    >
      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={deleteDialog.setOpen}
        title={m.records_report_delete_confirm_title({ name: report.title })}
        description={m.records_report_delete_confirm_body()}
        confirmLabel={m.records_report_delete_action()}
        pendingLabel={m.records_delete_pending()}
        errorMessage={m.records_delete_error()}
        onConfirm={removeCurrentReport}
      />
    </RecordSplitLayout>
  );
}
