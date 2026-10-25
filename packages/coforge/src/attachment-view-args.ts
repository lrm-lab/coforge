import { CliError } from "#src/cli-error";

export type AttachmentViewInvocation = {
  command: "attachment.view";
  attachmentId: string;
  output: string;
  json?: boolean;
};

/** `attachment view [--id] <id> --output <path> [--json]`; `args` begins with `attachment view`. */
export function parseAttachmentViewArgs(args: readonly string[]): AttachmentViewInvocation {
  let positionalId: string | undefined;
  let explicitId: string | undefined;
  let output: string | undefined;
  let json = false;
  let index = 2;
  if (
    args[index] !== undefined &&
    args[index] !== "--id" &&
    args[index] !== "--output" &&
    args[index] !== "--json"
  ) {
    positionalId = args[index];
    index++;
  }
  for (; index < args.length; index++) {
    if (args[index] === "--id" && args[index + 1]) explicitId = args[++index];
    else if (args[index] === "--output" && args[index + 1]) output = args[++index];
    else if (args[index] === "--json") json = true;
    else throw new Error("Usage:");
  }
  // Three preconditions that never issue a request: not both id spellings, an id, an `--output`.
  if (positionalId && explicitId)
    throw new CliError({
      code: "INVALID_ARG",
      message: "pass the attachment id either positionally or with --id, not both",
      retryable: false,
    });
  const attachmentId = positionalId || explicitId;
  if (!attachmentId)
    throw new CliError({
      code: "INVALID_ARG",
      message: "attachment id is required (pass <attachmentId> or --id)",
      retryable: false,
    });
  if (!output)
    throw new CliError({
      code: "INVALID_ARG",
      message: "--output is required",
      retryable: false,
    });
  return {
    command: "attachment.view",
    attachmentId,
    output,
    ...(json ? { json: true as const } : {}),
  };
}
