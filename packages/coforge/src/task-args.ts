import {
  CHANNEL_NAME_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskCommand,
  type TaskRef,
  type TaskResourceReceipt,
  type TaskPriority,
  type TaskStatus,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { unknownCommandError } from "./command-help";
import { reviewerIsolationFromEnvironment } from "#src/reviewer-isolation";
import {
  parseTaskConversationArgs,
  type TaskConversationInvocation,
} from "#src/task-conversation-args";

export type TaskInvocation = {
  command: "task";
  task: Omit<TaskCommand, "idempotencyKey">;
  json?: boolean;
};

const TASK_OPERATIONS = [
  "list",
  "show",
  "create",
  "convert",
  "claim",
  "unclaim",
  "assign",
  "unassign",
  "update",
  "amend",
  "history",
  "delete",
  "receipt",
] as const;
type TaskOperation = (typeof TASK_OPERATIONS)[number];

/** The flags each `task` subcommand takes. */
const TASK_FLAGS: Record<TaskOperation, readonly string[]> = {
  list: ["--target", "--mine", "--status", "--ready", "--label", "--json"],
  show: ["--target", "--peer-kind", "--number", "--json"],
  create: [
    "--target",
    "--peer-kind",
    "--title",
    "--assignee",
    "--creates-resource",
    "--description",
    "--message-id",
    "--alongside",
    "--blocked-by",
    "--parent",
    "--label",
    "--label-description",
    "--project",
    "--anyway",
    "--priority",
    "--json",
  ],
  convert: ["--target", "--peer-kind", "--message-id", "--json"],
  claim: [
    "--target",
    "--peer-kind",
    "--number",
    "--message-id",
    "--reviewer-isolation",
    "--anyway",
    "--json",
  ],
  unclaim: ["--target", "--peer-kind", "--number", "--expected-revision", "--json"],
  assign: [
    "--target",
    "--peer-kind",
    "--number",
    "--assignee",
    "--expected-revision",
    "--anyway",
    "--json",
  ],
  unassign: ["--target", "--peer-kind", "--number", "--expected-revision", "--json"],
  update: [
    "--target",
    "--peer-kind",
    "--number",
    "--status",
    "--priority",
    "--label",
    "--label-description",
    "--expected-revision",
    "--reviewer-isolation",
    "--json",
  ],
  amend: [
    "--target",
    "--peer-kind",
    "--number",
    "--title",
    "--description",
    "--clear-description",
    "--clear-project",
    "--blocked-by",
    "--parent",
    "--label",
    "--label-description",
    "--project",
    "--clear-project",
    "--expected-revision",
    "--reviewer-isolation",
    "--json",
  ],
  history: ["--target", "--peer-kind", "--number", "--json"],
  delete: ["--target", "--peer-kind", "--number", "--json"],
  receipt: [
    "--target",
    "--peer-kind",
    "--number",
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
    "--json",
  ],
};

/** Flags a subcommand accepts more than once. `update` counts its `--number`s only to refuse
 * more than one by name. */
const TASK_REPEATABLE_FLAGS: Partial<Record<TaskOperation, readonly string[]>> = {
  create: ["--title", "--label"],
  list: ["--label"],
  claim: ["--number", "--message-id"],
  update: ["--number"],
  amend: ["--label"],
};

const TASK_SWITCHES = new Set([
  "--clear-description",
  "--reviewer-isolation",
  "--mine",
  "--ready",
  "--creates-resource",
  "--alongside",
  "--anyway",
  "--json",
]);

const TASK_TARGET = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,63})$/;

function invalidTaskArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

/** A positive integer, or an invalid-argument refusal saying `message`. */
function positiveInt(raw: string, message: string): number {
  // Digits only: `Number()` would also take `1e1`, `0x10` and `1.0`.
  const value = /^[0-9]+$/.test(raw.trim()) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidTaskArg(message);
  return value;
}

function taskNumber(raw: string | undefined): number {
  if (raw === undefined) throw invalidTaskArg("--number is required");
  return positiveInt(raw, `--number must be a positive integer; got ${raw}`);
}

function expectedRevisionOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value < 0)
    throw invalidTaskArg(`--expected-revision must be a non-negative integer; got ${raw}`);
  return value;
}

/**
 * A task by number: `7` in the target's own conversation, or `#channel:#7` (Raft's form) in a
 * channel of the Workspace. The old `#channel/7` is not accepted: published Computers parse their
 * own arguments, so only the new release needs this form.
 */
