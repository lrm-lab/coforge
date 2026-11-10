import type { PiChatCommand, PiChatScope, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { AppError } from "#src/lib/app-error";

export type PiChatReply = { result?: PiChatResult; error?: string };
/** What the store holds for a request id under one scope. `gone` is a request that never was, one
 * of another scope, and one that expired; nothing tells them apart. */
export type PiChatReplyState =
  | { state: "pending" }
  | { state: "gone" }
  | { state: "reply"; reply: PiChatReply };
export interface PiChatResults {
  begin(request: PiChatRequest): Promise<void>;
  read(scope: PiChatScope, requestId: string): Promise<PiChatReplyState>;
}
/** The daemon's answer to a started command. The three settled states are values, never throws:
 * the caller asks again after a read that throws. */
export type PiChatRead =
  | { status: "pending" }
  | { status: "ready"; result: PiChatResult }
  | { status: "failed" }
  | { status: "denied" };

/**
 * User-authorized commands on the existing Workspace Daemon connection. No host network route.
 * A command is started and its reply read in two calls, because production closes a request that
 * sends no bytes for about ten seconds and the daemon's reply can take longer.
 */
export class PiChatGateway {
  constructor(
    private readonly ports: {
      canUse(scope: PiChatScope): Promise<boolean>;
      online(scope: PiChatScope, command: PiChatCommand): Promise<boolean>;
      publish(request: PiChatRequest): Promise<void>;
      results: PiChatResults;
    },
  ) {}
  /** Publishes the command to the Computer's daemon and answers with the id its reply is read by. */
  async start(
    identity: { userId: string; workspaceId: string },
    computerId: string,
    command: PiChatCommand,
  ) {
    const scope = { ...identity, computerId };
    if (!(await this.ports.canUse(scope))) throw new AppError("ACCESS_DENIED");
    const request: PiChatRequest = { ...scope, requestId: crypto.randomUUID(), command };
    try {
      if (!(await this.ports.online(scope, command))) throw new Error("Pi chat daemon unavailable");
      await this.ports.results.begin(request);
      await this.ports.publish(request);
    } catch {
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "pi-chat-daemon-unavailable" });
    }
    return { requestId: request.requestId };
  }
  /** The reply to a started command, for the caller it was started for and only while the caller
   * may still use the Computer. The store is asked first (it matches the caller's scope) and the
   * caller is authorized only once a reply exists, so a poll that finds nothing does no database
   * work. A store that cannot be reached throws, which the caller retries. */
  async read(
    identity: { userId: string; workspaceId: string },
    computerId: string,
    requestId: string,
  ): Promise<PiChatRead> {
    const scope = { ...identity, computerId };
    const answer = await this.ports.results.read(scope, requestId);
    if (answer.state === "pending") return { status: "pending" };
    if (answer.state === "gone") return { status: "failed" };
    if (!(await this.ports.canUse(scope))) return { status: "denied" };
    const { result, error } = answer.reply;
    return result && !error ? { status: "ready", result } : { status: "failed" };
  }
}
