import { CliError } from "../cli-error";
import { connectLocal } from "../local-client";
import { formatMessageLine } from "../message-format";
import type { MessageReadOptions } from "../message-read-args";
import type { MessageSearchOptions } from "../message-search-args";
import { refuseCredentialSolicitationIfNeeded } from "../send-credential-gate";
import type { ReminderTransportRequest } from "../reminder-commands";
import type { MessageTransport } from "../message-transport";
import { daemonOnlyError } from "./refusal";
import type { ExternalSession, ProfileStore } from "./profile-store";
import { serverRequest } from "./server-request";

const API = "/api/agent/v1";
const NOT_YET = "is not available to external Agents in this CLI version.";
const DAEMON_REMINDER =
  "Reminder ack, dismiss and seals live in the Computer's daemon, which an external Agent does not have.";

type LocalTransport = ReturnType<typeof connectLocal> & MessageTransport;
type SendOptions = Parameters<MessageTransport["send"]>[2];
type Messages = { messages: unknown[]; hasMore: boolean };

function refuse(reason: string): () => Promise<never> {
  return async () => {
    throw daemonOnlyError(reason);
  };
}

export function connectExternal(
  session: ExternalSession,
  store: ProfileStore,
): { transport: LocalTransport; commit: () => Promise<void> } {
  const { profile, slug: profileSlug } = session;
  const connection = { serverUrl: profile.serverUrl, apiKey: profile.apiKey };
  const base = connectLocal("", profile.apiKey, profile.serverUrl, "");
  let nextCursor: string | undefined;

  const events = async (since: string | undefined): Promise<Record<string, unknown>> =>
    (await serverRequest(connection, {
      method: "GET",
      path: `${API}/events`,
      query: { since },
      operation: "check",
    })) as Record<string, unknown>;

  async function check(target?: string): Promise<Messages> {
    if (target) {
      const page = (await serverRequest(connection, {
        method: "GET",
        path: `${API}/messages`,
        query: { target, unread: "true" },
        operation: "check",
      })) as { messages: unknown[]; moreUnread?: boolean };
      return { messages: page.messages, hasMore: page.moreUnread === true };
    }
    const since = await store.readCursor(profileSlug);
    let page: Record<string, unknown>;
    try {
      page = await events(since);
    } catch (error) {
      if (!(since && error instanceof CliError && /invalid since cursor/.test(error.message)))
        throw error;
      page = await events(undefined);
    }
    if (typeof page.cursor === "string") nextCursor = page.cursor;
    return { messages: page.events as unknown[], hasMore: page.hasMore === true };
  }

  async function read(target: string, options?: MessageReadOptions): Promise<unknown> {
    return serverRequest(connection, {
      method: "GET",
      path: `${API}/messages`,
      query: {
        target,
        unread: options?.unread ? "true" : undefined,
        before: options?.before,
        after: options?.after,
        around: options?.around,
        limit: options?.limit === undefined ? undefined : String(options.limit),
      },
      operation: "read",
    });
  }

  async function search(options: MessageSearchOptions): Promise<unknown> {
    const answer = (await serverRequest(connection, {
      method: "GET",
      path: `${API}/messages/search`,
      query: {
        query: options.query,
        target: options.target,
        sender: options.sender,
        sort: options.sort,
        before: options.before,
        after: options.after,
        offset: options.offset === undefined ? undefined : String(options.offset),
        cursor: options.cursor,
        limit: options.limit === undefined ? undefined : String(options.limit),
      },
      operation: "search",
    })) as { results: unknown[] } & Record<string, unknown>;
    const { results, ...paging } = answer;
    return { ...paging, messages: results };
  }

  async function send(target: string, body?: string, options?: SendOptions): Promise<unknown> {
    if (options?.sendDraft || options?.expectedDraftKey)
      throw daemonOnlyError(
        "Message drafts live in the Computer's daemon; send the message body on stdin.",
      );
    if (!body) throw daemonOnlyError("A message body is required on stdin.");
    refuseCredentialSolicitationIfNeeded("send", body, target);
    let answer: { state?: string } & Record<string, unknown>;
    try {
      answer = (await serverRequest(connection, {
        method: "POST",
        path: `${API}/messages`,
        body: {
          idempotencyKey: crypto.randomUUID(),
          target,
          content: body,
          ...(options?.continueAnyway ? { continueAnyway: true } : {}),
          ...(options?.freshnessContextMode
            ? { freshnessContextMode: options.freshnessContextMode }
            : {}),
          ...(options?.attachmentIds ? { attachmentIds: options.attachmentIds } : {}),
          ...(options?.mentions ? { mentions: options.mentions } : {}),
        },
        operation: "send",
        timeoutMs: 30_000,
      })) as typeof answer;
    } catch (error) {
      if (
        error instanceof CliError &&
        error.code === "SEND_FAILED" &&
        error.message.includes("network")
      )
        throw new CliError({
          code: "SEND_FAILED",
          message: error.message,
          retryable: false,
          suggestedNextAction: `Delivery state is UNKNOWN: the message may or may not have been committed. Run \`coforge message read --target ${JSON.stringify(target)}\` before sending it again.`,
        });
      throw error;
    }
    if (answer.state !== "held") return answer;
    const held = answer as {
      newMessageCount?: number;
      heldMessages?: Parameters<typeof formatMessageLine>[0][];
    };
    throw new CliError({
      code: "SEND_HELD",
      message: `Not sent: ${held.newMessageCount ?? "new"} message(s) arrived in ${target} that you have not read.`,
      retryable: false,
      contextText: (held.heldMessages ?? []).map(formatMessageLine).join("\n"),
      suggestedNextAction:
        "Read what arrived, then send again; add --anyway to send without changing your message.",
    });
  }

  async function resolve(messageId: string): Promise<unknown> {
    const answer = (await serverRequest(connection, {
      method: "GET",
      path: `${API}/messages/${encodeURIComponent(messageId)}/resolve`,
      operation: "resolve",
    })) as { message?: unknown };
    return { messages: answer.message ? [answer.message] : [] };
  }

  const react = (messageId: string, emoji: string, remove?: boolean) =>
    serverRequest(connection, {
      method: remove ? "DELETE" : "POST",
      path: `${API}/messages/${encodeURIComponent(messageId)}/reactions`,
      body: { emoji },
      operation: "react",
    });

  async function reminder(request: ReminderTransportRequest) {
    if (
      request.operation === "ack" ||
      request.operation === "dismiss" ||
      request.operation === "seal" ||
      request.operation === "unseal"
    )
      throw daemonOnlyError(DAEMON_REMINDER);
    return (await serverRequest(connection, {
      method: "POST",
      path: `${API}/reminders`,
      body: {
        ...request,
        idempotencyKey: crypto.randomUUID(),
        workspaceId: profile.workspaceId,
        agentId: profile.agentId,
        computerId: profile.agentId,
      },
      operation: "reminder",
    })) as Awaited<ReturnType<NonNullable<MessageTransport["reminder"]>>>;
  }

  const transport = {
    ...base,
    external: session,
    check,
    read,
    search,
    send,
    resolve,
    react,
    reminder,
    inboxCheck: async () => ({ entries: [], seals: [] }),
    continue: refuse("Held-send continuations live in the Computer's daemon."),
    contextSearch: refuse(
      "`coforge context` searches the daemon's context view, which an external Agent does not have.",
    ),
    contextRead: refuse(
      "`coforge context` reads the daemon's context view, which an external Agent does not have.",
    ),
    procList: refuse(
      "`coforge proc` manages background jobs inside the Computer's daemon, which an external Agent does not have.",
    ),
    procStart: refuse(
      "`coforge proc` manages background jobs inside the Computer's daemon, which an external Agent does not have.",
    ),
    procLogs: refuse(
      "`coforge proc` manages background jobs inside the Computer's daemon, which an external Agent does not have.",
    ),
    procStop: refuse(
      "`coforge proc` manages background jobs inside the Computer's daemon, which an external Agent does not have.",
    ),
    githubCredential: refuse("The GitHub credential helper needs the Computer's daemon."),
    githubCommitTrailers: refuse("Commit co-author trailers need the Computer's daemon."),
    setChannelMuted: refuse(`Muting a channel ${NOT_YET}`),
    setThreadFollowed: refuse(`Unfollowing a thread ${NOT_YET}`),
    channel: refuse(`Channel management ${NOT_YET}`),
  } as unknown as LocalTransport;

  return {
    transport,
    commit: async () => {
      if (nextCursor) await store.writeCursor(profileSlug, nextCursor);
      nextCursor = undefined;
    },
  };
}
