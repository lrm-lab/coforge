import {
  isTaskRef,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskCommand,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { LABEL_NAME_MAX, LABELS_PER_TASK_MAX } from "./labels.server";
import { TASK_PRIORITY_INVALID } from "./task-priority.server";

/**
 * The shape a Task command must have before `TaskBoard.execute` reads anything: its operation,
 * exactly one of a conversation, a target or `mine`, and the fields that operation takes. A
 * malformed command is `INVALID_INPUT`; who may act on which conversation is TaskBoard's.
 */
export function validateTaskCommand(command: TaskCommand) {
  const operations = [
    "list",
    "show",
    "create",
    "convert",
    "claim",
    "unclaim",
    "update",
    "assign",
    "unassign",
    "amend",
    "history",
    "delete",
    "restore",
    "receipt",
  ];
  if (!operations.includes(command.operation) || !command.idempotencyKey)
    throw new AppError("INVALID_INPUT");
  if ((command.conversationId ? 1 : 0) + (command.target ? 1 : 0) + (command.mine ? 1 : 0) !== 1)
    throw new AppError("INVALID_INPUT");
  if (command.target?.includes(":")) throw new AppError("INVALID_INPUT");
  if (command.number !== undefined && (!Number.isSafeInteger(command.number) || command.number < 1))
    throw new AppError("INVALID_INPUT");
  if (
    command.expectedRevision !== undefined &&
    (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
  )
    throw new AppError("INVALID_INPUT");
  if (
    command.status !== undefined &&
    !["all", "todo", "in_progress", "in_review", "done", "closed"].includes(command.status)
  )
    throw new AppError("INVALID_INPUT");
  if (command.status === "all" && command.operation !== "list") throw new AppError("INVALID_INPUT");
  // Several statuses are a list's pick only (task #506), of known statuses, never with `status`.
  if (
    command.statuses !== undefined &&
    (command.operation !== "list" ||
      command.status !== undefined ||
      !Array.isArray(command.statuses) ||
      command.statuses.length === 0 ||
      command.statuses.length > TASK_STATUSES.length ||
      !command.statuses.every((status) => (TASK_STATUSES as readonly string[]).includes(status)))
  )
    throw new AppError("INVALID_INPUT");
  if (command.peerKind !== undefined && !["human", "agent"].includes(command.peerKind))
    throw new AppError("INVALID_INPUT");
  if (command.peerKind !== undefined && !command.target?.startsWith("@"))
    throw new AppError("INVALID_INPUT");
  if (command.numbers?.some((number) => !Number.isSafeInteger(number) || number < 1))
    throw new AppError("INVALID_INPUT");
  if (command.messageIds?.some((messageId) => !messageId.trim()))
    throw new AppError("INVALID_INPUT");
  if (
    command.operation !== "update" &&
    command.operation !== "unclaim" &&
    command.operation !== "assign" &&
    command.operation !== "unassign" &&
    command.operation !== "amend" &&
    command.expectedRevision !== undefined
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "unassign" && command.assignee !== undefined)
    throw new AppError("INVALID_INPUT");
  if (
    command.operation !== "update" &&
    command.operation !== "list" &&
    command.status !== undefined
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "create") {
    const titles = command.titles ?? (command.title === undefined ? [] : [command.title]);
    if (
      titles.length === 0 ||
      (command.title !== undefined && command.titles !== undefined) ||
      titles.some((value) => !value.trim() || value.trim().length > 8_000)
    )
      throw new AppError("INVALID_INPUT");
    // `messageId` names the source message under task conversations; the board refuses it where
    // they are off.
    if (command.number !== undefined) throw new AppError("INVALID_INPUT");
  }
  // A priority is one of five, set on create or by an update (with or without a status).
  if (
    command.priority !== undefined &&
    (!(TASK_PRIORITIES as readonly unknown[]).includes(command.priority) ||
      (command.operation !== "create" && command.operation !== "update"))
  )
    throw new AppError("INVALID_INPUT", {
      errorId: TASK_PRIORITY_INVALID,
      hint: `the priority must be one of ${TASK_PRIORITIES.join(", ")}, on create or update`,
    });
  const relational = command.operation === "create" || command.operation === "amend";
  const labelsAllowed =
    command.operation === "create" || command.operation === "amend" || command.operation === "list";
  for (const labels of [command.labels, command.removeLabels]) {
    if (labels === undefined) continue;
    if (
      !labelsAllowed ||
      !Array.isArray(labels) ||
      labels.length > LABELS_PER_TASK_MAX ||
      labels.some(
        (name) => typeof name !== "string" || !name.trim() || name.trim().length > LABEL_NAME_MAX,
      )
    )
      throw new AppError("INVALID_INPUT");
  }
  if (
    command.labelDescription !== undefined &&
    (command.labels === undefined ||
      typeof command.labelDescription !== "string" ||
      !command.labelDescription.trim() ||
      command.labelDescription.length > 500)
  )
    throw new AppError("INVALID_INPUT");
  // Only an amendment takes a label off; a new Task starts with the labels it is given, and a list
  // filters by them.
  if (command.operation !== "amend" && command.removeLabels !== undefined)
    throw new AppError("INVALID_INPUT");
  if (command.project !== undefined) {
    const clearing = command.project === null && command.operation === "amend";
    if (
      (command.operation !== "create" && command.operation !== "amend") ||
      (!clearing && (typeof command.project !== "string" || !command.project.trim()))
    )
      throw new AppError("INVALID_INPUT");
  }
  if (command.blockedBy !== undefined) {
    if (
      !relational ||
      !Array.isArray(command.blockedBy) ||
      command.blockedBy.length > 100 ||
      !command.blockedBy.every(isTaskRef)
    )
      throw new AppError("INVALID_INPUT");
  }
  if (command.parent !== undefined) {
    // Only an amendment detaches (null); a new Task is made under a parent or at the top.
    const detaching = command.parent === null && command.operation === "amend";
    if (!relational || (!detaching && !isTaskRef(command.parent)))
      throw new AppError("INVALID_INPUT");
  }
  if (command.ready !== undefined && (command.operation !== "list" || command.mine))
    throw new AppError("INVALID_INPUT");
  if (command.ready && command.status !== undefined) throw new AppError("INVALID_INPUT");
  if (
    command.alongside !== undefined &&
    command.operation !== "create" &&
    command.operation !== "convert"
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation === "amend") {
    if (
      command.title !== undefined &&
      (typeof command.title !== "string" ||
        !command.title.trim() ||
        command.title.trim().length > 10_000)
    )
      throw new AppError("INVALID_INPUT");
    if (
      command.description !== undefined &&
      command.description !== null &&
      (typeof command.description !== "string" || command.description.length > 50_000)
    )
      throw new AppError("INVALID_INPUT");
  }
  if (
    [
      "show",
      "unclaim",
      "update",
      "assign",
      "unassign",
      "amend",
      "history",
      "delete",
      "restore",
      "receipt",
    ].includes(command.operation) &&
    !command.number
  )
    throw new AppError("INVALID_INPUT");
  // An update moves the status, sets the priority, or both.
  if (command.operation === "update" && !command.status && command.priority === undefined)
    throw new AppError("INVALID_INPUT");
  if (
    ["convert", "claim"].includes(command.operation) &&
    !command.number &&
    !command.messageId &&
    !command.numbers?.length &&
    !command.messageIds?.length
  )
    throw new AppError("INVALID_INPUT");
  if (command.operation !== "claim" && (command.numbers || command.messageIds))
    throw new AppError("INVALID_INPUT");
}

/** A short duplicate window catches concurrent Agent work without banning legitimate repeated work. */
export const DUPLICATE_TASK_WINDOW_MS = 15 * 60 * 1000;

export function normalizeTaskTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}
