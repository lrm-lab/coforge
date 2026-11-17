import {
  agentApiRoutes,
  decodeAgentActionWithdrawResponse,
  decodeAgentInboxDismissResponse,
  decodeAgentInboxReadResponse,
  type AgentActionWithdrawResponse,
  type AgentInboxDismissRequest,
  type AgentInboxDismissResponse,
  type AgentInboxReadRequest,
  type AgentInboxReadResponse,
} from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";
import { proxyHttpFailure } from "#src/local-proxy-failure";
import type { MessageTransport } from "#src/message-transport";
import { readProxyErrorBody, requireProxySetup } from "#src/proxy-request";

export type InboxReadInvocation = {
  command: "inbox-read";
  target: string;
  limit?: number;
  cursor?: string;
  json: boolean;
};

export type InboxDismissInvocation = {
  command: "inbox-dismiss";
  target?: string;
  before?: string;
  json: boolean;
};

export type ActionWithdrawInvocation = {
  command: "action-withdraw";
  messageId: string;
  json: boolean;
};

const INBOX_READ_USAGE =
  "Usage: coforge inbox read --target <item> [--limit <n>] [--cursor <c>] [--json]";
const INBOX_DISMISS_USAGE =
  "Usage: coforge inbox dismiss (--target <item> | --before <iso>) [--json]";
const ACTION_WITHDRAW_USAGE = "Usage: coforge action withdraw --message <id> [--json]";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function invalidArg(message: string, json: boolean): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message,
    retryable: false,
    outputMode: json ? "json" : "text",
  });
}

export function parseInboxReadArgs(args: readonly string[]): InboxReadInvocation {
  let target: string | undefined;
  let positional: string | undefined;
  let rawLimit: string | undefined;
  let cursor: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--target" && target === undefined && args[index + 1] !== undefined)
      target = args[++index]!.trim();
    else if (arg === "--limit" && rawLimit === undefined && args[index + 1] !== undefined)
      rawLimit = args[++index]!.trim();
    else if (arg === "--cursor" && cursor === undefined && args[index + 1] !== undefined)
      cursor = args[++index]!.trim();
    else if (arg !== undefined && !arg.startsWith("--") && positional === undefined)
      positional = arg.trim();
    else throw invalidArg(INBOX_READ_USAGE, json);
  }
  if (target && positional && target !== positional)
    throw invalidArg("Positional target and --target must agree when both are provided.", json);
  const resolvedTarget = target ?? positional;
  if (!resolvedTarget) throw invalidArg("--target <item> is required.", json);
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(rawLimit))
      throw invalidArg(`--limit must be an integer between 1 and 100; got ${rawLimit}`, json);
    limit = Number(rawLimit);
    if (limit < 1 || limit > 100)
      throw invalidArg(`--limit must be between 1 and 100; got ${rawLimit}`, json);
  }
  return {
    command: "inbox-read",
    target: resolvedTarget,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor ? { cursor } : {}),
    json,
  };
}

export function parseInboxDismissArgs(args: readonly string[]): InboxDismissInvocation {
  let target: string | undefined;
  let before: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--target" && target === undefined && args[index + 1] !== undefined)
      target = args[++index]!.trim();
    else if (arg === "--before" && before === undefined && args[index + 1] !== undefined)
      before = args[++index]!.trim();
    else throw invalidArg(INBOX_DISMISS_USAGE, json);
  }
  if ((target ? 1 : 0) + (before ? 1 : 0) !== 1)
    throw invalidArg("Specify exactly one of --target <item> or --before <iso>.", json);
  if (before !== undefined) {
    const parsed = ISO_TIMESTAMP.test(before) ? new Date(before) : undefined;
    if (!parsed || Number.isNaN(parsed.getTime()))
      throw invalidArg(`--before must be a valid ISO-8601 timestamp; got ${before}`, json);
    return { command: "inbox-dismiss", before: parsed.toISOString(), json };
  }
  return { command: "inbox-dismiss", target, json };
}

export function parseActionWithdrawArgs(args: readonly string[]): ActionWithdrawInvocation {
  let messageId: string | undefined;
  let positional: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (
      (arg === "--message" || arg === "--message-id") &&
      messageId === undefined &&
      args[index + 1] !== undefined
    )
      messageId = args[++index]!.trim();
    else if (arg !== undefined && !arg.startsWith("--") && positional === undefined)
      positional = arg.trim();
    else throw invalidArg(ACTION_WITHDRAW_USAGE, json);
  }
  if (messageId && positional && messageId !== positional)
    throw invalidArg(
      "Positional message id and --message must agree when both are provided.",
      json,
    );
  const resolved = messageId ?? positional;
  if (!resolved) throw invalidArg("--message <id> is required.", json);
  if (!UUID_PATTERN.test(resolved))
    throw invalidArg(`--message must be a full message UUID; got ${resolved}`, json);
  return { command: "action-withdraw", messageId: resolved.toLowerCase(), json };
}

