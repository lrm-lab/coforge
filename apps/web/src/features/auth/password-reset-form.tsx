import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { isSignInCode, parseCodeDestination } from "./code-destination";
import { isNewPassword } from "./new-password";
import { requestPasswordResetCode, resetPassword } from "./password-reset.functions";
import type { PasswordUpdated } from "./password-updated";
import { CodeInput, codeProblemText, SendCodeRow } from "./send-code-row";
import { useCodeSending } from "./use-code-sending";

type Problem = keyof typeof problemText;

const problemText = {
  ...codeProblemText,
  invalid_password: () => m.login_password_invalid(),
  password_refused: () => m.login_password_refused(),
  failed: () => m.login_reset_failed(),
};

/**
 * Setting a new password with a code sent to a phone number or an email: the destination first,
 * then, once a code was asked for, the code and the new password. Asking for a code looks the same
 * whether or not an account has the destination. A refusal stays under the form; success goes back
 * to the sign-in page (keeping `returnTo` and `prompt`) and says so there, signing nobody in.
 */
export function PasswordResetForm({
  returnTo,
  prompt,
}: {
  returnTo?: string | undefined;
  /** `"login"` when the sign-in page was asked to sign the person in afresh: the way back asks too. */
  prompt?: "login" | undefined;
}) {
  const requestCode = useServerFn(requestPasswordResetCode);
  const submit = useServerFn(resetPassword);
  const navigate = useNavigate();
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();
  const codeSending = useCodeSending({
    destination,
    request: (typed) => requestCode({ data: { destination: typed } }),
    setProblem,
    onSent: () => setAsked(true),
  });

  // Typing again clears what the last attempt said.
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setProblem(null);
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await guard(async () => {
      const parsed = parseCodeDestination(destination);
      if (!parsed) return setProblem("invalid_destination");
      if (!isSignInCode(code.trim())) return setProblem("invalid_code");
      if (!isNewPassword(password)) return setProblem("invalid_password");
      setProblem(null);
      try {
        const result = await submit({ data: { destination, code, password } });
        if (result.ok) {
          const passwordUpdated: PasswordUpdated = {
            destination: parsed.kind === "email" ? parsed.email : parsed.phone,
          };
          // Stay busy through the navigation: the page is replaced, not returned to.
          await navigate({
            to: "/login",
            search: { returnTo, prompt },
            state: { passwordUpdated },
          });
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
        <SendCodeRow codeSending={codeSending}>
          <Input
            label={m.login_destination_label()}
            name="destination"
            autoComplete="username"
            autoFocus
            className="min-w-0 flex-1"
            value={destination}
            onChange={edit(setDestination)}
            isInvalid={problem === "invalid_destination"}
          />
        </SendCodeRow>
        {asked ? (
          <>
            <CodeInput
              value={code}
              onChange={edit(setCode)}
              isInvalid={problem === "invalid_code"}
            />
            <Input
              label={m.login_reset_new_password_label()}
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={edit(setPassword)}
              isInvalid={problem === "invalid_password" || problem === "password_refused"}
            />
          </>
        ) : null}
        {problem ? (
          <HintText isInvalid role="alert" className="text-md">
            {problemText[problem]()}
          </HintText>
        ) : null}
      </div>
      {asked ? (
        <Button
          type="submit"
          size="lg"
          className="mt-6 w-full"
          isLoading={submitting}
          showTextWhileLoading
        >
          {m.login_reset_submit()}
        </Button>
      ) : null}
      <Link
        to="/login"
        search={{ returnTo, prompt }}
        className="mt-6 block text-center text-md font-semibold text-brand-secondary hover:text-brand-secondary_hover"
      >
        {m.login_reset_back()}
      </Link>
    </form>
  );
}
