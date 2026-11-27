import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";

import { HintText } from "#src/components/base/input/hint-text";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { CodeInput, SendCodeRow } from "#src/features/auth/send-code-row";
import { useCodeSending } from "#src/features/auth/use-code-sending";
import {
  bindAccountContactFn,
  requestContactBindCodeFn,
} from "#src/features/auth/contact-binding.functions";
import { isSignInCode, parseCodeDestination } from "#src/features/auth/code-destination";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

import {
  accountPasswordProblemText,
  type AccountPasswordProblem,
  type PasswordContacts,
} from "./account-password-logic";

export function ProblemLine({ problem }: { problem: AccountPasswordProblem }) {
  return (
    <HintText isInvalid role="alert" className="text-sm">
      {accountPasswordProblemText(problem)}
    </HintText>
  );
}

export function ReportFormState({
  busy,
  dirty,
  onStateChange,
}: {
  busy: boolean;
  dirty: boolean;
  onStateChange: (state: { busy: boolean; dirty: boolean }) => void;
}) {
  useEffect(() => {
    onStateChange({ busy, dirty });
  }, [busy, dirty, onStateChange]);
  return null;
}

export function CodeSendingBridge({
  destination,
  request,
  setProblem,
  renderField,
}: {
  destination: string;
  request: (
    typed: string,
  ) => Promise<{ ok: true } | { ok: false; problem: AccountPasswordProblem }>;
  setProblem: (problem: AccountPasswordProblem | null) => void;
  renderField: (
    codeSending: ReturnType<typeof useCodeSending<AccountPasswordProblem>>,
  ) => ReactNode;
}) {
  const codeSending = useCodeSending<AccountPasswordProblem>({
    destination,
    request,
    setProblem,
  });
  return <>{renderField(codeSending)}</>;
}

export function BindForm({
  onStateChange,
  requestClose,
  onBound,
  onSpent,
}: {
  onStateChange: (state: { busy: boolean; dirty: boolean }) => void;
  requestClose: () => void;
  onBound: (contacts: PasswordContacts) => void;
  onSpent: (problem: AccountPasswordProblem) => void;
}) {
  const size = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const requestCode = useServerFn(requestContactBindCodeFn);
  const bind = useServerFn(bindAccountContactFn);
  const [formProblem, setFormProblem] = useState<AccountPasswordProblem | null>(null);
  const [saving, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: { destination: "", code: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      const parsed = parseCodeDestination(value.destination);
      if (!parsed || !isSignInCode(value.code.trim())) return;
      await guard(async () => {
        setFormProblem(null);
        try {
          const result = await bind({
            data: { destination: value.destination, code: value.code.trim() },
          });
          if (result.ok) {
            onBound(
              parsed.kind === "email" && result.email
                ? { email: result.email }
                : parsed.kind === "phone" && result.phone
                  ? { phone: result.phone }
                  : {},
            );
            return;
          }
          onSpent(result.problem === "invalid_bind_token" ? "invalid_bind_token" : "bind_failed");
        } catch {
          onSpent("bind_failed");
        }
      });
    },
  });

  function reportProblem(next: AccountPasswordProblem | null) {
    if (!next) {
      setFormProblem(null);
      return;
    }
    if (next === "invalid_destination") {
      setFormProblem(null);
      setFieldServerError(form, "destination", accountPasswordProblemText(next), formRef.current);
      return;
    }
    if (next === "invalid_code") {
      setFormProblem(null);
      setFieldServerError(form, "code", accountPasswordProblemText(next), formRef.current);
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
        className="flex flex-col gap-5 px-6 pt-5 pb-6"
      >
        <form.Subscribe
          selector={(state) =>
            state.values.destination.trim() !== "" || state.values.code.trim() !== ""
          }
        >
          {(dirty) => <ReportFormState busy={saving} dirty={dirty} onStateChange={onStateChange} />}
        </form.Subscribe>
        <form.AppField
          name="destination"
          validators={{
            onSubmit: ({ value }) =>
              parseCodeDestination(value)
                ? undefined
                : accountPasswordProblemText("invalid_destination"),
          }}
        >
          {(field) => (
            <field.Input
              size={size}
              label={m.settings_password_bind_destination()}
              autoComplete="off"
              onChange={() => setFormProblem(null)}
            />
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.destination}>
          {(destination) => (
            <CodeSendingBridge
              destination={destination}
              request={(typed) => requestCode({ data: { destination: typed } })}
              setProblem={(next) => {
                if (next === "invalid_bind_token") {
                  onSpent(next);
                  return;
                }
                reportProblem(next);
              }}
              renderField={(codeSending) => (
                <form.AppField
                  name="code"
                  validators={{
                    onSubmit: ({ value }) =>
                      isSignInCode(value.trim())
                        ? undefined
                        : accountPasswordProblemText("invalid_code"),
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
                        errorClassName="text-sm"
                      >
                        <CodeInput
                          size={size}
                          value={field.state.value}
                          onChange={(next) => {
                            if (field.state.meta.errorMap.onSubmit) {
                              field.setMeta((prev) => ({
                                ...prev,
                                errorMap: { ...prev.errorMap, onSubmit: undefined },
                              }));
                            }
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
        {formProblem ? <ProblemLine problem={formProblem} /> : null}
        <DialogActions>
          <DialogCancel isDisabled={saving} onPress={requestClose}>
            {m.controls_cancel()}
          </DialogCancel>
          <form.Subscribe selector={(state) => isSignInCode(state.values.code.trim())}>
            {(codeReady) => (
              <DialogAction
                type="submit"
                isDisabled={!codeReady || saving}
                isLoading={saving}
                showTextWhileLoading
              >
                {m.settings_password_bind_confirm()}
              </DialogAction>
            )}
          </form.Subscribe>
        </DialogActions>
      </form>
    </form.AppForm>
  );
}
