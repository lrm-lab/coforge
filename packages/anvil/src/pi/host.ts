import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";

export interface PiReplyIntentScanner {
  feed(delta: {
    callId: string;
    fragment: string;
  }): Extract<AgentRuntimeEvent, { type: "reply-intent" }> | undefined;
  complete(callId: string): void;
  reset(): string[];
}
export interface PiSessionHost {
  createReplyIntentScanner(): PiReplyIntentScanner;
  isShellToolName(name: string): boolean;
}
export interface PiCatalogHost {
  getDefaultAgentDirectory(): string;
}
export interface PiRuntimeHost extends PiSessionHost, PiCatalogHost {
  buildSessionEnvironment(options: AgentSessionOptions): Record<string, string>;
}
export interface PiProviderOptions {
  readonly host: PiRuntimeHost;
}
