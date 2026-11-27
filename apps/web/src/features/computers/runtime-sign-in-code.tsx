import { useEffect, useId, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Copy01 } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
import { useDialogControlSize } from "#src/components/ui/dialog-actions";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { copyText } from "#src/lib/clipboard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";
import { submitRuntimeAuthCode } from "./runtime-auth.functions";
import { loginReducer, safeSignInUrl } from "./runtime-auth-login-state";

export function DeviceCode({
  event,
  expiresAtMs,
}: {
  event: { verificationUrl: string; userCode: string };
  expiresAtMs?: number;
}) {
  const safe = safeSignInUrl(event.verificationUrl);
  const minutes = expiresAtMs === undefined ? 0 : Math.ceil((expiresAtMs - Date.now()) / 60_000);
  return (
    <>
      <p>{m.runtime_auth_device_hint()}</p>
      {safe && (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate font-medium text-brand-secondary underline"
        >
          {safe}
        </a>
      )}
      <div className="flex items-center gap-2">
        <code className="rounded-md bg-secondary px-3 py-2 font-mono text-lg font-semibold tracking-widest text-primary">
          {event.userCode}
        </code>
        <ButtonUtility
          icon={Copy01}
          size="sm"
          color="secondary"
          tooltip={m.runtime_auth_copy_code()}
          onClick={() => void copyText(event.userCode)}
        />
      </div>
      {minutes > 0 && (
        <p className="text-tertiary">{m.runtime_auth_code_expires({ minutes: String(minutes) })}</p>
      )}
    </>
  );
}

export function CodeForm({
  computerId,
  loginId,
  rejected,
  dispatch,
}: {
  computerId: string;
  loginId: string;
  rejected: boolean;
  dispatch: (action: Parameters<typeof loginReducer>[1]) => void;
}) {
  const submit = useServerFn(submitRuntimeAuthCode);
  const controlSize = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const [sending, guard] = useSubmitGuard();
  const hintId = useId();

  const form = useAppForm({
    defaultValues: { code: "" },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current, "code"),
    onSubmit: async ({ value }) => {
      if (!value.code.trim()) return;
      await guard(async () => {
        try {
          const outcome = await submit({ data: { computerId, loginId, code: value.code } });
          if (outcome === "sent") {
            form.reset();
            dispatch({ type: "code_sent" });
          } else if (outcome === "invalid_code") {
            setFieldServerError(form, "code", m.runtime_auth_code_invalid(), formRef.current);
            dispatch({ type: "code_invalid" });
          } else {
            dispatch({ type: "ended" });
          }
        } catch {
          setFieldServerError(form, "code", m.runtime_auth_code_invalid(), formRef.current);
        }
      });
    },
  });

  useEffect(() => {
    if (rejected) {
      setFieldServerError(form, "code", m.runtime_auth_code_rejected(), formRef.current);
    }
  }, [rejected, form]);

  return (
    <form.AppForm>
      <form
        ref={formRef}
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.AppField name="code">
          {(field) => {
            const error = visibleFieldError(field.state.meta, field.form.state.submissionAttempts);
            return (
              <>
                <div className="flex items-end gap-2">
                  <Input
                    name={field.name}
                    className="min-w-0 flex-1"
                    size={controlSize}
                    label={m.runtime_auth_paste_label()}
                    aria-describedby={hintId}
                    isInvalid={Boolean(error)}
                    value={field.state.value}
                    onChange={(next) => {
                      if (field.state.meta.errorMap.onSubmit) {
                        field.setMeta((prev) => ({
                          ...prev,
                          errorMap: { ...prev.errorMap, onSubmit: undefined },
                        }));
                      }
                      field.handleChange(next);
                    }}
                    onBlur={field.handleBlur}
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <Button
                    type="submit"
                    size={controlSize}
                    color="secondary"
                    isLoading={sending}
                    isDisabled={!field.state.value.trim()}
                  >
                    {m.runtime_auth_submit()}
                  </Button>
                </div>
                <p
                  id={hintId}
                  role={error ? "alert" : undefined}
                  className={
                    error ? "mt-1.5 text-xs text-error-primary" : "mt-1.5 text-xs text-tertiary"
                  }
                >
                  {error ?? m.runtime_auth_paste_hint()}
                </p>
              </>
            );
          }}
        </form.AppField>
      </form>
    </form.AppForm>
  );
}
