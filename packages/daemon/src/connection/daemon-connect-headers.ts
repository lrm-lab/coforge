/**
 * The headers a Workspace Daemon sends on Centrifugo connect. The API key travels as a header,
 * not connect data: Centrifugo redacts emulated header values in its command logs, while
 * connect data is logged verbatim on every failed attempt. The instance id lets the connect
 * proxy tell this process's own half-open predecessor (same id, let it reconnect) from a
 * second daemon holding the binding (different id, refuse); a proxy that does not know it yet
 * ignores the header.
 */
export function daemonConnectHeaders(
  apiKey: string,
  workerInstanceId?: string,
): Record<string, string> {
  return {
    "X-CoForge-Daemon-Api-Key": apiKey,
    ...(workerInstanceId ? { "X-CoForge-Daemon-Instance-Id": workerInstanceId } : {}),
  };
}
