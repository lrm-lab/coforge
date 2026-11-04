/** The server endpoint for one Agent HTTP path; `what` names the caller in the error. */
export function serverEndpoint(
  serverHttpUrl: string | undefined,
  what: string,
  path: string,
): string {
  if (!serverHttpUrl) throw new Error(`${what} endpoint is not configured`);
  return `${new URL(serverHttpUrl).origin}${path}`;
}

/** The URL of an Agent message route. */
export function messageEndpoint(serverHttpUrl: string | undefined, path: string): string {
  return serverEndpoint(serverHttpUrl, "Agent message HTTP", path);
}
