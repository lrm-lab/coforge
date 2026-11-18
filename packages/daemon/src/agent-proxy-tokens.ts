import { randomBytes } from "node:crypto";
import type { TokenBinding } from "./agent-proxy-route";

export const SESSION_NOT_RUNNING_CODE = "agent_session_not_running";
export const SESSION_NOT_RUNNING_MESSAGE =
  "This Agent has no running session right now, so the request was not sent. Call again once the Agent is running.";

export type IssuedToken = { token: string; created: boolean };

export class AgentProxyTokens {
  readonly #bindings = new Map<string, TokenBinding>();
  readonly #byAgent = new Map<string, string>();

  find(token: string | undefined): TokenBinding | undefined {
    return token ? this.#bindings.get(token) : undefined;
  }

  issue(agentId: string, issueContext: (token: string) => string): IssuedToken {
    const existing = this.#byAgent.get(agentId);
    if (existing && this.#bindings.has(existing)) return { token: existing, created: false };
    const token = `sfp_${randomBytes(32).toString("base64url")}`;
    this.#bindings.set(token, { agentId, context: issueContext(token) });
    this.#byAgent.set(agentId, token);
    return { token, created: true };
  }

  revokeAgent(agentId: string): void {
    const token = this.#byAgent.get(agentId);
    this.#byAgent.delete(agentId);
    if (token) this.#bindings.delete(token);
  }

  revoke(token: string): void {
    const binding = this.#bindings.get(token);
    this.#bindings.delete(token);
    if (binding && this.#byAgent.get(binding.agentId) === token)
      this.#byAgent.delete(binding.agentId);
  }

  clear(): void {
    this.#bindings.clear();
    this.#byAgent.clear();
  }
}
