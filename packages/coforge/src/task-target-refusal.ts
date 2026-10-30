import { CliError } from "./cli-error";

/** A task's ref: its board (`#channel` or `dm:@name`) and `:#N`, as `task-ref.ts` reads it. */
const TASK_REF = /^(#[^\s:]+|dm:@[^\s:]+):#[1-9]\d*$/;

export function isTaskRef(target: string): boolean {
  return TASK_REF.test(target);
}

const READ_FLAGS = ["--before", "--after", "--around", "--limit"];

/**
 * A task ref is not a message target: `message send` and `message read` refuse it before anything
 * is sent or read, and name the command that does the job (code `TASK_TARGET_USE_TASK_COMMAND`).
 */
export function refuseTaskRef(
  command: "send" | "read",
  target: string,
  args: readonly string[] = [],
  outputMode: "text" | "json" = "text",
): void {
  if (!isTaskRef(target)) return;
  const message =
    command === "send"
      ? [
          `${target} is a task conversation, not a message target. Nothing was sent.`,
          "To reply in it (the body is read from stdin):",
          `  coforge task reply "${target}" <<'COFORGE_MESSAGE'`,
          "  reply body",
          "  COFORGE_MESSAGE",
        ].join("\n")
      : [
          `${target} is a task conversation, not a message target.`,
          `To read it: coforge task read "${target}"${windowFlags(args)}`,
        ].join("\n");
  throw new CliError({
    code: "TASK_TARGET_USE_TASK_COMMAND",
    message,
    retryable: false,
    ...(command === "send" ? { draftSaved: false } : {}),
    outputMode,
  });
}

/** The read window the refused command asked for, so the same one carries over. */
function windowFlags(args: readonly string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (READ_FLAGS.includes(name) && args[index + 1] !== undefined)
      parts.push(`${name} ${args[++index]}`);
    else if (name === "--unread") parts.push(name);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}
