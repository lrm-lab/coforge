import {
  codePointLength,
  foldUntrustedLine,
  truncateCodePoints,
  type AgentStartOpenTasks,
} from "@lrm/coforge-sdk/internal";

const OPEN_TASK_REF_MAX_CHARS = 200;
const OPEN_TASK_TITLE_MAX_CHARS = 140;

export const VERIFY_TASK_TO_RESUME =
  "Open only the selected task with `coforge task view` if its details are missing or have changed. Verify current ownership, status and blockers before resuming. Wait for any pending approval or acceptance.";

export const OPEN_TASKS_RESUME_ACTION =
  'After current requests, reuse current task list results or run `coforge task list --mine` once. Follow "Your queue" if shown and pick work that can proceed. ' +
  VERIFY_TASK_TO_RESUME;

export function hasStartOpenTasks(
  openTasks: AgentStartOpenTasks | undefined,
): openTasks is AgentStartOpenTasks {
  return (openTasks?.tasks.length ?? 0) > 0;
}

function replaceControlChars(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (i > last) out += value.slice(last, i);
      out += " ";
      last = i + 1;
    }
  }
  if (last === 0) return value;
  return last < value.length ? out + value.slice(last) : out;
}

function singleLineText(value: string, maxChars: number): string {
  const flat = foldUntrustedLine(replaceControlChars(value));
  if (flat.length <= maxChars || codePointLength(flat) <= maxChars) return flat;
  return `${truncateCodePoints(flat, maxChars - 1).trimEnd()}…`;
}

export function formatStartOpenTaskLines(openTasks: AgentStartOpenTasks): string {
  const lines = openTasks.tasks.map((task) => {
    const ref = singleLineText(task.ref, OPEN_TASK_REF_MAX_CHARS);
    const title = singleLineText(task.title, OPEN_TASK_TITLE_MAX_CHARS);
    return `- ${ref} [${task.status}]${title ? ` ${title}` : ""}`;
  });
  if (openTasks.more > 0) {
    lines.push(`- …and ${openTasks.more} more: \`coforge task list --mine\``);
  }
  return lines.join("\n");
}
