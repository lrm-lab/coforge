import { spyOn } from "bun:test";

export const githubTestConfig = {
  appId: 5261083,
  clientId: "test-client",
  clientSecret: "test-client-secret",
  callbackUrl: "https://staging.coforge.cn/api/integrations/github/callback",
  appSlug: "coforge-staging",
  encryptionKey: new Uint8Array(32).fill(7),
  webhookSecret: null,
};

/** The warnings written while `run` ran, parsed; each is one JSON line. */
export async function warningsDuring(run: () => Promise<unknown>) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await run();
    return warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  } finally {
    warn.mockRestore();
  }
}
