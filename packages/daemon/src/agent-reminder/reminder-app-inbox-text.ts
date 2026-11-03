import type { ReminderJob } from "@lrm/coforge-sdk/internal";
import { APP_INBOX_PREVIEW_MAX_CHARS } from "#src/agent-app-inbox/registry";

/** Projects canonical reminder text into the strict, bounded App Inbox preview. */
export function reminderAppInboxPreview(title: string): string {
  const withoutControls = [...title]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
    })
    .join("");
  const singleLine = withoutControls.replace(/\s+/g, " ").trim();
  let preview = singleLine.slice(0, APP_INBOX_PREVIEW_MAX_CHARS);
  const lastCodeUnit = preview.charCodeAt(preview.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) preview = preview.slice(0, -1);
  return preview;
}

/** The App Inbox summary of a due reminder. One that reached the Agent late (the daemon was offline
 * at its time, or delivery kept failing) says so and names when it was due, so the Agent can judge
 * whether it still applies. */
export function reminderAppInboxSummary(job: ReminderJob, late: boolean): string {
  if (!late) return "Reminder due";
  return `Overdue: was due ${new Date(job.fireAt).toISOString()}, delivered late`;
}