function taskRefOption(raw: string, message: string): TaskRef {
  const part = raw.trim();
  const match = /^#([a-z0-9][a-z0-9_-]{0,31}):#?([1-9]\d*)$/.exec(part);
  if (match) {
    const channel = match[1]!;
    if (!CHANNEL_NAME_PATTERN.test(channel)) throw invalidTaskArg(message);
    return { number: Number(match[2]!), channel };
  }
  if (part.startsWith("#") && part.includes(":")) throw invalidTaskArg(message);
  return { number: positiveInt(part, message) };
}

/** `--blocked-by 3,#coforge:#388`: the tasks a task waits for. An amendment may pass `''` to clear them. */
function blockedByOption(raw: string, clearable: boolean): TaskRef[] {
  if (raw.trim() === "") {
    if (clearable) return [];
    throw invalidTaskArg("--blocked-by must list tasks, like 3,5 or 3,#channel:#7");
  }
  return raw
    .split(",")
    .map((part) =>
      taskRefOption(part, `--blocked-by must be tasks like 3,#channel:#7; got ${raw}`),
    );
}

/** `--parent 7` or `--parent '#coforge:#7'`. An amendment may pass `''` to make the task top level. */
function parentOption(raw: string, clearable: boolean): TaskRef | null {
  if (raw.trim() === "" && clearable) return null;
  return taskRefOption(
    raw,
    `--parent must be a task like 7 or #channel:#7${clearable ? " (or '' for none)" : ""}; got ${raw}`,
  );
}

/** A handle the server can resolve: `@`, then a lowercase username or Agent name. */
const TASK_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,63}$/;

/** A `@handle` option: trimmed, with the handle after `@` trimmed too. */
function handleOption(raw: string, message: string): string {
  const value = raw.trim();
  const handle = `@${value.slice(1).trim()}`;
  if (!value.startsWith("@") || !TASK_HANDLE.test(handle)) throw invalidTaskArg(message);
  return handle;
}

