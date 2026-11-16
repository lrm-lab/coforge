const AGENT_CREDENTIAL_PATTERN = /^(?:sfp|sk_ext)_[A-Za-z0-9_-]{43}$/;
const EXTERNAL_CREDENTIAL_PATTERN = /^sk_ext_[A-Za-z0-9_-]{43}$/;

/** The one grammar of an Agent credential: a daemon-issued `sfp_` context token or an external
 * Agent's `sk_ext_` key. Every proxied request checks it before it is issued. */
export function isAgentCredential(value: string): boolean {
  return AGENT_CREDENTIAL_PATTERN.test(value);
}

/** True only for an external Agent's `sk_ext_` key, never a daemon-issued `sfp_` token. */
export function isExternalCredential(value: string): boolean {
  return EXTERNAL_CREDENTIAL_PATTERN.test(value);
}
