import type { AgentNoticeOptions } from "@coforge/agent";
import type { AcpSessionProfile, AcpTurnReader } from "./profile";

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

export function acpRejectInput(
  text: string,
  profile: Pick<AcpSessionProfile, "label" | "maxInputBytes">,
  unavailable: boolean,
): Error | undefined {
  if (unavailable) return new Error(`${profile.label} cannot accept input before submission`);
  if (profile.maxInputBytes === undefined) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= profile.maxInputBytes) return undefined;
  return new Error(
    `${profile.label} input is too large (${bytes} bytes exceeds the maximum of ${profile.maxInputBytes} bytes)`,
  );
}

export function acpCancelPendingNotices(
  label: string,
  queue: AcpSessionInput[],
  active: AcpSessionInput | undefined,
) {
  for (const input of queue.splice(0))
    input.admission.reject(new Error(`${label} queued input cancelled before submission`));
  active?.admission.reject(
    new Error(
      active.attempted
        ? `${label} input cancelled; delivery outcome is unknown`
        : `${label} input cancelled before submission`,
    ),
  );
}
