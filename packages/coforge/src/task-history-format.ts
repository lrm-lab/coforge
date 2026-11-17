import type { TaskHistoryEvent, TaskResult } from "@lrm/coforge-sdk/internal";
import { fenceMessageBody } from "#src/message-body-format";
import { showRelationLines } from "#src/task-relations-format";

function historyActor(event: TaskHistoryEvent): string {
  if (event.actorType === "system") return "@system";
  return event.actorName ? `@${event.actorName}` : "<unresolved>";
}

export function formatTaskHistory(result: TaskResult): string {
  const task = result.tasks[0]!;
  const events = result.history?.length
    ? result.history
        .map((event) => {
          const lines = [
            `seq=${event.seq} time=${event.createdAt} actor=${historyActor(event)} type=${event.eventType}`,
            `  ${JSON.stringify(event.payload)}`,
          ];
          if (event.eventType === "amended") {
            const { title, description } = event.payload.changes;
            lines.push(
              "  Superseded card:",
              ...(title ? [`    title: ${fenceMessageBody(title.from)}`] : []),
              ...(description
                ? [`    description: ${fenceMessageBody(description.from ?? "(none set)")}`]
                : []),
            );
          }
          return lines.join("\n");
        })
        .join("\n")
    : "No recorded events.";
  const description = task.description ? fenceMessageBody(task.description) : "(none set)";
  return `## Task #${task.number} history — revision ${task.revision}\n\nCurrent title: ${fenceMessageBody(task.title)}\nCurrent description: ${description}\n\n${events}`;
}

/** The card after `coforge task amend`, with the revision and the history event it recorded. */
export function formatTaskAmended(result: TaskResult): string {
  const task = result.tasks[0]!;
  const event = result.history?.at(-1);
  const details =
    task.description === null || task.description === undefined
      ? "details: <none>"
      : `details:\n  ${fenceMessageBody(task.description)}`;
  const superseded =
    event?.eventType === "amended"
      ? [
          "superseded card:",
          ...(event.payload.changes.title
            ? [`  title: ${fenceMessageBody(event.payload.changes.title.from)}`]
            : []),
          ...(event.payload.changes.description
            ? [
                `  description: ${fenceMessageBody(event.payload.changes.description.from ?? "(none set)")}`,
              ]
            : []),
        ]
      : [];
  return [
    `#${task.number} amended — revision ${task.revision}${event ? `, event seq ${event.seq}.` : "; no change recorded."}`,
    `title: ${fenceMessageBody(task.title)}`,
    details,
    ...superseded,
    ...showRelationLines(task),
  ].join("\n");
}
