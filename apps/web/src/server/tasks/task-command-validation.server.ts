import {
  isTaskRef,
  TASK_CREATE_STATUSES,
  TASK_PRIORITY_LEVELS,
  TASK_WRITE_STATUSES,
  TASK_READ_STATUSES,
  taskAssignReasonProblem,
  taskStatusReasonProblem,
  type TaskCommand,
} from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { LABEL_NAME_MAX, LABELS_PER_TASK_MAX } from "./labels.server";
import { refuseAssignReason, refuseStatusReason } from "./task-assign-reason.server";
import { TASK_PRIORITY_INVALID } from "./task-priority.server";

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
    command.status !== "all" &&
    !(
      (command.operation === "list" || command.operation === "update"
        ? TASK_READ_STATUSES
        : command.operation === "create"
          ? TASK_CREATE_STATUSES
          : TASK_WRITE_STATUSES) as readonly unknown[]
    ).includes(command.status)
  )
    throw new AppError("INVALID_INPUT");
  if (command.status === "all" && command.operation !== "list") throw new AppError("INVALID_INPUT");
  if (
    command.status !== undefined &&
    command.operation !== "update" &&
    command.operation !== "list" &&
    command.operation !== "create"
  )
    throw new AppError("INVALID_INPUT");
  if (
    command.operation === "create" &&
    command.status !== undefined &&
    command.createsResource &&
    command.status !== "todo"
  )
    throw new AppError("INVALID_INPUT", {
      hint: "a Task made to create a resource starts in todo; its receipt moves it to done",
    });
  if (
    command.statuses !== undefined &&
    (command.operation !== "list" ||
      command.status !== undefined ||
      !Array.isArray(command.statuses) ||
      command.statuses.length === 0 ||
      command.statuses.length > TASK_READ_STATUSES.length ||
      !command.statuses.every((status) =>
        (TASK_READ_STATUSES as readonly string[]).includes(status),
      ))
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
  if (command.reason !== undefined) {
    if (typeof command.reason !== "string") throw new AppError("INVALID_INPUT");
    if (command.operation === "assign") {
      const problem = taskAssignReasonProblem(command.reason);
      if (problem) refuseAssignReason(problem);
    } else if (command.operation === "update") {
      const problem = taskStatusReasonProblem(command.status ?? "todo", command.reason);
      if (problem) refuseStatusReason(problem);
    } else {
      throw new AppError("INVALID_INPUT");
    }
  }
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
  // A priority is set on create, convert or by an update (with or without a status), and only
  // ever to one of the four levels — `none` is the stored level of an unprioritized Task,
  // never a choice a command may name (task #12). An absent priority is still accepted on
  // create and convert while older Computers send none; the Agent route logs those.
  if (
    command.priority !== undefined &&
    (!(TASK_PRIORITY_LEVELS as readonly unknown[]).includes(command.priority) ||
      (command.operation !== "create" &&
        command.operation !== "convert" &&
        command.operation !== "update"))
  )
    throw new AppError("INVALID_INPUT", {
      errorId: TASK_PRIORITY_INVALID,
      hint: `the priority must be one of ${TASK_PRIORITY_LEVELS.join(", ")}, on create, convert or update`,
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
  // Null files a new Task under no Project, whatever the viewer last used, and takes an amended
  // Task out of its own.
  if (command.project !== undefined) {
    if (
      (command.operation !== "create" && command.operation !== "amend") ||
      (command.project !== null && (typeof command.project !== "string" || !command.project.trim()))
    )
      throw new AppError("INVALID_INPUT");
  }
  // A due instant is set on create and changed or cleared (null) on amend; nothing else takes
  // one, and the instant must be an ISO datetime (task #13).
  if (command.dueAt !== undefined) {
    const clearing = command.dueAt === null && command.operation === "amend";
    if (
      (command.operation !== "create" && command.operation !== "amend") ||
      (!clearing &&
        (typeof command.dueAt !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(command.dueAt) ||
          Number.isNaN(Date.parse(command.dueAt))))
    )
      throw new AppError("INVALID_INPUT", {
        hint: "dueAt must be an ISO datetime on create, or a datetime or null on amend",
      });
  }
  if (
    command.dueHasTime !== undefined &&
    (!["create", "amend"].includes(command.operation) ||
      typeof command.dueHasTime !== "boolean" ||
      typeof command.dueAt !== "string")
  )
    throw new AppError("INVALID_INPUT", {
      hint: "dueHasTime requires a string dueAt on create or amend",
    });
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