/** `task` and its arguments: a command on a task's own conversation, or a board operation. */
export function parseTaskArgs(
  args: readonly string[],
): TaskInvocation | TaskConversationInvocation {
  const conversation = parseTaskConversationArgs(args);
  if (conversation) return conversation;
  const operation = args[0] as TaskOperation | undefined;
  if (!operation || !(TASK_OPERATIONS as readonly string[]).includes(operation))
    throw unknownCommandError(["task", ...args]);
  const allowed = TASK_FLAGS[operation];
  const repeatable = TASK_REPEATABLE_FLAGS[operation] ?? [];
  const values = new Map<string, string[]>();
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]!;
    if (!allowed.includes(name)) throw new Error("Usage:");
    if (values.has(name) && !repeatable.includes(name)) throw new Error("Usage:");
    if (TASK_SWITCHES.has(name)) {
      values.set(name, ["true"]);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error("Usage:");
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  const one = (flag: string) => values.get(flag)?.[0];

  const mine = values.has("--mine");
  const target = one("--target");
  const peerKind = one("--peer-kind");
  const json = values.has("--json");
  if (peerKind !== undefined && peerKind !== "human" && peerKind !== "agent")
    throw invalidTaskArg(`--peer-kind must be human or agent; got ${peerKind}`);
  if (peerKind !== undefined && !target?.startsWith("@"))
    throw invalidTaskArg("--peer-kind can only be used with a direct @peer target");
  if (operation === "list") validateTaskListScope(target, mine, one("--status"));
  if (values.has("--ready") && (mine || one("--status") !== undefined))
    throw invalidTaskArg(
      "--ready lists a conversation's todo tasks; do not combine it with --mine or --status",
    );
  if (!mine) {
    if (!target?.trim()) throw invalidTaskArg("--target is required");
    if (!TASK_TARGET.test(target))
      throw invalidTaskArg(
        `--target must be a conversation ('#channel' or '@peer'); got ${target}`,
      );
  }

  const task: Omit<TaskCommand, "idempotencyKey"> = {
    operation,
    target,
    ...(peerKind ? { peerKind: peerKind as "human" | "agent" } : {}),
    ...(mine ? { mine: true } : {}),
  };
  if (operation === "list") {
    task.status = one("--status") as TaskStatus | "all" | undefined;
    if (values.has("--ready")) task.ready = true;
    const labels = (values.get("--label") ?? []).map((label) => label.trim());
    if (labels.some((label) => !label)) throw invalidTaskArg("--label must name a label");
    if (labels.length) task.labels = labels;
  } else if (operation === "create") {
    const titles = values.get("--title") ?? [];
    if (!titles.length) throw invalidTaskArg("--title is required (at least one)");
    if (titles.some((title) => !title.trim())) throw invalidTaskArg("--title must be nonblank");
    if (titles.length === 1) task.title = titles[0];
    else task.titles = titles;
    if (values.has("--anyway")) task.continueAnyway = true;
    const assignee = one("--assignee");
    if (assignee !== undefined)
      task.assignee = handleOption(assignee, "--assignee must be an @handle");
    if (values.has("--creates-resource")) task.createsResource = true;
    const description = one("--description");
    if (description !== undefined) {
      if (titles.length !== 1)
        throw invalidTaskArg("--description can only be used with a single --title");
      if (!description.trim()) throw invalidTaskArg("--description must not be empty");
      task.description = description;
    }
    const sourceMessage = one("--message-id")?.trim();
    if (sourceMessage === "") throw invalidTaskArg("--message-id must not be empty");
    if (sourceMessage) task.messageId = sourceMessage;
    if (values.has("--alongside")) task.alongside = true;
    const blockedBy = one("--blocked-by");
    if (blockedBy !== undefined) task.blockedBy = blockedByOption(blockedBy, false);
    const parent = one("--parent");
    if (parent !== undefined) task.parent = parentOption(parent, false);
    const labels = (values.get("--label") ?? []).map((label) => label.trim());
    if (labels.some((label) => !label || label.startsWith("-")))
      throw invalidTaskArg(
        "--label on create names a label to attach; to take one off use `task amend --label -name`",
      );
    if (labels.length) task.labels = labels;
    const labelDescription = one("--label-description")?.trim();
    if (labelDescription !== undefined) {
      if (!labelDescription) throw invalidTaskArg("--label-description must not be empty");
      task.labelDescription = labelDescription;
    }
    const project = one("--project")?.trim();
    if (project !== undefined) {
      if (!project) throw invalidTaskArg("--project must name a Project by slug");
      task.project = project;
    }
  } else if (operation === "convert") {
    const messageId = one("--message-id")?.trim();
    if (!messageId) throw invalidTaskArg("--message-id is required");
    task.messageId = messageId;
  } else if (operation === "claim") {
    const numbers = (values.get("--number") ?? []).map(taskNumber);
    const messageIds = (values.get("--message-id") ?? []).map((id) => id.trim());
    if (!numbers.length && !messageIds.length)
      throw invalidTaskArg("Provide at least one --number or --message-id");
    if (messageIds.some((id) => !id)) throw invalidTaskArg("--message-id must be nonblank");
    if (numbers.length === 1) task.number = numbers[0];
    else if (numbers.length) task.numbers = numbers;
    if (messageIds.length === 1) task.messageId = messageIds[0];
    else if (messageIds.length) task.messageIds = messageIds;
    if (values.has("--anyway")) task.continueAnyway = true;
  } else if (operation === "update") {
    const numbers = values.get("--number") ?? [];
    if (numbers.length !== 1)
      throw invalidTaskArg(
        numbers.length === 0
          ? "Provide exactly one --number"
          : `task update accepts exactly one --number; received ${numbers.length}. Run task update once per task.`,
      );
    task.number = taskNumber(numbers[0]);
    const rawLabels = values.get("--label") ?? [];
    const addedLabels: string[] = [];
    const removedLabels: string[] = [];
    for (const raw of rawLabels) {
      const name = raw.trim();
      if (!name) throw invalidTaskArg("--label must name a label");
      if (name.startsWith("-")) removedLabels.push(name.slice(1));
      else addedLabels.push(name);
    }
    if (addedLabels.length) task.labels = addedLabels;
    if (removedLabels.length) task.removeLabels = removedLabels;
    const labelDescription = one("--label-description")?.trim();
    if (labelDescription !== undefined) {
      if (!labelDescription) throw invalidTaskArg("--label-description must not be empty");
      task.labelDescription = labelDescription;
    }
    const status = one("--status");
    if (
      status === undefined &&
      !values.has("--priority") &&
      addedLabels.length === 0 &&
      removedLabels.length === 0
    )
      throw invalidTaskArg("task update needs --status, --priority or --label");
    if (
      (addedLabels.length || removedLabels.length) &&
      (status !== undefined || values.has("--priority"))
    )
      throw invalidTaskArg(
        "task update takes --label on its own; run the status or priority change separately",
      );
    // A label edit is an amendment; the server's update path moves status and priority only.
    if (addedLabels.length || removedLabels.length) task.operation = "amend";
    if (status !== undefined) {
      if (!(TASK_STATUSES as readonly string[]).includes(status))
        throw invalidTaskArg(`--status must be one of: ${TASK_STATUSES.join(", ")}; got ${status}`);
      task.status = status as TaskStatus;
    }
  } else {
    task.number = taskNumber(one("--number"));
  }

  const priority = one("--priority");
  if (priority !== undefined) {
    if (!(TASK_PRIORITIES as readonly string[]).includes(priority))
      throw invalidTaskArg(
        `--priority must be one of: ${TASK_PRIORITIES.join(", ")}; got ${priority}`,
      );
    task.priority = priority as TaskPriority;
  }

  if (operation === "assign") {
    const assignee = one("--assignee")?.trim();
    if (!assignee)
      throw invalidTaskArg(
        "--assignee <@who> is required; to clear the assignee use `coforge task unassign`",
      );
    task.assignee = handleOption(
      assignee.startsWith("@") ? assignee : `@${assignee}`,
      "--assignee must be an @handle",
    );
    if (values.has("--anyway")) task.continueAnyway = true;
  }
  if (operation === "amend") {
    const description = one("--description");
    const clear = values.has("--clear-description");
    if (description !== undefined && clear)
      throw invalidTaskArg("Use either --description or --clear-description, not both");
    const title = one("--title");
    const blockedBy = one("--blocked-by");
    const parent = one("--parent");
    const project = one("--project")?.trim();
    const clearProject = values.has("--clear-project");
    if (project !== undefined && clearProject)
      throw invalidTaskArg("Use either --project or --clear-project, not both");
    if (project === "") throw invalidTaskArg("--project must name a Project by slug");
    const rawLabels = values.get("--label") ?? [];
    const addedLabels = rawLabels
      .filter((label) => !label.trimStart().startsWith("-"))
      .map((label) => label.trim());
    const removedLabels = rawLabels
      .filter((label) => label.trimStart().startsWith("-"))
      .map((label) => label.trim().slice(1).trim());
    if ([...addedLabels, ...removedLabels].some((label) => !label))
      throw invalidTaskArg("--label must name a label; --label -name takes one off");
    if (
      title === undefined &&
      description === undefined &&
      !clear &&
      blockedBy === undefined &&
      parent === undefined &&
      addedLabels.length === 0 &&
      removedLabels.length === 0 &&
      project === undefined &&
      !clearProject
    )
      throw invalidTaskArg(
        "At least one amendment is required: --title, --description, --clear-description, --blocked-by, --parent, --label, --project, or --clear-project",
      );
    if (blockedBy !== undefined) task.blockedBy = blockedByOption(blockedBy, true);
    if (parent !== undefined) task.parent = parentOption(parent, true);
    if (addedLabels.length) task.labels = addedLabels;
    if (removedLabels.length) task.removeLabels = removedLabels;
    const labelDescription = one("--label-description")?.trim();
    if (labelDescription !== undefined) {
      if (!labelDescription) throw invalidTaskArg("--label-description must not be empty");
      task.labelDescription = labelDescription;
    }
    if (clearProject) task.project = null;
    else if (project !== undefined) task.project = project;
    if (title !== undefined) task.title = title;
    if (clear) task.description = null;
    else if (description !== undefined) task.description = description;
  }
  if (operation === "receipt") task.receipt = taskReceiptArgs(one);
  const expectedRevision = expectedRevisionOption(one("--expected-revision"));
  if (expectedRevision !== undefined) task.expectedRevision = expectedRevision;
  if (
    ["claim", "update", "amend"].includes(operation) &&
    (values.has("--reviewer-isolation") || reviewerIsolationFromEnvironment())
  )
    task.freshnessContextMode = "withheld";
  return { command: "task", task, ...(json ? { json: true } : {}) };
}

