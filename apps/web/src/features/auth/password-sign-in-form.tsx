import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { useAppForm } from "#src/components/ui/form";
import { STAY_PENDING, useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { useLoginArt } from "./login-art-state";
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

export function PasswordSignInForm({
  returnTo,
  prompt,
  initialAccount = "",
  onEmailCode,
}: {
  returnTo?: string | undefined;
  prompt?: "login" | undefined;
  initialAccount?: string | undefined;
  onEmailCode: () => void;
}) {
  const submit = useServerFn(signInWithAccountPassword);
  const formRef = useRef<HTMLFormElement>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, guard] = useSubmitGuard();
  const art = useLoginArt();

  const form = useAppForm({
    defaultValues: { account: initialAccount, password: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      await guard(async () => {
        if (!value.account.trim() || !value.password) {
          setProblem("invalid_credentials");
          scheduleFocusInvalidField(
            formRef.current,
            !value.account.trim() ? "account" : "password",
          );
          return;
        }
        setProblem(null);
        try {
          const result = await submit({
            data: { account: value.account, password: value.password, returnTo },
          });
          if (result.ok) {
            await art.welcome(result.welcomed ? "back" : "joined");
            window.location.assign(result.next);
            return STAY_PENDING;
          }
          setProblem(result.problem);
          if (result.problem === "invalid_credentials") {
            scheduleFocusInvalidField(formRef.current, "account");
          }
        } catch {
          setProblem("failed");
        }
      });
    },
  });

  const credentialsInvalid = problem === "invalid_credentials";

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
          <form.AppField name="account">
            {(field) => (
              <Input
                size="lg"
                placeholder={m.login_account_placeholder()}
                name={field.name}
                autoComplete="username"
                value={field.state.value}
                onChange={(next) => {
                  field.handleChange(next);
                  setProblem(null);
                }}
                onBlur={field.handleBlur}
                isInvalid={credentialsInvalid}
              />
            )}
          </form.AppField>
          <form.AppField name="password">
            {(field) => (
              <Input
                size="lg"
                placeholder={m.login_password_placeholder()}
                name={field.name}
                type="password"
                autoComplete="current-password"
                value={field.state.value}
                onChange={(next) => {
                  field.handleChange(next);
                  setProblem(null);
                  art.lookAway(next.length > 0);
                }}
                onBlur={field.handleBlur}
                onFocusChange={(focused) => art.lookAway(focused && field.state.value.length > 0)}
                isInvalid={credentialsInvalid}
              />
            )}
          </form.AppField>
          {problem ? (
            <HintText isInvalid role="alert" className="text-md">
              {problemText[problem]()}
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
        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Link
            to="/login/reset-password"
            search={{ returnTo, prompt }}
            className="text-md font-semibold text-(--login-brand) hover:text-(--login-brand-hover)"
          >
            {m.login_forgot_password()}
          </Link>
          <Button color="link-gray" size="lg" noTextPadding onPress={onEmailCode}>
            {m.login_email_code_link()}
          </Button>
        </div>
      </form>
    </form.AppForm>
  );
}
