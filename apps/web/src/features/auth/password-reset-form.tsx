import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import type { Key } from "react-aria-components";
import { useServerFn } from "@tanstack/react-start";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
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
  password_mismatch: () => m.login_reset_mismatch(),
  password_refused: () => m.login_password_refused(),
  failed: () => m.login_reset_failed(),
};

/**
 * Setting a new password with a code sent to a phone number or an email, one tab each (jing,
 * 11-12): the destination, the code with the button that sends it, the new password and the same
 * again. Asking for a code looks the same whether or not an account has the destination. A refusal
 * stays under the form; success goes back to the sign-in page (keeping `returnTo` and `prompt`) and
 * says so there, signing nobody in.
 */
export function PasswordResetForm({
  returnTo,
  prompt,
}: {
  returnTo?: string | undefined;
  /** `"login"` when the sign-in page was asked to sign the person in afresh: the way back asks too. */
  prompt?: "login" | undefined;
}) {
  const [tab, setTab] = useState<Key>("phone");
  return (
    <div>
      <Tabs selectedKey={tab} onSelectionChange={setTab}>
        <TabList
          aria-label={m.login_reset_title()}
          type="underline"
          size="md"
          className="w-max gap-10"
        >
          <Tab id="phone" className="px-0 *:px-0">
            {m.login_reset_tab_phone()}
          </Tab>
          <Tab id="email" className="px-0 *:px-0">
            {m.login_reset_tab_email()}
          </Tab>
        </TabList>
        {(["phone", "email"] as const).map((kind) => (
          <TabPanel key={kind} id={kind} className="pt-8">
            <ResetFields kind={kind} returnTo={returnTo} prompt={prompt} />
          </TabPanel>
        ))}
      </Tabs>
      <Link
        to="/login"
        search={{ returnTo, prompt }}
        className="mx-auto mt-4 block w-max text-md font-semibold text-tertiary hover:text-tertiary_hover"
      >
        {m.login_reset_back()}
      </Link>
    </div>
  );
}

/** One tab's form: its destination is worded for a phone or an email, and either is accepted. */
function ResetFields({
  kind,
  returnTo,
  prompt,
}: {
  kind: "phone" | "email";
  returnTo?: string | undefined;
  prompt?: "login" | undefined;
}) {
  const requestCode = useServerFn(requestPasswordResetCode);
  const submit = useServerFn(resetPassword);
  const navigate = useNavigate();
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();
  const codeSending = useCodeSending({
    destination,
    request: (typed) => requestCode({ data: { destination: typed } }),
    setProblem,
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
      if (again !== password) return setProblem("password_mismatch");
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
      <div className="flex flex-col gap-5">
        <Input
          size="lg"
          placeholder={kind === "email" ? m.login_email_placeholder() : m.login_phone_placeholder()}
          name="destination"
          autoComplete="username"
          value={destination}
          onChange={edit(setDestination)}
          isInvalid={problem === "invalid_destination"}
        />
        <SendCodeRow codeSending={codeSending} size="lg">
          <CodeInput
            size="lg"
            hideLabel
            className="min-w-0 flex-1"
            value={code}
            onChange={edit(setCode)}
            isInvalid={problem === "invalid_code"}
          />
        </SendCodeRow>
        <Input
          size="lg"
          placeholder={m.login_reset_password_placeholder()}
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={edit(setPassword)}
          isInvalid={problem === "invalid_password" || problem === "password_refused"}
        />
        <Input
          size="lg"
          placeholder={m.login_reset_again_placeholder()}
          name="password-again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={edit(setAgain)}
          isInvalid={problem === "password_mismatch"}
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
        className="mt-10 h-12 w-full"
        isLoading={submitting}
        showTextWhileLoading
      >
        {m.login_reset_submit()}
      </Button>
    </form>
  );
}
