import type { Http } from "#src/server/integrations/github-api.server";

/**
 * A fake GitHub. An authorization `code` of `<name>` is exchanged for the token `ghu_<name>`, and
 * `githubUserOf(token)` says whose GitHub account that token reads. Every revoke call is recorded;
 * a revoke runs in the background, so `revocations(count)` waits for that many.
 */
export function fakeGitHub(
  githubUserOf: (token: string) => number | Promise<number>,
  revokeAnswer: () => Response = () => new Response(null, { status: 204 }),
) {
  const revoked: { url: string; authorization: string; body: unknown }[] = [];
  const waiting: { count: number; done: () => void }[] = [];
  const http: Http = async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    if (init.method === "DELETE") {
      revoked.push({
        url,
        authorization: headers.authorization ?? "",
        body: JSON.parse(String(init.body)),
      });
      // Let the caller handle the answer (and log a failure) before a waiter resumes.
      setTimeout(() => {
        for (const waiter of waiting) if (revoked.length >= waiter.count) waiter.done();
      }, 10);
      return revokeAnswer();
    }
    if (url === "https://github.com/login/oauth/access_token")
      return Response.json({
        access_token: `ghu_${new URLSearchParams(String(init.body)).get("code")}`,
        refresh_token: "ghr_private_token",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
        token_type: "bearer",
      });
    if (url.startsWith("https://api.github.com/user/installations"))
      return Response.json({ total_count: 0, installations: [] });
    if (url === "https://api.github.com/user")
      return Response.json({
        id: await githubUserOf(headers.authorization!.slice("Bearer ".length)),
        login: "shared-octo",
      });
    throw new Error(`unexpected request to ${url}`);
  };
  /** Resolves once `count` revokes are recorded and answered; rejects after `timeoutMs`. */
  const revocations = (count: number, timeoutMs = 2_000) =>
    new Promise<void>((resolve, reject) => {
      if (revoked.length >= count) return void setTimeout(resolve, 10);
      const timer = setTimeout(
        () => reject(new Error(`expected ${count} revokes, got ${revoked.length}`)),
        timeoutMs,
      );
      waiting.push({
        count,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  return { http, revoked, revocations };
}
