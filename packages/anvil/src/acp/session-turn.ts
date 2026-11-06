import type { AgentNoticeOptions } from "@coforge/agent";
import type { AcpTurnReader } from "./profile";

/** One prompt admitted into the session's local queue, awaiting or running its native turn. */
export type AcpSessionInput = {
  text: string;
  /** The id this session assigns the prompt, for a runtime that correlates its own updates. */
  promptId?: string;
  options?: AgentNoticeOptions;
  admission: ReturnType<typeof Promise.withResolvers<void>>;
  attempted: boolean;
  updates: AcpTurnReader;
};

/** A native turn the provider accepted, tracked until its own settlement arrives. */
export type AcpNativeTurnState = {
  promptId: string;
  updates: AcpTurnReader;
  settled: ReturnType<typeof Promise.withResolvers<void>>;
};

const SEEN_LIMIT = 256;

/** Adds `value`, evicting the oldest entry once the set exceeds its bound. */
export function rememberCompletedPrompt(seen: Set<string>, value: string) {
  seen.add(value);
  if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
}
