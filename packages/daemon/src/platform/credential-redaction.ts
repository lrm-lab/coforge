/**
 * The one scrubber for text that leaves the Agent's machine as Activity, a failure detail or a log
 * line: `key=value` credential assignments, `sk-` keys, Agent API keys (`sk_agent_…`), Local Proxy
 * tokens (`sfp_…`), app client secrets (`cfa_secret_…`) and bearer credentials. Best effort: it
 * cannot recognize arbitrary sensitive text.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\b(?:sk_[a-z]+_|sfp_)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    .replace(/cfa_secret_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}
