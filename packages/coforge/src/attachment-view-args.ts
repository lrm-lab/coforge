import { CliError } from "#src/cli-error";
import { parseCliFlags } from "./cli-flags";

export type AttachmentViewInvocation = {
  command: "attachment.view";
  attachmentId: string;
  output: string;
  json?: boolean;
};

export function parseAttachmentViewArgs(args: readonly string[]): AttachmentViewInvocation {
  const { values, positionals } = parseCliFlags({
    args: args.slice(2),
    options: {
      id: { type: "string" },
      output: { type: "string" },
      json: { type: "boolean" },
    },
    maxPositionals: 1,
    allowEmptyValues: false,
    onError() {
      throw new Error("Usage:");
    },
  });
  const positionalId = positionals[0];
  const explicitId = values.id;
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
  if (!values.output)
    throw new CliError({
      code: "INVALID_ARG",
      message: "--output is required",
      retryable: false,
    });
  return {
    command: "attachment.view",
    attachmentId,
    output: values.output,
    ...(values.json ? { json: true as const } : {}),
  };
}
