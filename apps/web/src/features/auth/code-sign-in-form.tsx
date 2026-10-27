import { useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import { isSignInCode, parseCodeDestination } from "./code-destination";
import { CodeInput, codeProblemText, SendCodeRow } from "./send-code-row";
import { requestSignInCode, signInWithCode } from "./sign-in-code.functions";
import { useCodeSending } from "./use-code-sending";

type Problem = keyof typeof problemText;

const problemText = { ...codeProblemText, failed: () => m.login_failed() };

/**
 * Sign-in with a code sent to a phone number or an email, which also makes the account of a
 * destination nobody has signed in with. A refusal stays under the form; success is a full
 * navigation to where the server says to go, as for the password.
 */
export function CodeSignInForm({
  returnTo,
  initialDestination = "",
}: {
  returnTo?: string | undefined;
  /** What the destination field starts with. */
  initialDestination?: string | undefined;
}) {
  const send = useServerFn(requestSignInCode);
  const submit = useServerFn(signInWithCode);
  const [destination, setDestination] = useState(initialDestination);
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();
  const codeSending = useCodeSending({
    destination,
    request: (typed) => send({ data: { destination: typed } }),
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
      if (!parseCodeDestination(destination)) return setProblem("invalid_destination");
      if (!isSignInCode(code.trim())) return setProblem("invalid_code");
      setProblem(null);
      try {
        const result = await submit({ data: { destination, code, returnTo } });
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
          label={m.login_destination_label()}
          name="destination"
          autoComplete="username"
          autoFocus
          value={destination}
          onChange={edit(setDestination)}
          isInvalid={problem === "invalid_destination"}
        />
        <SendCodeRow codeSending={codeSending}>
          <CodeInput
            className="min-w-0 flex-1"
            value={code}
            onChange={edit(setCode)}
            isInvalid={problem === "invalid_code"}
          />
        </SendCodeRow>
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
    </form>
  );
}
