import type {
  AgentReminderOperationResponse,
  LocalReminderRequest,
  ReminderSummaryRecord,
} from "@lrm/coforge-sdk/internal";
import {
  DEFAULT_REMINDER_TIMEZONE,
  decodeLocalReminderRequest,
  encodeLocalReminderRequest,
  isReminderId,
} from "@lrm/coforge-sdk/internal";
import { CliError } from "#src/cli-error";
import { parseDurationSeconds } from "#src/reminder-duration";
import { formatReminderResponse as formatAgentReminderResponse } from "#src/reminder-format";

export type ReminderInvocation = Omit<LocalReminderRequest, "context" | "idempotencyKey"> & {
  command: "reminder";
};
export type ReminderTransportRequest = Omit<LocalReminderRequest, "context" | "idempotencyKey">;
export type LocalReminderReceiptResponse = {
  accepted: boolean;
  reminderId: string;
  revision: number;
};
/** The reminder transport these commands need: the CLI's `MessageTransport.reminder`. */
type ReminderTransport = {
  reminder?(
    request: ReminderTransportRequest,
  ): Promise<AgentReminderOperationResponse | LocalReminderReceiptResponse>;
};

const REMINDER_USAGE =
  "Usage: coforge reminder schedule --title <title> (--target <target>|--channel <target>) (--message-id <full UUID|8hex>|--msg-id <full UUID|8hex>) (--delay-seconds <n|duration> | --fire-at <timestamp> | --repeat <rule>) [--repeat <rule>] [--tz <timezone>] | coforge reminder list [--all | --status <comma-list of scheduled,fired,canceled; default scheduled,fired>] | coforge reminder update --id <full UUID|8hex+> (--fire-at <timestamp> | --in <duration> | --repeat <rule|none>|--cadence <rule|none> | --title <title>) [--tz <timezone>] | coforge reminder snooze --id <full UUID|8hex+> (--delay-seconds <n|duration> | --by <duration> | --fire-at <timestamp>) | coforge reminder cancel|log --id <full UUID|8hex+> | coforge reminder ack|dismiss --id <full UUID|8hex+> --revision <n>";

/** A resolvable `--id` is a full UUID or a case-insensitive hex prefix of at least 8 characters. */
const REMINDER_ID_PREFIX = /^[0-9a-f]{8,}$/i;

