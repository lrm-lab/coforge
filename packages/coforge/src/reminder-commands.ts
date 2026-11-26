import type {
  AgentReminderOperationResponse,
  LocalReminderLocalResponse,
  LocalReminderRequest,
  ReminderSummaryRecord,
} from "@lrm/coforge-sdk/internal";
import {
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  isReminderId,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { unknownCommandError } from "./command-help";
import { cliFlagBadToken, parseCliFlags } from "./cli-flags";
import { parseDurationSeconds } from "#src/reminder-duration";
import {
  formatReminderResponse as formatAgentReminderResponse,
  shortReminderId,
} from "#src/reminder-format";

export type ReminderInvocation = Omit<LocalReminderRequest, "context" | "idempotencyKey"> & {
  command: "reminder";
};
export type ReminderTransportRequest = Omit<LocalReminderRequest, "context" | "idempotencyKey">;
export type { LocalReminderLocalResponse };
export type LocalReminderReceiptResponse = {
  accepted: boolean;
  reminderId: string;
  revision: number;
};
export type ReminderResponse =
  | AgentReminderOperationResponse
  | LocalReminderReceiptResponse
  | LocalReminderLocalResponse;

type ReminderTransport = {
  reminder?(request: ReminderTransportRequest): Promise<ReminderResponse>;
};

export async function sendReminderCommand(
  transport: ReminderTransport,
  request: ReminderTransportRequest,
): Promise<ReminderResponse> {
  if (!transport.reminder) throw new Error("Reminder transport is unavailable");
  try {
    return await transport.reminder(request);
  } catch (error) {
    if (
      (request.operation === "seal" || request.operation === "unseal") &&
      !(error instanceof CliError)
    )
      throw new CliError({
        code: "UPDATE_FAILED",
        message: "The local reminder seal store could not be updated.",
        retryable: true,
      });
    throw error;
  }
}

const REMINDER_USAGE =
  "Usage: coforge reminder schedule --title <title> (--target <target>|--channel <target>) (--message-id <full UUID|8hex>|--msg-id <full UUID|8hex>) [--delay-seconds <n|duration>|--in <duration>|--by <duration>|--fire-at <timestamp>] [(--repeat <rule>|--cadence <rule>) [--tz <timezone>]] | coforge reminder list [--all | --status <comma-list of scheduled,fired,canceled; default scheduled,fired>] | coforge reminder update --id <full UUID|8hex+> (--fire-at <timestamp> | --in <duration> | (--cadence <rule|none>|--repeat <rule|none>) [--tz <timezone>] | --title <title>) | coforge reminder snooze --id <full UUID|8hex+> (--delay-seconds <n|duration> | --by <duration> | --fire-at <timestamp>) | coforge reminder cancel|log --id <full UUID|8hex+> | coforge reminder ack|dismiss --id <full UUID|8hex+> --revision <n> | coforge reminder seal --id <full UUID|8hex+> [--revision <n>|--all-pending] --owner <who> --until <condition> | coforge reminder unseal --id <full UUID|8hex+> [--revision <n>|--all-pending]";

const REMINDER_ID_PREFIX = /^[0-9a-f]{8,}$/i;

export function parseReminderArgs(args: readonly string[]): ReminderInvocation {
  const operation = args[0];
  if (
    !operation ||
    ![
      "schedule",
      "list",
      "update",
      "snooze",
      "cancel",
      "log",
      "ack",
      "dismiss",
      "seal",
      "unseal",
    ].includes(operation)
  )
    throw unknownCommandError(["reminder", ...args]);
  const { values } = parseCliFlags({
    args: args.slice(1),
    options: {
      id: { type: "string" },
      title: { type: "string" },
      target: { type: "string" },
      channel: { type: "string" },
      "message-id": { type: "string" },
      "msg-id": { type: "string" },
      "delay-seconds": { type: "string" },
      by: { type: "string" },
      in: { type: "string" },
      "fire-at": { type: "string" },
      repeat: { type: "string" },
      cadence: { type: "string" },
      tz: { type: "string" },
      status: { type: "string" },
      revision: { type: "string" },
      owner: { type: "string" },
      until: { type: "string" },
      all: { type: "boolean" },
      "all-pending": { type: "boolean" },
    },
    duplicates: "error",
    rejectFlagValues: true,
    onError(error) {
      if (error.kind === "duplicate")
        throw new Error(`Duplicate reminder flag: ${error.flag}\n${REMINDER_USAGE}`);
      throw new Error(
        `Unknown or incomplete reminder flag: ${cliFlagBadToken(error)}\n${REMINDER_USAGE}`,
      );
    },
  });
  const request: Record<string, unknown> = { command: "reminder", operation };
  if (values.all) request.all = true;
  if (values["all-pending"]) request.allPending = true;
  const pickExclusive = (
    entries: ReadonlyArray<readonly [flag: string, value: string | undefined]>,
  ): readonly [flag: string, value: string] | undefined => {
    const present = entries
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
      .sort(([first], [second]) => args.indexOf(first) - args.indexOf(second));
    if (present.length > 1)
      throw new Error(
        `Cannot combine ${present[1]![0]} with ${present[0]![0]}.\n${REMINDER_USAGE}`,
      );
    return present[0];
  };
  if (values.id !== undefined) request.reminderId = values.id;
  if (values.title !== undefined) request.title = values.title;
  const target = pickExclusive([
    ["--target", values.target],
    ["--channel", values.channel],
  ]);
  if (target) request.target = target[1];
  const messageId = pickExclusive([
    ["--message-id", values["message-id"]],
    ["--msg-id", values["msg-id"]],
  ]);
  if (messageId) request.messageId = messageId[1];
  const delay = pickExclusive([
    ["--delay-seconds", values["delay-seconds"]],
    ["--by", values.by],
    ["--in", values.in],
  ]);
  if (delay) {
    const [flag, value] = delay;
    if (flag === "--by" || flag === "--in") {
      const seconds = parseDurationSeconds(value);
      if (seconds === null)
        throw new Error(`Invalid duration for ${flag}: '${value}'.\n${REMINDER_USAGE}`);
      request.delaySeconds = seconds;
    } else {
      const integer = Number(value);
      const seconds =
        Number.isSafeInteger(integer) && integer >= 1 ? integer : parseDurationSeconds(value);
      if (seconds === null) throw new Error(REMINDER_USAGE);
      request.delaySeconds = seconds;
    }
  }
  if (values["fire-at"] !== undefined) request.fireAt = values["fire-at"];
  const repeat = pickExclusive([
    ["--repeat", values.repeat],
    ["--cadence", values.cadence],
  ]);
  if (repeat) request.repeat = repeat[1];
  if (values.tz !== undefined) request.timezone = values.tz;
  if (values.status !== undefined) request.status = values.status;
  if (values.revision !== undefined) {
    const number = Number(values.revision);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error(REMINDER_USAGE);
    request.revision = number;
  }
  if (values.owner !== undefined) request.owner = values.owner;
  if (values.until !== undefined) request.until = values.until;
  validateReminderShape(request as ReminderInvocation);
  const rawId = request.reminderId as string | undefined;
  const needsIdProbe = rawId !== undefined && !isReminderId(rawId);
  decodeLocalReminderRequest(
    encodeLocalReminderRequest({
      ...request,
      ...(needsIdProbe ? { reminderId: "12345678-1234-4123-8123-123456789abc" } : {}),
      idempotencyKey: "cli-validation",
      context: "cli-validation",
    } as LocalReminderRequest),
  );
  return request as ReminderInvocation;
}

function validateReminderShape(value: ReminderInvocation): void {
  const present = (field: keyof ReminderTransportRequest) => value[field] !== undefined;
  const allowed: Record<string, readonly (keyof ReminderTransportRequest)[]> = {
    schedule: ["title", "target", "messageId", "delaySeconds", "fireAt", "repeat", "timezone"],
    list: ["all", "status"],
    update: ["reminderId", "title", "fireAt", "delaySeconds", "repeat", "timezone"],
    snooze: ["reminderId", "delaySeconds", "fireAt"],
    cancel: ["reminderId"],
    log: ["reminderId"],
    ack: ["reminderId", "revision"],
    dismiss: ["reminderId", "revision"],
    seal: ["reminderId", "revision", "allPending", "owner", "until"],
    unseal: ["reminderId", "revision", "allPending"],
  };
  const fields = Object.keys(value).filter(
    (key) => key !== "command" && key !== "operation",
  ) as (keyof ReminderTransportRequest)[];
  if (fields.some((field) => !allowed[value.operation]!.includes(field)))
    throw new Error(REMINDER_USAGE);
  const id = value.reminderId;
  if (id !== undefined && !isReminderId(id) && !REMINDER_ID_PREFIX.test(id))
    throw new Error(
      `Invalid reminder ID; full UUID or an id prefix of at least 8 hex characters required.\n${REMINDER_USAGE}`,
    );
  const timed = Number(present("delaySeconds")) + Number(present("fireAt"));
  if (
    value.operation === "schedule" &&
    (!value.title ||
      !value.target ||
      !value.messageId ||
      timed > 1 ||
      (!value.repeat && timed !== 1) ||
      value.repeat === "none")
  )
    throw new Error(REMINDER_USAGE);
  if (value.operation === "list" && present("all") && present("status"))
    throw new Error(REMINDER_USAGE);
  if (["cancel", "log"].includes(value.operation) && !id) throw new Error(REMINDER_USAGE);
  if (value.operation === "snooze" && (!id || timed !== 1)) throw new Error(REMINDER_USAGE);
  if (value.operation === "update") {
    if (!id || timed > 1) throw new Error(REMINDER_USAGE);
    const mutations = [timed === 1, value.repeat !== undefined, value.title !== undefined].filter(
      Boolean,
    ).length;
    if (mutations !== 1)
      throw new Error(
        `Pass exactly one of --fire-at, --in, --cadence, or --title.\n${REMINDER_USAGE}`,
      );
    if (value.timezone !== undefined && value.repeat === undefined)
      throw new Error(
        `--tz may only accompany a cadence change (--cadence/--repeat).\n${REMINDER_USAGE}`,
      );
  }
  if (["ack", "dismiss"].includes(value.operation) && (!id || !value.revision))
    throw new Error(REMINDER_USAGE);
  if (value.operation === "seal" || value.operation === "unseal") {
    if (!id || (value.revision !== undefined && value.allPending === true))
      throw new Error(`Pass at most one of --revision and --all-pending.\n${REMINDER_USAGE}`);
    if (value.operation === "seal" && (!value.owner || !value.until))
      throw new Error(`Sealing a reminder needs --owner and --until.\n${REMINDER_USAGE}`);
  }
}

export type ReminderIdResolutionScope = { all: true } | { statuses: readonly string[] };

const REMINDER_ID_RESOLUTION_SCOPE: Record<string, ReminderIdResolutionScope> = {
  cancel: { statuses: ["scheduled", "fired"] },
  snooze: { statuses: ["scheduled", "fired"] },
  update: { all: true },
  log: { all: true },
  ack: { all: true },
  dismiss: { all: true },
  seal: { all: true },
  unseal: { all: true },
};

export async function resolveReminderRequestId(
  transport: ReminderTransport,
  request: ReminderTransportRequest,
): Promise<ReminderTransportRequest> {
  const scope = REMINDER_ID_RESOLUTION_SCOPE[request.operation];
  if (!scope || !request.reminderId) return request;
  if (isReminderId(request.reminderId)) return request;
  const prefix = request.reminderId;
  try {
    return { ...request, reminderId: await resolveReminderId(transport, prefix, scope) };
  } catch (error) {
    if (
      (request.operation === "seal" || request.operation === "unseal") &&
      error instanceof CliError &&
      error.code === "AMBIGUOUS"
    )
      throw new CliError({ code: "INVALID_ARG", message: error.message, retryable: false });
    throw error;
  }
}

export async function resolveReminderId(
  transport: ReminderTransport,
  prefix: string,
  scope: ReminderIdResolutionScope = { all: true },
): Promise<string> {
  if (!transport.reminder) throw new Error("Reminder transport is unavailable");
  const response = (await transport.reminder(
    "all" in scope
      ? { operation: "list", all: true }
      : { operation: "list", status: scope.statuses.join(",") },
  )) as AgentReminderOperationResponse;
  const lowerPrefix = prefix.replace(/-/g, "").toLowerCase();
  const matches = (response.reminders ?? []).filter((item: ReminderSummaryRecord) =>
    item.reminderId.replace(/-/g, "").toLowerCase().startsWith(lowerPrefix),
  );
  const scopeLabel = "all" in scope ? "reminder" : `${scope.statuses.join("/")} reminder`;
  if (matches.length === 0)
    throw new CliError({
      code: "NOT_FOUND",
      message: `No ${scopeLabel} matches id prefix '${prefix}'.`,
      retryable: false,
    });
  const matchedIds = matches.map((item) => item.reminderId);
  if (matches.length > 1)
    throw new CliError({
      code: "AMBIGUOUS",
      message: `Ambiguous id prefix '${prefix}' matches ${matches.length} reminders; pass a longer id: ${matches
        .map((item) => shortReminderId(item.reminderId, matchedIds))
        .join(", ")}.`,
      retryable: false,
    });
  return matches[0]!.reminderId;
}

export function formatReminderCommandResponse(
  operation: string,
  result:
    | AgentReminderOperationResponse
    | LocalReminderReceiptResponse
    | LocalReminderLocalResponse,
): string {
  const local = result as LocalReminderLocalResponse;
  if (local.reason === "sealed")
    throw new CliError({
      code: "UPDATE_FAILED",
      message: `sealed by ${local.owner} until ${local.until}; run coforge reminder unseal explicitly first`,
      retryable: false,
    });
  if (!result.accepted) {
    if (local.reason === "no-matching-seal")
      throw new CliError({
        code: "NOT_FOUND",
        message: "No matching local reminder seal exists",
        retryable: false,
      });
    if (local.reason === "no-live-revision")
      throw new CliError({
        code: "NOT_FOUND",
        message: "No live reminder revision matches --all-pending",
        retryable: false,
      });
    return "Reminder request was not accepted.";
  }
  if (operation === "seal" || operation === "unseal") {
    const id = (local.reminderId ?? "").slice(0, 8);
    const count = local.sealed ?? 0;
    const noun = `${count} reminder source ${count === 1 ? "identity" : "identities"}`;
    return operation === "seal"
      ? `Sealed ${noun} for ${id} by ${local.owner} until ${local.until}.`
      : `Unsealed ${noun} for ${id}.`;
  }
  if (operation === "ack" || operation === "dismiss") {
    const receipt = result as LocalReminderReceiptResponse;
    return `Accepted reminder ${operation} request: id=${receipt.reminderId} revision=${receipt.revision}.`;
  }
  return formatAgentReminderResponse(operation, result as AgentReminderOperationResponse);
}

export async function runReminder(
  invocation: ReminderInvocation,
  transport: ReminderTransport,
): Promise<string> {
  if (!transport.reminder) throw new Error("Reminder transport is unavailable");
  const { command: _command, ...request } = invocation;
  const resolved = await resolveReminderRequestId(transport, request);
  return formatReminderCommandResponse(
    resolved.operation,
    await sendReminderCommand(transport, resolved),
  );
}
