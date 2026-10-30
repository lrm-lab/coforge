import {
  TASK_STATUSES,
  type TaskCommand,
  type TaskResourceReceipt,
  type TaskStatus,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { reviewerIsolationFromEnvironment } from "#src/reviewer-isolation";
import {
  parseTaskConversationArgs,
  type TaskConversationInvocation,
} from "#src/task-conversation-args";

export type TaskInvocation = { command: "task"; task: Omit<TaskCommand, "idempotencyKey"> };

const TASK_OPERATIONS = [
  "list",
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
  list: ["--target", "--mine", "--status"],
  create: [
    "--target",
    "--title",
    "--assignee",
    "--creates-resource",
    "--description",
    "--message-id",
    "--alongside",
  ],
  convert: ["--target", "--message-id"],
  claim: ["--target", "--number", "--message-id", "--reviewer-isolation"],
  unclaim: ["--target", "--number", "--expected-revision"],
  assign: ["--target", "--number", "--assignee", "--expected-revision"],
  unassign: ["--target", "--number", "--expected-revision"],
  update: ["--target", "--number", "--status", "--expected-revision", "--reviewer-isolation"],
  amend: [
    "--target",
    "--number",
    "--title",
    "--description",
    "--clear-description",
    "--expected-revision",
    "--reviewer-isolation",
  ],
  history: ["--target", "--number"],
  delete: ["--target", "--number"],
  receipt: [
    "--target",
    "--number",
    "--object",
    "--purpose",
    "--teardown-owner",
    "--security-privacy",
    "--expiry",
    "--runbook",
    "--tracking",
  ],
};

/** Flags a subcommand accepts more than once. `update` counts its `--number`s only to refuse
 * more than one by name. */
const TASK_REPEATABLE_FLAGS: Partial<Record<TaskOperation, readonly string[]>> = {
  create: ["--title"],
  claim: ["--number", "--message-id"],
  update: ["--number"],
};

const TASK_SWITCHES = new Set([
  "--clear-description",
  "--reviewer-isolation",
  "--mine",
  "--creates-resource",
  "--alongside",
]);

const TASK_TARGET = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,31})$/;

function invalidTaskArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

function taskNumber(raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined) throw invalidTaskArg("--number is required");
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value <= 0)
    throw invalidTaskArg(`--number must be a positive integer; got ${raw}`);
  return value;
}

function expectedRevisionOption(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isSafeInteger(value) || value < 0)
    throw invalidTaskArg(`--expected-revision must be a non-negative integer; got ${raw}`);
  return value;
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
    throw new Error("Usage:");
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
  if (operation === "list") validateTaskListScope(target, mine, one("--status"));
  if (!mine) {
    if (!target?.trim()) throw invalidTaskArg("--target is required");
    if (!TASK_TARGET.test(target))
      throw invalidTaskArg(
        `--target must be a conversation ('#channel' or '@user'); got ${target}`,
      );
  }

  const task: Omit<TaskCommand, "idempotencyKey"> = {
    operation,
    target,
    ...(mine ? { mine: true } : {}),
  };
  if (operation === "list") {
    task.status = one("--status") as TaskStatus | "all" | undefined;
  } else if (operation === "create") {
    const titles = values.get("--title") ?? [];
    if (!titles.length) throw invalidTaskArg("--title is required (at least one)");
    if (titles.some((title) => !title.trim())) throw invalidTaskArg("--title must be nonblank");
    if (titles.length === 1) task.title = titles[0];
    else task.titles = titles;
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
  } else if (operation === "update") {
    const numbers = values.get("--number") ?? [];
    if (numbers.length !== 1)
      throw invalidTaskArg(
        numbers.length === 0
          ? "Provide exactly one --number"
          : `task update accepts exactly one --number; received ${numbers.length}. Run task update once per task.`,
      );
    task.number = taskNumber(numbers[0]);
    const status = one("--status");
    if (!status || !(TASK_STATUSES as readonly string[]).includes(status))
      throw invalidTaskArg(`--status must be one of: ${TASK_STATUSES.join(", ")}; got ${status}`);
    task.status = status as TaskStatus;
  } else {
    task.number = taskNumber(one("--number"));
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
  }
  if (operation === "amend") {
    const description = one("--description");
    const clear = values.has("--clear-description");
    if (description !== undefined && clear)
      throw invalidTaskArg("Use either --description or --clear-description, not both");
    const title = one("--title");
    if (title === undefined && description === undefined && !clear)
      throw invalidTaskArg(
        "At least one amendment is required: --title, --description, or --clear-description",
      );
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
  return { command: "task", task };
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
