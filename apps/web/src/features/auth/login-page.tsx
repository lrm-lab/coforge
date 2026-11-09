import { useState } from "react";
import type { Key } from "react-aria-components";
import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { m } from "#src/paraglide/messages";
import { parseCodeDestination } from "./code-destination";
import { CodeSignInForm } from "./code-sign-in-form";
import { GitHubSignIn } from "./github-sign-in";
import { LoginSplitLayout } from "./login-split-layout";
import type { PasswordUpdated } from "./password-updated";
import type { SignInError } from "./return-to";
import { PasswordSignInForm } from "./password-sign-in-form";

/**
 * CoForge's own sign-in (`/login`): a code sent to a phone number (first, and the way to sign up),
 * or an email and a password, each checked by Authing on the server, and GitHub when the
 * deployment has it (`github`; `error` is why a GitHub sign-in came back). A code can also go to
 * an email: the password tab's "email code" link opens the code tab worded for an email, with a
 * way back to the phone. Coming back from setting a password (`passwordUpdated`), it says so and
 * has the destination filled in: on the password tab for an email, on the code tab for a phone
 * number, which has no password sign-in.
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
  const [tab, setTab] = useState<Key>(byPassword ? "password" : "code");
  const [byEmail, setByEmail] = useState(false);
  return (
    <LoginSplitLayout>
      <div className="login-form flex w-full flex-col gap-8">
        <h1 className="text-display-sm font-semibold text-primary">{m.login_heading()}</h1>
        {passwordUpdated ? (
          <p role="status" className="text-md text-success-primary">
            {byPassword ? m.login_password_updated() : m.login_password_updated_phone()}
          </p>
        ) : null}
        <Tabs selectedKey={tab} onSelectionChange={setTab}>
          <TabList
            aria-label={m.login_heading()}
            type="underline"
            size="md"
            className="w-max gap-10"
          >
            <Tab id="code" className="px-0 *:px-0">
              {byEmail ? m.login_tab_email_code() : m.login_tab_phone()}
            </Tab>
            <Tab id="password" className="px-0 *:px-0">
              {m.login_tab_password()}
            </Tab>
          </TabList>
          {/* Both panels share a minimum height, so the tabs and title above them never move. */}
          <TabPanel id="code" className="min-h-72 pt-10">
            <CodeSignInForm
              key={byEmail ? "email" : "phone"}
              returnTo={returnTo}
              kind={byEmail ? "email" : "phone"}
              initialDestination={byPassword || byEmail ? undefined : passwordUpdated?.destination}
            />
            {byEmail ? (
              <div className="mt-4">
                {/* lg is the link size whose text matches the row's text-md. */}
                <Button color="link-gray" size="lg" noTextPadding onPress={() => setByEmail(false)}>
                  {m.login_tab_phone()}
                </Button>
              </div>
            ) : null}
            {github ? (
              <div className="mt-5">
                <GitHubSignIn returnTo={returnTo} prompt={prompt} error={error} />
              </div>
            ) : null}
          </TabPanel>
          <TabPanel id="password" className="min-h-72 pt-10">
            <PasswordSignInForm
              returnTo={returnTo}
              prompt={prompt}
              initialAccount={byPassword ? passwordUpdated?.destination : undefined}
              onEmailCode={() => {
                setByEmail(true);
                setTab("code");
              }}
            />
          </TabPanel>
        </Tabs>
      </div>
    </LoginSplitLayout>
  );
}
