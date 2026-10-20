import { AlertCircle } from "@untitledui/icons";
import { useState, type ReactNode } from "react";

import { Button } from "#src/components/base/buttons/button";
import { FeaturedIcon } from "#src/components/foundations/featured-icon/featured-icon";
import { signOutHref } from "#src/features/auth/return-to";
import { signOut } from "#src/features/auth/sign-out";
import { AUTHORIZATION_ENDPOINT_PATH } from "#src/lib/oidc-paths";
import { m } from "#src/paraglide/messages";
import type { AuthorizationPage } from "#src/server/authorization-server/authorization-endpoint.server";
import { AuthorizationConsent } from "./app-authorization-consent";
import { AuthorizationFaq } from "./app-authorization-faq";

/**
 * Login with CoForge's page at `/oidc/auth`: the consent an app asks for, or why the request
 * cannot go on. `search` is the authorization request's query, which signing out comes back to.
 */
export function AppAuthorizationPage({
  page,
  account,
  search,
}: {
  page: AuthorizationPage;
  account: string | null;
  search: string;
}) {
  const [shown, setShown] = useState(page);
  return (
    <div className="min-h-dvh bg-secondary">
      <header className="border-b border-secondary bg-primary">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-semibold text-tertiary">
              {m.app_authorization_sign_in_with()}
            </span>
            <img src="/logo.svg" alt="CoForge" className="size-6" />
          </div>
          {account === null ? null : (
            // Signing out goes through Authing, then back to sign-in and this request.
            <Button
              color="secondary"
              size="sm"
              onPress={() => void signOut(signOutHref(`${AUTHORIZATION_ENDPOINT_PATH}?${search}`))}
            >
              {m.app_authorization_sign_out()}
            </Button>
          )}
        </div>
      </header>
      {shown.view === "consent" ? (
        <main className="mx-auto grid max-w-5xl gap-5 px-4 py-6 sm:gap-6 sm:px-5 sm:py-8 md:grid-cols-[1fr_22.5rem] md:py-10">
          <Card>
            <AuthorizationConsent page={shown} account={account} onRefused={setShown} />
          </Card>
          <aside className="self-start rounded-xl bg-primary p-5 shadow-xs ring-1 ring-secondary">
            <AuthorizationFaq />
          </aside>
        </main>
      ) : (
        <main className="mx-auto max-w-2xl px-4 py-6 sm:px-5 sm:py-8 md:py-10">
          <Card>
            <Refusal page={shown} account={account} />
          </Card>
        </main>
      )}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl bg-primary p-4 shadow-xs ring-1 ring-secondary sm:p-6">
      {children}
    </section>
  );
}

/** A request the page will not continue: a link that names no usable app, or an app installed in
 * none of the person's Workspaces. */
function Refusal({
  page,
  account,
}: {
  page: Exclude<AuthorizationPage, { view: "consent" }>;
  account: string | null;
}) {
  return (
    <div className="flex flex-col gap-5">
      <FeaturedIcon icon={AlertCircle} color="error" theme="light" size="lg" />
      <div className="flex flex-col gap-2">
        <h1 className="text-display-xs font-semibold break-words text-primary">
          {page.view === "unavailable"
            ? m.app_authorization_unavailable_title({ app: page.app.name })
            : page.view === "expired"
              ? m.app_authorization_expired_title()
              : m.app_authorization_invalid_title()}
        </h1>
        <p className="text-md break-words text-tertiary">
          {page.view === "unavailable"
            ? m.app_authorization_unavailable_description()
            : page.view === "expired"
              ? m.app_authorization_expired_description()
              : page.reason === "missing_client_id"
                ? m.app_authorization_invalid_missing_client_id()
                : page.reason === "unknown_client"
                  ? m.app_authorization_invalid_unknown_client()
                  : m.app_authorization_invalid_redirect_uri()}
        </p>
      </div>
      {page.view === "unavailable" ? (
        <div className="rounded-lg bg-secondary p-4 text-sm">
          <h2 className="font-semibold text-primary">{m.app_authorization_get_access_title()}</h2>
          <p className="mt-1 text-tertiary">
            {m.app_authorization_get_access_body({ app: page.app.name })}
          </p>
        </div>
      ) : null}
      {account === null ? null : (
        <p className="text-xs break-all text-quaternary">
          {m.app_authorization_signed_in_as({ account })}
        </p>
      )}
    </div>
  );
}
