const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_V4.test(hostname);
}
