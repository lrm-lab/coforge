import { randomBytes } from "node:crypto";

import type { Person } from "./e2e-fake-authing";

/**
 * The part of GitHub the browser reaches when signing in with it (`e2e-github-sign-in.e2e.ts`): its
 * authorize page, which answers at once instead of asking anyone. The Web server is pointed at it
 * through `COFORGE_GITHUB_SIGN_IN_AUTHORIZE_URL`; GitHub's token endpoint is Authing's to call, so
 * the fake Authing asks `consume` whose a code is. Not a test file.
 */

export const githubClientId = "e2e-github-sign-in-client";
export const githubConnection = "e2e-github-mobile";

/** What the next visit to the authorize page does. `state` is what comes back with the code: the
 * one the page was sent (`undefined`), another one, or none (`null`). A `person` of `null` is a code
 * GitHub issued that Authing cannot exchange. */
export type GitHubAnswer =
  | { kind: "approve"; person: Person | null; state?: string | null }
  | { kind: "deny" };

/** An authorize request, as GitHub received it. */
export type GitHubAuthorization = {
  clientId: string | null;
  redirectUri: string | null;
  scope: string | null;
  state: string | null;
};

export function startFakeGithub() {
  const codes = new Map<string, Person | null>();
  /** The authorize requests received, oldest first. */
  const authorizations: GitHubAuthorization[] = [];
  /** The codes issued, oldest first. */
  const issued: string[] = [];
  let answer: GitHubAnswer = { kind: "deny" };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/login/oauth/authorize")
        return new Response("not found", { status: 404 });
      const params = url.searchParams;
      const authorization: GitHubAuthorization = {
        clientId: params.get("client_id"),
        redirectUri: params.get("redirect_uri"),
        scope: params.get("scope"),
        state: params.get("state"),
      };
      authorizations.push(authorization);
      if (authorization.clientId !== githubClientId || !authorization.redirectUri) {
        return new Response("unknown client", { status: 400 });
      }
      const back = new URL(authorization.redirectUri);
      const state =
        "state" in answer && answer.state !== undefined ? answer.state : authorization.state;
      if (answer.kind === "deny") {
        back.searchParams.set("error", "access_denied");
      } else {
        const code = randomBytes(10).toString("hex");
        codes.set(code, answer.person);
        issued.push(code);
        back.searchParams.set("code", code);
      }
      if (state !== null) back.searchParams.set("state", state);
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    },
  });

  return {
    server,
    authorizeUrl: `http://127.0.0.1:${server.port}/login/oauth/authorize`,
    authorizations,
    issued,
    /** Sets what the next authorize request does. */
    respondWith(next: GitHubAnswer) {
      answer = next;
    },
    /** Whose code this is; a code is exchanged once. Undefined when GitHub issued no such code. */
    consume(code: string): Person | undefined {
      const person = codes.get(code);
      codes.delete(code);
      return person ?? undefined;
    },
  };
}
