import {
  piChatResultSchema,
  type PiChatCommand,
  type PiChatScope,
  type PiChatResult,
} from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { AppError } from "#src/lib/app-error";

export type PiChatReply = { result?: PiChatResult; error?: string };
export interface PiChatResults {
  begin(request: PiChatRequest): Promise<void>;
  read(requestId: string): Promise<PiChatReply | undefined>;
  clear(requestId: string): Promise<void>;
}

/** User-authorized commands on the existing Workspace Daemon connection. No host network route. */
export class PiChatGateway {
  constructor(
    private readonly ports: {
      canUse(scope: PiChatScope): Promise<boolean>;
      online(scope: PiChatScope): Promise<boolean>;
      publish(request: PiChatRequest): Promise<void>;
      results: PiChatResults;
    },
    private readonly timing = { now: Date.now, wait: () => Bun.sleep(50), timeoutMs: 25_000 },
  ) {}
  async execute(
    identity: { userId: string; workspaceId: string },
    computerId: string,
    command: PiChatCommand,
  ) {
    const scope = { ...identity, computerId };
    if (!(await this.ports.canUse(scope))) throw new AppError("ACCESS_DENIED");
    const request: PiChatRequest = { ...scope, requestId: crypto.randomUUID(), command };
    const { results } = this.ports;
    try {
      if (!(await this.ports.online(scope))) throw new Error("Pi chat daemon unavailable");
      await results.begin(request);
      await this.ports.publish(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      do {
        const reply = await results.read(request.requestId);
        if (reply) {
          if (!(await this.ports.canUse(scope))) throw new AppError("ACCESS_DENIED");
          if (!reply.result || reply.error) throw new Error("Pi chat command failed");
          return piChatResultSchema.parse(reply.result);
        }
        await this.timing.wait();
      } while (this.timing.now() < deadline);
      throw new Error("Pi chat response timed out");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "pi-chat-daemon-unavailable" });
    } finally {
      await results.clear(request.requestId).catch(() => {});
    }
  }
}
