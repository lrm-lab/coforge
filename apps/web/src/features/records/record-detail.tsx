import { NoteDetail } from "./note-detail";
import type { NoteSubject, ReportSubject } from "./record-subject";
import { ReportDetail } from "./report-detail";
import { TemplateReportDetail } from "./template-report-detail";

export function RecordDetail({
  subject,
  returnTo,
}: {
  subject: ReportSubject | NoteSubject;
  /** When set (from key-point @source links), show back to that Records path. */
  returnTo?: string;
}) {
  if (subject.type === "note") {
    return <NoteDetail key={subject.note.id} note={subject.note} />;
  }
  if (subject.report.kind === "template") {
    return (
      <TemplateReportDetail key={subject.report.id} report={subject.report} returnTo={returnTo} />
    );
  }
  return <ReportDetail key={subject.report.id} report={subject.report} returnTo={returnTo} />;
}
