import type { MemoryAgentToolProfile } from "@lrm/coforge-sdk/agent";
import type { AgentConversationScope } from "./contract";

export type CreateSessionOptions = {
  cwd: string;
  agentId?: string;
  agentDir?: string;
  sessionDir?: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  contextViewRequestLogDirectory?: string;
  modelProvider?: string;
  model?: string;
  /** What a person filled in on the Agent's form, when they did: it wins over the runtime's own
   * model entry, which fills whatever stays absent (task #30). */
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: string;
  apiKey?: string;
  instructions: string;
  environment?: Readonly<Record<string, string>>;
  sessionKind?: "coforge" | "pi";
  conversation?: AgentConversationScope;
  memoryControlSession?: boolean;
  toolProfile?: MemoryAgentToolProfile;
  /** Eval-only Offer contract; ordinary product sessions retain channel send. */
  memoryOfferOnly?: boolean;
};
