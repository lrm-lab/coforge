import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import type { Key } from "react-aria-components";
import { useServerFn } from "@tanstack/react-start";

import { Tab, TabList, TabPanel, Tabs } from "#src/components/application/tabs/tabs";
import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
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

export function PasswordResetForm({
  returnTo,
  prompt,
}: {
  returnTo?: string | undefined;
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
  const formRef = useRef<HTMLFormElement>(null);
  const [formProblem, setFormProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: { destination: "", code: "", password: "", again: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const parsed = parseCodeDestination(value.destination);
      if (!parsed) return;
      await guard(async () => {
        setFormProblem(null);
        try {
          const result = await submit({
            data: { destination: value.destination, code: value.code, password: value.password },
          });
          if (result.ok) {
            const passwordUpdated: PasswordUpdated = {
              destination: parsed.kind === "email" ? parsed.email : parsed.phone,
            };
            await navigate({
              to: "/login",
              search: { returnTo, prompt },
              state: { passwordUpdated },
            });
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
    setFormProblem(null);
    if (next === "invalid_destination") {
      setFieldServerError(form, "destination", problemText.invalid_destination(), formRef.current);
    } else if (next === "invalid_code") {
      setFieldServerError(form, "code", problemText.invalid_code(), formRef.current);
    } else if (next === "invalid_password" || next === "password_refused") {
      setFieldServerError(form, "password", problemText[next](), formRef.current);
    } else if (next === "password_mismatch") {
      setFieldServerError(form, "again", problemText.password_mismatch(), formRef.current);
    } else {
      setFormProblem(next);
    }
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
              <ResetCodeRow
                destination={destination}
                requestCode={(typed) => requestCode({ data: { destination: typed } })}
                reportProblem={reportProblem}
                onCodeEdit={() => setFormProblem(null)}
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
          <form.AppField
            name="password"
            validators={{
              onSubmit: ({ value }) =>
                isNewPassword(value) ? undefined : problemText.invalid_password(),
            }}
          >
            {(field) => (
              <field.Input
                size="lg"
                placeholder={m.login_reset_password_placeholder()}
                type="password"
                autoComplete="new-password"
                onChange={() => setFormProblem(null)}
              />
            )}
          </form.AppField>
          <form.AppField
            name="again"
            validators={{
              onSubmit: ({ value, fieldApi }) =>
                value === fieldApi.form.getFieldValue("password")
                  ? undefined
                  : problemText.password_mismatch(),
            }}
          >
            {(field) => (
              <field.Input
                size="lg"
                placeholder={m.login_reset_again_placeholder()}
                type="password"
                autoComplete="new-password"
                onChange={() => setFormProblem(null)}
              />
            )}
          </form.AppField>
          {formProblem ? (
            <HintText isInvalid role="alert" className="text-md">
              {problemText[formProblem]()}
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
    </form.AppForm>
  );
}

function ResetCodeRow({
  destination,
  requestCode,
  reportProblem,
  renderField,
}: {
  destination: string;
  requestCode: (typed: string) => Promise<{ ok: true } | { ok: false; problem: Problem }>;
  reportProblem: (problem: Problem | null) => void;
  onCodeEdit: () => void;
  renderField: (codeSending: ReturnType<typeof useCodeSending<Problem>>) => React.ReactNode;
}) {
  const codeSending = useCodeSending<Problem>({
    destination,
    request: requestCode,
    setProblem: reportProblem,
  });
  return <>{renderField(codeSending)}</>;
}