export function formatInboxRead(result: AgentInboxReadResponse): string {
  if (result.items.length === 0) {
    if (result.hasMore && result.nextCursor) {
      return `No unread items in this window for ${result.target}.\nMore: coforge inbox read --target ${JSON.stringify(result.target)} --cursor ${result.nextCursor}`;
    }
    return `No unread items in ${result.target}.`;
  }
  const lines = [`Inbox read (${result.kind}) — ${result.target}:`];
  for (const item of result.items) {
    if (item.kind === "message") {
      const mention = item.mentionsAgent ? " [mention]" : "";
      lines.push(`  #${item.seq} ${item.sender} (${item.createdAt})${mention}: ${item.body}`);
    } else {
      const rule = item.repeat ? ` (${item.repeat})` : "";
      lines.push(
        `  reminder:${item.id} [${item.status}] due ${item.fireAt}${rule} -> ${item.target}: ${item.title}`,
      );
    }
  }
  if (result.hasMore && result.nextCursor) {
    lines.push(
      `More: coforge inbox read --target ${JSON.stringify(result.target)} --cursor ${result.nextCursor}`,
    );
  }
  return lines.join("\n");
}

export function formatInboxDismiss(result: AgentInboxDismissResponse): string {
  const total =
    result.dismissedConversations +
    result.dismissedThreads +
    result.dismissedAppTargets +
    result.dismissedReminders;
  if (total === 0) return "Dismissed 0 unread items.";
  return `Dismissed ${total} inbox item(s) (${result.dismissedConversations} conversation(s), ${result.dismissedThreads} thread(s), ${result.dismissedAppTargets} app target(s), ${result.dismissedReminders} reminder(s)): ${result.targets.join(", ")}`;
}

export async function runInboxRead(
  transport: MessageTransport,
  invocation: InboxReadInvocation,
): Promise<unknown> {
  if (!transport.inboxRead) throw new Error("Inbox read transport is unavailable");
  const result = await transport.inboxRead({
    target: invocation.target,
    ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
    ...(invocation.cursor === undefined ? {} : { cursor: invocation.cursor }),
  });
  return invocation.json ? result : formatInboxRead(result);
}

export async function runInboxDismiss(
  transport: MessageTransport,
  invocation: InboxDismissInvocation,
): Promise<unknown> {
  if (!transport.inboxDismiss) throw new Error("Inbox dismiss transport is unavailable");
  const result = await transport.inboxDismiss({
    ...(invocation.target ? { target: invocation.target } : {}),
    ...(invocation.before ? { before: invocation.before } : {}),
  });
  return invocation.json ? result : formatInboxDismiss(result);
}

export async function runActionWithdraw(
  transport: MessageTransport,
  invocation: ActionWithdrawInvocation,
): Promise<unknown> {
  if (!transport.actionWithdraw) throw new Error("Action withdraw transport is unavailable");
  const result = await transport.actionWithdraw(invocation.messageId);
  if (invocation.json) return result;
  return result.alreadyWithdrawn
    ? `Action card ${result.messageId} was already withdrawn.`
    : `Action card ${result.messageId} withdrawn.`;
}

export async function inboxReadRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentInboxReadRequest,
): Promise<AgentInboxReadResponse> {
  requireProxySetup("inbox-read", context, proxyUrl);
  const url = proxyEndpoint(agentApiRoutes.local.inboxRead.path);
  url.search = new URLSearchParams({
    target: request.target,
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  }).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: agentApiRoutes.local.inboxRead.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "INBOX_READ_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw proxyHttpFailure(
      "inbox-read",
      response.status,
      await readProxyErrorBody(response),
      request.target,
    );
  }
  return decodeAgentInboxReadResponse(await response.json());
}

export async function inboxDismissRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentInboxDismissRequest,
): Promise<AgentInboxDismissResponse> {
  requireProxySetup("inbox-dismiss", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.local.inboxDismiss.path), {
      method: agentApiRoutes.local.inboxDismiss.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "INBOX_DISMISS_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw proxyHttpFailure(
      "inbox-dismiss",
      response.status,
      await readProxyErrorBody(response),
      request.target,
    );
  }
  return decodeAgentInboxDismissResponse(await response.json());
}

export async function actionWithdrawRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  messageId: string,
): Promise<AgentActionWithdrawResponse> {
  requireProxySetup("action-withdraw", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.local.actionWithdraw.path), {
      method: agentApiRoutes.local.actionWithdraw.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "ACTION_WITHDRAW_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw proxyHttpFailure(
      "action-withdraw",
      response.status,
      await readProxyErrorBody(response),
      undefined,
    );
  }
  return decodeAgentActionWithdrawResponse(await response.json());
}
