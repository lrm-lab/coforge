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
