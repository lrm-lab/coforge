const AGENT_CREDENTIAL_PATTERN = /^(?:sfp|sk_ext)_[A-Za-z0-9_-]{43}$/;

/** The one grammar of an Agent credential: a daemon-issued `sfp_` context token or an external
 * Agent's `sk_ext_` key. Every proxied request checks it before it is issued. */
export function isAgentCredential(value: string): boolean {
  return AGENT_CREDENTIAL_PATTERN.test(value);
}
