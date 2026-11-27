type Probe = (url: string, options: RequestInit) => Promise<Response>;

export async function verifyBlockedEgress(probe: Probe = fetch) {
  async function blocked(url: string) {
    try {
      await probe(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(3500) });
      return false;
    } catch {
      return true;
    }
  }

  const [hostnameBlocked, directIpBlocked] = await Promise.all([
    blocked("https://example.com/"),
    blocked("http://1.1.1.1/"),
  ]);
  if (!hostnameBlocked || !directIpBlocked) throw new Error("External egress was reachable");
  return { hostnameBlocked, directIpBlocked };
}
