import { CliError } from "#src/cli-error";
import { parseCliFlags } from "./cli-flags";
import type { ActionPrepareInvocation } from "../index";
import type { ManualInvocation } from "../index";
import type { ProfileShowInvocation } from "../index";

const MANUAL_INTENT_REASON_MIN_LENGTH = 12;

const MANUAL_INTENT_REASON_MAX_LENGTH = 500;

const MANUAL_USAGE =
  'Usage: coforge manual get <topic> [--intent "<text>"] [--reason "<text>"] | coforge manual ' +
  'search "<keywords>" [--intent "<text>"] [--reason "<text>"]';

export function isValidManualField(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  const trimmed = value.trim();
  return (
    trimmed.length >= MANUAL_INTENT_REASON_MIN_LENGTH &&
    trimmed.length <= MANUAL_INTENT_REASON_MAX_LENGTH
  );
}

export function validateManualIntentReasonArgs(
  intent: string | undefined,
  reason: string | undefined,
) {
  const intentValid = isValidManualField(intent);
  const reasonValid = isValidManualField(reason);
  if (intentValid && reasonValid) return;
  const range = `${MANUAL_INTENT_REASON_MIN_LENGTH}-${MANUAL_INTENT_REASON_MAX_LENGTH}`;
  const safetyNote =
    "Never put a raw prompt, a credential, a private URL, or a message payload in either field.";
  if (!intentValid && !reasonValid)
    throw new CliError({
      code: "KNOWLEDGE_INTENT_INVALID",
      message:
        `--intent and --reason, when provided, must be ${range} characters after ` +
        `trimming. ${safetyNote}`,
      retryable: false,
    });
  if (!intentValid)
    throw new CliError({
      code: "KNOWLEDGE_INTENT_INVALID",
      message:
        `--intent, when provided, must be ${range} characters after trimming: state what you ` +
        `ultimately want to accomplish. ${safetyNote}`,
      retryable: false,
    });
  throw new CliError({
    code: "KNOWLEDGE_REASON_INVALID",
    message:
      `--reason, when provided, must be ${range} characters after trimming: state why the ` +
      `Manual is needed at this point. ${safetyNote}`,
    retryable: false,
  });
}

export function parseManualArgs(args: readonly string[]): ManualInvocation {
  const sub = args[0];
  const { values, positionals } = parseCliFlags({
    args: args.slice(1),
    options: {
      intent: { type: "string" },
      reason: { type: "string" },
    },
    maxPositionals: 1,
    onError() {
      throw new Error(MANUAL_USAGE);
    },
  });
  const value = positionals[0];
  if (!value?.trim()) throw new Error(MANUAL_USAGE);
  validateManualIntentReasonArgs(values.intent, values.reason);
  const context = { intent: values.intent?.trim() ?? "", reason: values.reason?.trim() ?? "" };
  return sub === "get"
    ? { command: "manual-get", topic: value.trim(), ...context }
    : { command: "manual-search", query: value.trim(), ...context };
}

export function stripHandlePrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

const PROFILE_SHOW_USAGE = "Usage: coforge profile show [<target>] [--json]";

export function parseProfileShowArgs(args: readonly string[]): ProfileShowInvocation {
  const { values, positionals } = parseCliFlags({
    args,
    options: { json: { type: "boolean" } },
    maxPositionals: 1,
    onError() {
      throw new Error(PROFILE_SHOW_USAGE);
    },
  });
  const trimmed = positionals[0]?.trim();
  return {
    command: "profile-show",
    ...(trimmed ? { target: stripHandlePrefix(trimmed) } : {}),
    ...(values.json ? { json: true } : {}),
  };
}

export function parseActionPrepareArgs(args: readonly string[]): ActionPrepareInvocation {
  const { values } = parseCliFlags({
    args,
    options: { target: { type: "string" } },
    allowEmptyValues: false,
    onError() {
      throw new CliError({
        code: "INVALID_ARG",
        message: "Usage: coforge action prepare --target <target>",
        retryable: false,
      });
    },
  });
  if (!values.target?.trim())
    throw new CliError({ code: "INVALID_ARG", message: "--target is required", retryable: false });
  return { command: "action-prepare", target: values.target };
}
