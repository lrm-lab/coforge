const AGENT_CREDENTIAL_PATTERN = /^(?:sfp|sk_ext)_[A-Za-z0-9_-]{43}$/;
const EXTERNAL_CREDENTIAL_PATTERN = /^sk_ext_[A-Za-z0-9_-]{43}$/;

export function isAgentCredential(value: string): boolean {
  return AGENT_CREDENTIAL_PATTERN.test(value);
}

export function isExternalCredential(value: string): boolean {
  return EXTERNAL_CREDENTIAL_PATTERN.test(value);
}
