import { randomBytes } from "node:crypto";
import type { TokenBinding } from "./agent-proxy-route";

export class AgentProxyTokens {
  readonly #bindings = new Map<string, TokenBinding>();

  find(token: string | undefined): TokenBinding | undefined {
    return token ? this.#bindings.get(token) : undefined;
  }

  register(agentId: string, issueContext: (token: string) => string): string {
    const token = `sfp_${randomBytes(32).toString("base64url")}`;
    this.#bindings.set(token, { agentId, context: issueContext(token) });
    return token;
  }

  revoke(token: string): void {
    this.#bindings.delete(token);
  }

  clear(): void {
    this.#bindings.clear();
  }
}
