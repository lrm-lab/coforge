import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { signInWithAccountPassword } from "./sign-in.functions";

type Problem =
  | "invalid_credentials"
  | "no_password"
  | "account_locked"
  | "code_required"
  | "login_quota_exhausted"
  | "login_unavailable"
  | "failed";

const problemText: Record<Problem, () => string> = {
  invalid_credentials: () => m.login_invalid_credentials(),
  no_password: () => m.login_no_password(),
  account_locked: () => m.login_account_locked(),
  code_required: () => m.login_code_required(),
  login_quota_exhausted: () => m.login_quota_exhausted(),
  login_unavailable: () => m.login_unavailable(),
  failed: () => m.login_failed(),
};

/**
 * Sign-in with an account (email or username) and a password, checked by Authing on the server. A refusal stays under
 * the form; success is a full navigation to where the server says to go (the name step, or
 * `returnTo`), so the next page loads with the new session.
 */
export function PasswordSignInForm({
  returnTo,
  prompt,
  initialAccount = "",
  onEmailCode,
}: {
  returnTo?: string | undefined;
  /** `"login"` when the page was asked to sign the person in afresh; the reset page keeps it. */
  prompt?: "login" | undefined;
  /** What the account field starts with. */
  initialAccount?: string | undefined;
  /** Takes someone to the code sign-in for an email. */
  onEmailCode: () => void;
}) {
  const submit = useServerFn(signInWithAccountPassword);
  const [account, setAccount] = useState(initialAccount);
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();

  // Typing again clears what the last attempt said.
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setProblem(null);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await guard(async () => {
      // The server judges them again; asking here first only spares a round trip.
      if (!account.trim() || !password) return setProblem("invalid_credentials");
      setProblem(null);
      try {
        const result = await submit({ data: { account, password, returnTo } });
        if (result.ok) {
          // Stay busy through the navigation: the page is replaced, not returned to.
          window.location.assign(result.next);
          return STAY_PENDING;
        }
        setProblem(result.problem);
      } catch {
        setProblem("failed");
      }
    });
  }

  return (
    <form noValidate onSubmit={onSubmit}>
      <div className="flex flex-col gap-5">
        <Input
          size="lg"
          placeholder={m.login_account_placeholder()}
          name="account"
          autoComplete="username"
          autoFocus
          value={account}
          onChange={edit(setAccount)}
          isInvalid={problem === "invalid_credentials"}
        />
        <Input
          size="lg"
          placeholder={m.login_password_placeholder()}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={edit(setPassword)}
          isInvalid={problem === "invalid_credentials"}
        />
        {problem ? (
          <HintText isInvalid role="alert" className="text-md">
            {problemText[problem]()}
          </HintText>
        ) : null}
      </div>
      <Button
        type="submit"
        size="lg"
        className="mt-8 w-full"
        isLoading={submitting}
        showTextWhileLoading
      >
        {m.login_submit()}
      </Button>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* lg is the link size whose text matches the row's text-md. */}
        <Link
          to="/login/reset-password"
          search={{ returnTo, prompt }}
          className="text-md font-semibold text-brand-secondary hover:text-brand-secondary_hover"
        >
          {m.login_forgot_password()}
        </Link>
        <Button color="link-gray" size="lg" noTextPadding onPress={onEmailCode}>
          {m.login_email_code_link()}
        </Button>
      </div>
    </form>
  );
}