/** The seven resource-receipt fields, each required and nonblank. */
function taskReceiptArgs(one: (flag: string) => string | undefined): TaskResourceReceipt {
  const required = (flag: string) => {
    const value = one(flag)?.trim();
    if (!value) throw invalidTaskArg(`${flag} is required and must be nonblank`);
    return value;
  };
  const teardownOwner = handleOption(
    required("--teardown-owner"),
    "--teardown-owner must be an @agent handle",
  );
  const expiry = new Date(required("--expiry"));
  if (!Number.isFinite(expiry.getTime()))
    throw invalidTaskArg("--expiry must be an ISO-8601 timestamp");
  return {
    object: required("--object"),
    purpose: required("--purpose"),
    teardownOwner,
    securityPrivacy: required("--security-privacy"),
    expiry: expiry.toISOString(),
    runbook: required("--runbook"),
    tracking: required("--tracking"),
  };
}

const TASK_LIST_STATUSES = ["all", ...TASK_STATUSES] as const;

/** `task list` reads one conversation (`--target`) or this Agent's own Tasks (`--mine`). */
function validateTaskListScope(target: string | undefined, mine: boolean, status?: string) {
  if (status !== undefined && !(TASK_LIST_STATUSES as readonly string[]).includes(status))
    throw invalidTaskArg(`--status must be one of ${TASK_LIST_STATUSES.join("|")}; got ${status}`);
  if (mine && target) throw invalidTaskArg("--mine cannot be combined with --target");
  if (!mine && !target) throw invalidTaskArg("--target is required (or pass --mine)");
}
