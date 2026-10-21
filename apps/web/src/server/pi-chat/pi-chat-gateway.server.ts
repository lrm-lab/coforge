import {
  piChatResultSchema,
  type PiChatCommand,
  type PiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat";
import { signPiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-auth";
import { AppError } from "#src/lib/app-error";

/** The browser names a Computer; the server supplies its authenticated User and Workspace. */
export class PiChatGateway {
  constructor(
    private readonly ports: {
      origin: string;
      secret: string;
      canUse(scope: PiChatScope): Promise<boolean>;
      fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
    },
  ) {}
  async execute(
    identity: { userId: string; workspaceId: string },
    computerId: string,
    command: PiChatCommand,
  ) {
    const scope = { ...identity, computerId };
    if (!(await this.ports.canUse(scope))) throw new AppError("ACCESS_DENIED");
    const time = Date.now();
    const body = JSON.stringify({ scope, command });
    try {
      const response = await this.ports.fetch(new URL("/pi-chat/v1", this.ports.origin), {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-coforge-chat-time": String(time),
          "x-coforge-chat-signature": signPiChatRequest(this.ports.secret, time, body),
        },
        signal: AbortSignal.timeout(35_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("host unavailable");
      return piChatResultSchema.parse(await response.json());
    } catch {
      throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "pi-chat-host-unavailable" });
    }
  }
}