export function parseReminderArgs(args: readonly string[]): ReminderInvocation {
  const operation = args[0];
  if (
    !operation ||
    !["schedule", "list", "update", "snooze", "cancel", "log", "ack", "dismiss"].includes(operation)
  )
    throw new Error(REMINDER_USAGE);
  const names: Record<string, keyof ReminderTransportRequest> = {
    "--id": "reminderId",
    "--title": "title",
    "--target": "target",
    "--channel": "target",
    "--message-id": "messageId",
    "--msg-id": "messageId",
    "--delay-seconds": "delaySeconds",
    "--fire-at": "fireAt",
    "--repeat": "repeat",
    "--cadence": "repeat",
    "--tz": "timezone",
    "--status": "status",
    "--revision": "revision",
  };
  const request: Record<string, unknown> = { command: "reminder", operation };
  const seen = new Set<string>();
  // Tracks which literal flag last claimed each logical field, so an alias used together with its
  // canonical spelling (or with another alias of the same field) is a usage error even though the
  // two flags are spelled differently and so never collide in `seen`.
  const flagForField = new Map<string, string>();
  const claimField = (field: string, flag: string) => {
    const existing = flagForField.get(field);
    if (existing !== undefined && existing !== flag)
      throw new Error(`Cannot combine ${flag} with ${existing}.\n${REMINDER_USAGE}`);
    flagForField.set(field, flag);
  };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Duplicate reminder flag: ${flag}\n${REMINDER_USAGE}`);
    seen.add(flag);
    if (flag === "--all") {
      request.all = true;
      continue;
    }
    if (flag === "--by" || flag === "--in") {
      // Both are duration spellings of the same wire field, `delaySeconds`: `--by` on snooze and
      // `--in` on update. Neither computes an absolute `fireAt` locally — the daemon/server derive
      // the due time from `delaySeconds` exactly as they already do for snooze.
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`Unknown or incomplete reminder flag: ${flag}\n${REMINDER_USAGE}`);
      const seconds = parseDurationSeconds(value);
      if (seconds === null)
        throw new Error(`Invalid duration for ${flag}: '${value}'.\n${REMINDER_USAGE}`);
      claimField("delaySeconds", flag);
      request.delaySeconds = seconds;
      continue;
    }
    const field = names[flag];
    const value = args[++index];
    if (!field || value === undefined || value.startsWith("--"))
      throw new Error(`Unknown or incomplete reminder flag: ${flag}\n${REMINDER_USAGE}`);
    claimField(field, flag);
    if (field === "delaySeconds") {
      const integer = Number(value);
      const seconds =
        Number.isSafeInteger(integer) && integer >= 1 ? integer : parseDurationSeconds(value);
      if (seconds === null) throw new Error(REMINDER_USAGE);
      request[field] = seconds;
    } else if (field === "revision") {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(REMINDER_USAGE);
      request[field] = number;
    } else request[field] = value;
  }
  if (
    typeof request.repeat === "string" &&
    request.repeat !== "none" &&
    request.timezone === undefined
  )
    request.timezone = DEFAULT_REMINDER_TIMEZONE;
  validateReminderShape(request as ReminderInvocation);
  // The wire-level round trip below requires a full UUID for `reminderId` (the daemon and server
  // never see a bare prefix — it is resolved to a full ID before the real request goes out; see
  // `resolveReminderRequestId`). Substitute a throwaway, well-formed UUID so this local check still
  // validates every other field early; the substitution is discarded and never sent anywhere.
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
  // `list` defaults to scheduled,fired when neither `--all` nor `--status` is given (the server
  // already applies that default); only passing both together is a usage error.
  if (value.operation === "list" && present("all") && present("status"))
    throw new Error(REMINDER_USAGE);
  if (["cancel", "log"].includes(value.operation) && !id) throw new Error(REMINDER_USAGE);
  if (value.operation === "snooze" && (!id || timed !== 1)) throw new Error(REMINDER_USAGE);
  if (value.operation === "update") {
    if (!id || timed > 1) throw new Error(REMINDER_USAGE);
    // "Pass exactly one of --fire-at, --in, --cadence, or --title" (code INVALID_ARG).
    // --fire-at and --in both land in `timed` (the time mutation), so they count as one slot.
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
}

/** The `list` scope an `--id` prefix lookup runs under, per command. */
export type ReminderIdResolutionScope = { all: true } | { statuses: readonly string[] };

/**
 * Reminder operations that take `--id`, and the `list` scope each resolves a short prefix within.
 * `cancel`/`snooze` only ever act on an active reminder, so they resolve within scheduled/fired.
 * `update`, `log`, `ack`, and `dismiss` can target any status, so they resolve unscoped
 * (`all: true`); `log` needs the lookup because the wire protocol always requires a full UUID.
 */
const REMINDER_ID_RESOLUTION_SCOPE: Record<string, ReminderIdResolutionScope> = {
  cancel: { statuses: ["scheduled", "fired"] },
  snooze: { statuses: ["scheduled", "fired"] },
  update: { all: true },
  log: { all: true },
  ack: { all: true },
  dismiss: { all: true },
};

/**
 * Resolves `request.reminderId` to a full UUID when it is a short prefix, leaving every other
 * request untouched. A full UUID never triggers the lookup (the brief's "skip the lookup" case).
 */
export async function resolveReminderRequestId(
  transport: ReminderTransport,
  request: ReminderTransportRequest,
): Promise<ReminderTransportRequest> {
  const scope = REMINDER_ID_RESOLUTION_SCOPE[request.operation];
  if (!scope || !request.reminderId) return request;
  if (isReminderId(request.reminderId)) return request;
  return {
    ...request,
    reminderId: await resolveReminderId(transport, request.reminderId, scope),
  };
}

/**
 * Resolves an `--id` prefix (at least 8 hex characters, case-insensitive) to the one full reminder
 * ID it matches, by listing reminders within `scope` and comparing prefixes against each id with
 * its formatting dashes stripped. Takes the transport directly (rather than reaching for the
 * ambient one) so it is unit-testable with a fake transport.
 */
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
  const lowerPrefix = prefix.toLowerCase();
  const matches = (response.reminders ?? []).filter((item: ReminderSummaryRecord) =>
    item.reminderId.replace(/-/g, "").toLowerCase().startsWith(lowerPrefix),
  );
  // An unscoped ("all") lookup just says "reminder"; a status-scoped lookup names the scope,
  // e.g. "scheduled/fired reminder".
  const scopeLabel = "all" in scope ? "reminder" : `${scope.statuses.join("/")} reminder`;
  if (matches.length === 0)
    throw new CliError({
      code: "NOT_FOUND",
      message: `No ${scopeLabel} matches id prefix '${prefix}'.`,
      retryable: false,
    });
  if (matches.length > 1)
    throw new CliError({
      code: "AMBIGUOUS",
      message: `Ambiguous id prefix '${prefix}' matches ${matches.length} reminders; pass a longer id.`,
      retryable: false,
    });
  return matches[0]!.reminderId;
}

export function formatReminderCommandResponse(
  operation: string,
  result: AgentReminderOperationResponse | LocalReminderReceiptResponse,
): string {
  if (!result.accepted) return "Reminder request was not accepted.";
  if (operation === "ack" || operation === "dismiss") {
    const receipt = result as LocalReminderReceiptResponse;
    return `Accepted reminder ${operation} request: id=${receipt.reminderId} revision=${receipt.revision}.`;
  }
  return formatAgentReminderResponse(operation, result as AgentReminderOperationResponse);
}
