import type { StreamPositions } from "#src/features/realtime/subscription-gap";
import type { ReportBodyRestoreView, ReportContent } from "./records-content";
import type { TemplateChild } from "./template-children-table";

export type ReportSubject = {
  type: "report";
  report: {
    id: string;
    kind: string;
    title: string;
    status: string;
    content: ReportContent;
    bodyRestoreView?: ReportBodyRestoreView | null;
    submittedAt?: string | null;
    sharedBy?: {
      userId: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
    author: { userId: string; username: string; displayName: string; avatarUrl: string | null };
    cycle: { id: string; year: number; week: number; title: string };
    sourceTemplateId?: string | null;
    unread?: boolean;
    canSendAssignments?: boolean;
    sendSchedule?: {
      sendWeekday: number;
      sendTime: string;
      scheduleEnabled: boolean;
      autoSendCancelled: boolean;
      alreadySent: boolean;
    } | null;
    editable?: boolean;
    favorited?: boolean;
    surface?: "format" | "overview";
    children?: TemplateChild[];
  };
  /** Where the viewer's own channel stood when the report was read (`loadRecordSubject`). */
  streamPositions?: StreamPositions;
};

export type NoteSubject = {
  type: "note";
  note: {
    id: string;
    title: string;
    body: string;
    updatedAt: string;
    author: { userId: string; username: string; displayName: string };
  };
};
