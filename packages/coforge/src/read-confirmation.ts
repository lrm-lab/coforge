import {
  agentReadConfirmationSchema,
  agentReadConfirmResponseSchema,
  agentReadPageResponseSchema,
  type AgentReadConfirmation,
  type AgentReadPageRequest,
  type AgentReadRequest,
} from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";
import { formatReadWindow, type ReadWindowResponse } from "./message-read-format";

export type ReadConfirmationTransport = {
  readConfirmation?(request: AgentReadRequest): Promise<unknown>;
};

export function parseReadConfirmation(raw: string): AgentReadConfirmation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {}
  const parsed = agentReadConfirmationSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError({
      code: "INVALID_ARG",
      message:
        "Provide the page and the ordered checkpoints of the complete messages you received.",
      retryable: false,
    });
  return parsed.data;
}

export function unavailableReadConfirmation(): CliError {
  return new CliError({
    code: "READ_CONFIRMATION_UNAVAILABLE",
    message: "Delivery-confirmed reads need a compatible Computer and Web server.",
    retryable: false,
  });
}

async function submit(transport: ReadConfirmationTransport, request: AgentReadRequest) {
  if (!transport.readConfirmation) throw unavailableReadConfirmation();
  return transport.readConfirmation(request);
}

export async function runReadConfirmation(
  transport: ReadConfirmationTransport,
  body: AgentReadConfirmation,
): Promise<string> {
  const response = agentReadConfirmResponseSchema.safeParse(
    await submit(transport, {
      operation: "confirm",
      body,
    }),
  );
  if (!response.success) throw unavailableReadConfirmation();
  return `Read confirmed through seq ${response.data.confirmation.readThrough} in ${response.data.confirmation.scope.target}.`;
}

export async function runReadConfirmationPage(
  transport: ReadConfirmationTransport,
  body: AgentReadPageRequest,
  target: string,
): Promise<string> {
  const response = agentReadPageResponseSchema.safeParse(
    await submit(transport, {
      operation: "page",
      body,
    }),
  );
  if (!response.success) throw unavailableReadConfirmation();
  const { window, receipt, readThrough, confirmation } = response.data;
  if (receipt && (body.window.around || body.window.consume === false))
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: "A view-only page included read checkpoints.",
      retryable: false,
    });
  const { messages, ...rest } = window as unknown as ReadWindowResponse;
  const { readPositionAfter: _position, ...formatWindow } = rest;
  const lines = [
    ...(confirmation
      ? [
          `Previous read confirmed through seq ${confirmation.readThrough} in ${confirmation.scope.target}.`,
        ]
      : []),
    `Current read position for ${target}: seq ${readThrough}. This page does not move it.`,
  ];
  if (receipt) {
    lines.push(
      `Read page: ${receipt.page}`,
      "Confirm only the complete consecutive messages you received, starting with checkpoint 1.",
      "Pass {page,checkpoints} as JSON to coforge read confirm, or with --confirm on your next read.",
      "",
    );
  }
  const markers = new Map(
    receipt?.checkpoints.map((checkpoint) => [
      checkpoint.messageId,
      `Read checkpoint: ${JSON.stringify(checkpoint)}`,
    ]),
  );
  lines.push(
    formatReadWindow(
      target,
      {
        ...formatWindow,
        messages,
        unreadCursorBefore: readThrough,
      },
      {
        unread: body.window.unread,
        task: body.source.kind === "task",
        around: body.window.around,
        pendingConfirmation: true,
        checkpointFor: (id) => markers.get(id),
      },
    ),
  );
  const empty = markers.get(undefined);
  if (empty) lines.push(empty);
  return lines.join("\n");
}
