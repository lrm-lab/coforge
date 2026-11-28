import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseStatus } from "@tanstack/react-start/server";

import { authMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { optionalBrowserSignIn } from "#src/server/auth/require-user.server";
import { signedInAccount } from "#src/server/auth/signed-in-account.server";
import type { AuthorizationPage } from "#src/server/authorization-server/authorization-endpoint.server";
import { currentAuthorizationEndpoint } from "#src/server/authorization-server/authorization-endpoint-composition.server";
import { requireDatabaseClient } from "#src/server/db/client.server";
import {
  authorizationDecisionInputSchema,
  authorizationPageInputSchema,
} from "./app-authorization.schemas";
import { requestedAuthorizationQuery } from "./authorization-query.server";

/** What `/oidc/auth` answers: a redirect, the page, or nothing when no issuer is configured. */
type AuthorizationPageResult =
  | { kind: "not_found" }
  | { kind: "redirect"; location: string }
  | {
      kind: "page";
      page: AuthorizationPage;
      account: string | null;
      /** The request the page is for, for signing out and back to it. */
      query: string;
    };

export const AUTHORIZATION_PAGE_STATUS = {
  invalid_client: 400,
  expired: 400,
  unavailable: 403,
  consent: 200,
} as const;

export const getAuthorizationPage = createServerFn({ method: "GET" })
  .validator(authorizationPageInputSchema)
  .handler(async ({ data }): Promise<AuthorizationPageResult> => {
    declareNoStore();
    const endpoint = await currentAuthorizationEndpoint();
    if (!endpoint) return { kind: "not_found" };
    const query = await requestedAuthorizationQuery(data.search);
    if (query === undefined) {
      setResponseStatus(AUTHORIZATION_PAGE_STATUS.expired);
      return { kind: "page", page: { view: "expired" }, account: null, query: "" };
    }
    const signIn = await optionalBrowserSignIn(getRequest().headers.get("cookie") ?? undefined);
    const outcome = await endpoint.begin(
      query,
      signIn && { userId: signIn.user.id, authTime: signIn.authTime },
    );
    if (outcome.kind === "redirect") return outcome;
    setResponseStatus(AUTHORIZATION_PAGE_STATUS[outcome.page.view]);
    const account = signIn
      ? (await signedInAccount(requireDatabaseClient(), signIn.user)).account
      : null;
    return { kind: "page", page: outcome.page, account, query };
  });

/** The person's Continue or Cancel: where the browser goes next, or the page that refuses it. A
 * same-origin call only (`createCsrfMiddleware` in `start.ts`), from a signed-in person, about the
 * request the page's handle binds. */
export const decideAuthorization = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(authorizationDecisionInputSchema)
  .handler(
    async ({ data, context }): Promise<{ location: string } | { page: AuthorizationPage }> => {
      declareNoStore();
      const endpoint = await currentAuthorizationEndpoint();
      if (!endpoint) return { page: { view: "expired" } };
      const outcome = await endpoint.decide(
        data.handle,
        { userId: context.user.id, authTime: context.authTime },
        data.decision,
      );
      return outcome.kind === "redirect" ? { location: outcome.location } : { page: outcome.page };
    },
  );
