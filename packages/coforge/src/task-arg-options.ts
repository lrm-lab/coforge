// The argument helpers behind `task`'s own parsing (`task-args.ts`): one module so that file
// stays at its natural seam. Each helper refuses as INVALID_ARG, the CLI's own vocabulary.
import { CHANNEL_NAME_PATTERN, type TaskRef } from "@lrm/coforge-sdk/internal";

import { CliError } from "#src/cli-error";

export const TASK_TARGET = /^(?:#[a-z0-9][a-z0-9_-]{0,31}|@[a-z0-9][a-z0-9_-]{0,63})$/;

/** The flags that take no value. */
export const TASK_SWITCHES = new Set([
  "--clear-description",
  "--reviewer-isolation",
  "--mine",
  "--ready",
  "--creates-resource",
  "--alongside",
  "--anyway",
  "--json",
]);

export function invalidTaskArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

/** A positive integer, or an invalid-argument refusal saying `message`. */
export function positiveInt(raw: string, message: string): number {
  // Digits only: `Number()` would also take `1e1`, `0x10` and `1.0`.
  const value = /^[0-9]+$/.test(raw.trim()) ? Number(raw) : 0;
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidTaskArg(message);
  return value;
}

export function taskNumber(raw: string | undefined): number {
  if (raw === undefined) throw invalidTaskArg("--number is required");
  return positiveInt(raw, `--number must be a positive integer; got ${raw}`);
}

export function expectedRevisionOption(raw: string | undefined): number | undefined {
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
export function taskRefOption(raw: string, message: string): TaskRef {
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
export function blockedByOption(raw: string, clearable: boolean): TaskRef[] {
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
export function parentOption(raw: string, clearable: boolean): TaskRef | null {
  if (raw.trim() === "" && clearable) return null;
  return taskRefOption(
    raw,
    `--parent must be a task like 7 or #channel:#7${clearable ? " (or '' for none)" : ""}; got ${raw}`,
  );
}

/** A handle the server can resolve: `@`, then a lowercase username or Agent name. */
const TASK_HANDLE = /^@[a-z0-9][a-z0-9_-]{0,63}$/;

/** A `@handle` option: trimmed, with the handle after `@` trimmed too. */
export function handleOption(raw: string, message: string): string {
  const value = raw.trim();
  const handle = `@${value.slice(1).trim()}`;
  if (!value.startsWith("@") || !TASK_HANDLE.test(handle)) throw invalidTaskArg(message);
  return handle;
}
