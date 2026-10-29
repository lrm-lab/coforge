import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { signInWithEmailPassword } from "./sign-in.functions";

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
 * Sign-in with an email and a password, checked by Authing on the server. A refusal stays under
 * the form; success is a full navigation to where the server says to go (the name step, or
 * `returnTo`), so the next page loads with the new session.
 */
export function PasswordSignInForm({
  returnTo,
  prompt,
  initialEmail = "",
  onCreateAccount,
}: {
  returnTo?: string | undefined;
  /** `"login"` when the page was asked to sign the person in afresh; the reset page keeps it. */
  prompt?: "login" | undefined;
  /** What the email field starts with. */
  initialEmail?: string | undefined;
  /** Takes someone without an account to the code sign-in, which creates one. */
  onCreateAccount: () => void;
}) {
  const submit = useServerFn(signInWithEmailPassword);
  const [email, setEmail] = useState(initialEmail);
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
      if (!email.trim() || !password) return setProblem("invalid_credentials");
      setProblem(null);
      try {
        const result = await submit({ data: { email, password, returnTo } });
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
      <div className="flex flex-col gap-6">
        <Input
          label={m.login_email_label()}
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={edit(setEmail)}
          isInvalid={problem === "invalid_credentials"}
        />
        <Input
          label={m.login_password_label()}
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={edit(setPassword)}
          isInvalid={problem === "invalid_credentials"}
        />
        <Link
          to="/login/reset-password"
          search={{ returnTo, prompt }}
          className="-mt-3 self-start text-md font-semibold text-brand-secondary hover:text-brand-secondary_hover"
        >
          {m.login_forgot_password()}
        </Link>
        {problem ? (
          <HintText isInvalid role="alert" className="text-md">
            {problemText[problem]()}
          </HintText>
        ) : null}
      </div>
      <Button
        type="submit"
        size="lg"
        className="mt-6 w-full"
        isLoading={submitting}
        showTextWhileLoading
      >
        {m.login_submit()}
      </Button>
      <p className="mt-6 text-center text-md text-tertiary">
        {m.login_no_account()} {/* lg is the link size whose text matches the line's text-md. */}
        <Button color="link-color" size="lg" noTextPadding onPress={onCreateAccount}>
          {m.login_create_account()}
        </Button>
      </p>
    </form>
  );
}
