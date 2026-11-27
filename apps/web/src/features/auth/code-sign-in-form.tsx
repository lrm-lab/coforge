import { useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { useLoginArt } from "./login-art-state";
import { isSignInCode, parseCodeDestination } from "./code-destination";
import { CodeInput, codeProblemText, SendCodeRow } from "./send-code-row";
import { requestSignInCode, signInWithCode } from "./sign-in-code.functions";
import { useCodeSending } from "./use-code-sending";

type Problem = keyof typeof problemText;

const problemText = { ...codeProblemText, failed: () => m.login_failed() };

export function CodeSignInForm({
  returnTo,
  initialDestination = "",
  kind = "phone",
}: {
  returnTo?: string | undefined;
  kind?: "phone" | "email";
  initialDestination?: string | undefined;
}) {
  const send = useServerFn(requestSignInCode);
  const submit = useServerFn(signInWithCode);
  const formRef = useRef<HTMLFormElement>(null);
  const [formProblem, setFormProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();
  const art = useLoginArt();

  const form = useAppForm({
    defaultValues: { destination: initialDestination, code: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      await guard(async () => {
        setFormProblem(null);
        try {
          const result = await submit({
            data: { destination: value.destination, code: value.code, returnTo },
          });
          if (result.ok) {
            await art.welcome(result.welcomed ? "back" : "joined");
            window.location.assign(result.next);
            return STAY_PENDING;
          }
          reportProblem(result.problem);
        } catch {
          setFormProblem("failed");
        }
      });
    },
  });

  function reportProblem(next: Problem | null) {
    if (!next) {
      setFormProblem(null);
      return;
    }
    if (next === "invalid_destination") {
      setFormProblem(null);
      setFieldServerError(form, "destination", problemText.invalid_destination(), formRef.current);
      return;
    }
    if (next === "invalid_code") {
      setFormProblem(null);
      setFieldServerError(form, "code", problemText.invalid_code(), formRef.current);
      return;
    }
    setFormProblem(next);
  }

  return (
    <form.AppForm>
      <form
        ref={formRef}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div className="flex flex-col gap-5">
          <form.AppField
            name="destination"
            validators={{
              onSubmit: ({ value }) =>
                parseCodeDestination(value) ? undefined : problemText.invalid_destination(),
            }}
          >
            {(field) => (
              <field.Input
                size="lg"
                placeholder={
                  kind === "email" ? m.login_email_placeholder() : m.login_phone_placeholder()
                }
                autoComplete="username"
                onChange={() => setFormProblem(null)}
              />
            )}
          </form.AppField>
          <form.Subscribe selector={(state) => state.values.destination}>
            {(destination) => (
              <CodeSignInCodeRow
                destination={destination}
                send={(typed) => send({ data: { destination: typed } })}
                reportProblem={reportProblem}
                renderField={(codeSending) => (
                  <form.AppField
                    name="code"
                    validators={{
                      onSubmit: ({ value }) =>
                        isSignInCode(value.trim()) ? undefined : problemText.invalid_code(),
                    }}
                  >
                    {(field) => {
                      const codeError = visibleFieldError(
                        field.state.meta,
                        field.form.state.submissionAttempts,
                      );
                      return (
                        <SendCodeRow
                          codeSending={codeSending}
                          error={codeError}
                          errorClassName="text-md"
                        >
                          <CodeInput
                            size="lg"
                            value={field.state.value}
                            onChange={(next) => {
                              field.handleChange(next);
                              setFormProblem(null);
                            }}
                            isInvalid={Boolean(codeError)}
                          />
                        </SendCodeRow>
                      );
                    }}
                  </form.AppField>
                )}
              />
            )}
          </form.Subscribe>
          {formProblem ? (
            <HintText isInvalid role="alert" className="text-md">
              {problemText[formProblem]()}
            </HintText>
          ) : null}
        </div>
        <Button
          type="submit"
          size="lg"
          className="mt-8 h-12 w-full"
          isLoading={submitting}
          showTextWhileLoading
        >
          {m.login_submit()}
        </Button>
      </form>
    </form.AppForm>
  );
}

function CodeSignInCodeRow({
  destination,
  send,
  reportProblem,
  renderField,
}: {
  destination: string;
  send: (typed: string) => Promise<{ ok: true } | { ok: false; problem: Problem }>;
  reportProblem: (problem: Problem | null) => void;
  renderField: (codeSending: ReturnType<typeof useCodeSending<Problem>>) => ReactNode;
}) {
  const codeSending = useCodeSending<Problem>({
    destination,
    request: send,
    setProblem: reportProblem,
  });
  return <>{renderField(codeSending)}</>;
}
