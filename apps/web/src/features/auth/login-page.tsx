import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { CoForgeMark } from "#src/components/foundations/logo/coforge-mark";
import { m } from "#src/paraglide/messages";
import { AuthSplitLayout } from "./auth-split-layout";
import { parseCodeDestination } from "./code-destination";
import { CodeSignInForm } from "./code-sign-in-form";
import { GitHubSignIn } from "./github-sign-in";
import type { PasswordUpdated } from "./password-updated";
import type { SignInError } from "./return-to";
import { PasswordSignInForm } from "./password-sign-in-form";

/**
 * CoForge's own sign-in (`/login`): a code sent to a phone number or an email (first, and the
 * way to sign up), or an email and a password, each checked by Authing on the server, and GitHub
 * when the deployment has it (`github`; `error` is why a GitHub sign-in came back). Coming back
 * from setting a password (`passwordUpdated`), it says so and has the destination filled in: on
 * the password tab for an email, on the code tab for a phone number, which has no password
 * sign-in.
 */
export function LoginPage({
  returnTo,
  prompt,
  github,
  error,
  passwordUpdated,
}: {
  returnTo?: string | undefined;
  prompt?: "login" | undefined;
  github: boolean;
  error?: SignInError | undefined;
  passwordUpdated?: PasswordUpdated | undefined;
}) {
  const byPassword =
    passwordUpdated !== undefined &&
    parseCodeDestination(passwordUpdated.destination)?.kind === "email";
  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <CoForgeMark className="h-10" />
          <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
            {m.login_title()}
          </h1>
        </div>
        {passwordUpdated ? (
          <p role="status" className="text-center text-md text-success-primary">
            {byPassword ? m.login_password_updated() : m.login_password_updated_phone()}
          </p>
        ) : null}
        <Tabs defaultSelectedKey={byPassword ? "password" : "code"}>
          <TabList aria-label={m.login_title()} type="underline" size="md" fullWidth>
            <Tab id="code">{m.login_tab_code()}</Tab>
            <Tab id="password">{m.login_tab_password()}</Tab>
          </TabList>
          <TabPanel id="code" className="pt-6">
            <CodeSignInForm
              returnTo={returnTo}
              initialDestination={byPassword ? undefined : passwordUpdated?.destination}
            />
          </TabPanel>
          <TabPanel id="password" className="pt-6">
            <PasswordSignInForm
              returnTo={returnTo}
              prompt={prompt}
              initialEmail={byPassword ? passwordUpdated?.destination : undefined}
            />
          </TabPanel>
        </Tabs>
        {github ? <GitHubSignIn returnTo={returnTo} prompt={prompt} error={error} /> : null}
      </div>
    </AuthSplitLayout>
  );
}
