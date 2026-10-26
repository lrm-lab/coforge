import type { ReplyIntentTarget, ReplyTargetResolver } from "./reply-intent-publish.server";

/** A start repeats every 8 seconds; an idle target expires after about four missed repeats. */
const REPLY_TARGET_TTL_MS = 30_000;
const REPLY_TARGET_CACHE_MAX_ENTRIES = 512;

/**
 * `resolve`, remembering each answer for a short time, so a call's repeated starts and its end
 * do not read the database again. Keyed by Workspace, Agent, call and target, so another call to
 * the same target is read afresh. Only a target that resolved is remembered: a failed read or a
 * target nothing resolves is read again. Repeats renew the entry, so a long call keeps its target;
 * idle entries expire. Process-local and bounded: the oldest entry goes first.
 */
export function cachedReplyTargetResolver(
  resolve: ReplyTargetResolver,
  {
    ttlMs = REPLY_TARGET_TTL_MS,
    maxEntries = REPLY_TARGET_CACHE_MAX_ENTRIES,
    now = Date.now,
  }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): ReplyTargetResolver {
  const entries = new Map<string, { target: ReplyIntentTarget; at: number }>();
  return async (call) => {
    const key = [call.workspaceId, call.agentId, call.callId, call.target].join("\u0000");
    const known = entries.get(key);
    if (known && now() - known.at < ttlMs) {
      known.at = now();
      return known.target;
    }
    const target = await resolve(call);
    if (!target) return target;
    entries.delete(key);
    while (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
    entries.set(key, { target, at: now() });
    return target;
  };
}
