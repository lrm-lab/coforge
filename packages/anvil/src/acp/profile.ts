import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/** The messages a runtime's own ACP protocol failures carry. */
export type AcpProfileMessages = Readonly<{
  unsupportedProtocol: string;
  closedBeforeConfig: string;
  timedOut: string;
}>;

/**
 * One ACP runtime's differences, declared in one place: the arguments its connection adds to the
 * resolved executable, the identity its sessions announce, the notifications it publishes beyond
 * `session/update`, how it reads published configuration, and the wording of its own failures.
 *
 * `acpProcess` builds the process and client from a profile; a later `acpSession` derives the
 * session state machine from the same profile, so a runtime's differences cannot drift between
 * the two layers.
 */
export type AcpRuntimeProfile = Readonly<{
  /** Arguments after the resolved executable, before any the caller appends. */
  args: readonly string[];
  /** Extra ACP notification methods this runtime publishes, observed like `session/update`. */
  notifications?: readonly string[];
  /** Reads a `config_option_update` into the options this runtime publishes; absent for a
   * runtime that never publishes configuration this way. */
  readConfig?(update: Readonly<Record<string, unknown>>): SessionConfigOption[] | undefined;
  messages: AcpProfileMessages;
}>;
