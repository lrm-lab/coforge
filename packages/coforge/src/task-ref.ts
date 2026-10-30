import { CliError } from "./cli-error";

/** A task: the board it is on (`#channel`, or `dm:@peer` for a task in a direct message), its
 * number there, and the ref that names both. */
export type TaskRef = { ref: string; board: string; number: number };

const CHANNEL_BOARD = /^#[a-z0-9][a-z0-9_-]{0,31}$/;
const DM_BOARD = /^dm:@[a-z0-9][a-z0-9_-]{0,63}$/;
/** The whole string: a board, `:#`, and a number without a leading zero. */
const TASK_REF = /^(.+):#([1-9]\d*)$/;

const refused = (code: string, message: string) =>
  new CliError({ code, message, retryable: false });

/** The task a command names: by its ref (`#channel:#7`, `dm:@peer:#7`), or by `--target` and
 * `--number`; both may be given if they agree. A thread target (`#channel:abcd1234`) is not a ref. */
export function resolveTaskRef(
  positional: string | undefined,
  target: string | undefined,
  number: string | undefined,
): TaskRef {
  const fromRef = positional === undefined ? undefined : parseTaskRef(positional);
  const fromFlags =
    target === undefined && number === undefined ? undefined : fromFlag(target, number);
  if (fromRef && fromFlags && fromRef.ref !== fromFlags.ref)
    throw refused(
      "INVALID_ARG",
      `The ref ${fromRef.ref} and --target/--number name different tasks; give one of them.`,
    );
  const task = fromRef ?? fromFlags;
  if (!task)
    throw refused(
      "INVALID_ARG",
      'Name the task by its ref, e.g. "#channel:#7" (quoted), or with --target "#channel" --number 7.',
    );
  return task;
}

function parseTaskRef(raw: string): TaskRef {
  const match = TASK_REF.exec(raw);
  if (match && (CHANNEL_BOARD.test(match[1]!) || DM_BOARD.test(match[1]!)))
    return { ref: raw, board: match[1]!, number: Number(match[2]) };
  throw refused(
    "INVALID_TARGET",
    `Not a task ref: ${raw}. A task is named "#channel:#7" (a task in a DM: "dm:@peer:#7"), or with --target "#channel" --number 7. Quote the ref: an unquoted # starts a shell comment.`,
  );
}

/** `--target` and `--number`; a peer may be given as `@peer` for `dm:@peer`. */
function fromFlag(target: string | undefined, number: string | undefined): TaskRef | undefined {
  if (target === undefined || number === undefined) return undefined;
  const board = target.startsWith("@") ? `dm:${target}` : target;
  if (!CHANNEL_BOARD.test(board) && !DM_BOARD.test(board))
    throw refused(
      "INVALID_TARGET",
      `--target must be a channel ('#channel') or a DM ('dm:@peer') holding the task board; got ${target}`,
    );
  const digits = number.replace(/^#/, "");
  if (!/^[1-9]\d*$/.test(digits) || !Number.isSafeInteger(Number(digits)))
    throw refused("INVALID_ARG", `--number must be a positive integer; got ${number}`);
  return { ref: `${board}:#${digits}`, board, number: Number(digits) };
}
