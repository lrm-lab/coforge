import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { setFieldServerError, useAppForm, visibleFieldError } from "#src/components/ui/form";
import { OptionCard, OptionCardGroup } from "#src/components/ui/option-card";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import {
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
} from "#src/components/ui/unsaved-changes-dialog";
import { useAppToast } from "#src/components/ui/toast";
import {
  requestAccountPasswordCode,
  setAccountPasswordFn,
} from "#src/features/auth/account-password.functions";
import { isNewPassword } from "#src/features/auth/new-password";
import { CodeInput, SendCodeRow } from "#src/features/auth/send-code-row";
import { isSignInCode } from "#src/features/auth/code-destination";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { scheduleFocusInvalidField } from "#src/lib/form-field-error";
import { m } from "#src/paraglide/messages";

import {
  BindForm,
  CodeSendingBridge,
  ProblemLine,
  ReportFormState,
} from "./account-password-bind-form";
import {
  accountPasswordProblemText,
  canSavePassword,
  confirmPasswordProblem,
  defaultContact,
  githubBindPath,
  passwordContacts,
  passwordStart,
  type AccountPasswordProblem,
  type BindArrival,
  type PasswordContacts,
} from "./account-password-logic";

type Profile = Parameters<typeof passwordContacts>[0];

export function AccountPasswordDialog({
  open,
  onOpenChange,
  profile,
  arrival,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  arrival?: BindArrival | undefined;
}) {
  const [formState, setFormState] = useState({ busy: false, dirty: false });
  const unsavedGuard = useUnsavedChangesGuard({
    overlayOpen: open,
    dirty: formState.dirty,
    close: () => onOpenChange(false),
  });
  function requestClose() {
    if (formState.busy) return;
    unsavedGuard.requestClose();
  }
  return (
    <>
      <ModalOverlay
        isOpen={open}
        isDismissable={!formState.busy}
        onOpenChange={(next) => {
          if (next) onOpenChange(true);
          else requestClose();
        }}
      >
        <Modal className="w-[calc(100vw-2rem)] max-w-md">
          <Dialog className="text-left" data-account-password-dialog>
            <DialogBody
              profile={profile}
              arrival={arrival}
              busy={formState.busy}
              onStateChange={setFormState}
              requestClose={requestClose}
              forceClose={() => onOpenChange(false)}
            />
          </Dialog>
        </Modal>
      </ModalOverlay>
      <UnsavedChangesDialog {...unsavedGuard.promptProps} />
    </>
  );
}

function DialogBody({
  profile,
  arrival,
  busy,
  onStateChange,
  requestClose,
  forceClose,
}: {
  profile: Profile;
  arrival: BindArrival | undefined;
  busy: boolean;
  onStateChange: (state: { busy: boolean; dirty: boolean }) => void;
  requestClose: () => void;
  forceClose: () => void;
}) {
  const router = useRouter();
  const [start] = useState(() => passwordStart(passwordContacts(profile), arrival));
  const [step, setStep] = useState(start.step);
  const [problem, setProblem] = useState<AccountPasswordProblem | null>(start.problem);
  const [bound, setBound] = useState<PasswordContacts>();
  const contacts = passwordContacts(profile, bound);

  useEffect(() => {
    if (step === "need_contact") onStateChange({ busy: false, dirty: false });
  }, [step, onStateChange]);

  return (
    <>
      <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6">
        <Heading slot="title" className="min-w-0 text-xl font-semibold text-primary">
          {m.settings_password_set()}
        </Heading>
        <ButtonUtility
          aria-label={m.controls_close()}
          icon={X}
          size="sm"
          color="tertiary"
          isDisabled={busy}
          onClick={requestClose}
        />
      </div>
      {step === "password" ? (
        <PasswordForm
          contacts={contacts}
          onStateChange={onStateChange}
          requestClose={requestClose}
          forceClose={forceClose}
        />
      ) : step === "bind" ? (
        <BindForm
          onStateChange={onStateChange}
          requestClose={requestClose}
          onBound={(next) => {
            setBound(next);
            setProblem(null);
            setStep("password");
            void router.invalidate();
          }}
          onSpent={(spent) => {
            setProblem(spent);
            setStep("need_contact");
          }}
        />
      ) : (
        <div className="flex flex-col gap-5 px-6 pt-5 pb-6">
          <p className="text-md text-secondary">{m.settings_password_need_contact()}</p>
          {problem ? <ProblemLine problem={problem} /> : null}
          <DialogActions>
            <DialogCancel onPress={requestClose}>{m.controls_cancel()}</DialogCancel>
            <DialogAction
              onPress={() => window.location.assign(githubBindPath(window.location.pathname))}
            >
              {m.settings_password_verify_github()}
            </DialogAction>
          </DialogActions>
        </div>
      )}
    </>
  );
}

function PasswordForm({
  contacts,
  onStateChange,
  requestClose,
  forceClose,
}: {
  contacts: PasswordContacts;
  onStateChange: (state: { busy: boolean; dirty: boolean }) => void;
  requestClose: () => void;
  forceClose: () => void;
}) {
  const size = useDialogControlSize();
  const formRef = useRef<HTMLFormElement>(null);
  const requestCode = useServerFn(requestAccountPasswordCode);
  const setPassword = useServerFn(setAccountPasswordFn);
  const toast = useAppToast();
  const [formProblem, setFormProblem] = useState<AccountPasswordProblem | null>(null);
  const [saving, guard] = useSubmitGuard();

  const form = useAppForm({
    defaultValues: {
      contact: defaultContact(contacts),
      code: "",
      password: "",
      confirmPassword: "",
    },
    onSubmitInvalid: () => scheduleFocusInvalidField(formRef.current),
    onSubmit: async ({ value }) => {
      if (!canSavePassword(value.code, value.password, value.confirmPassword)) return;
      await guard(async () => {
        setFormProblem(null);
        try {
          const result = await setPassword({
            data: {
              contact: value.contact,
              code: value.code.trim(),
              password: value.password,
              confirmPassword: value.confirmPassword,
            },
          });
          if (!result.ok) {
            reportProblem(result.problem);
            return;
          }
          if (result.verified) toast.success(m.settings_password_updated());
          else toast.success(m.settings_password_updated_unverified());
          forceClose();
        } catch {
          setFormProblem("failed");
        }
      });
    },
  });

  function clearConfirmPasswordError() {
    form.setFieldMeta("confirmPassword", (prev) => {
      if (!prev.errorMap.onBlur && !prev.errorMap.onSubmit) return prev;
      return {
        ...prev,
        errorMap: { ...prev.errorMap, onBlur: undefined, onSubmit: undefined },
      };
    });
  }

  function reportProblem(next: AccountPasswordProblem | null) {
    if (!next) {
      setFormProblem(null);
      return;
    }
    if (next === "invalid_code" || next === "invalid_input" || next === "refused") {
      setFormProblem(null);
      setFieldServerError(form, "code", accountPasswordProblemText(next), formRef.current);
      return;
    }
    if (next === "password_refused") {
      setFormProblem(null);
      setFieldServerError(form, "password", accountPasswordProblemText(next), formRef.current);
      return;
    }
    if (next === "password_mismatch") {
      setFormProblem(null);
      setFieldServerError(
        form,
        "confirmPassword",
        accountPasswordProblemText(next),
        formRef.current,
      );
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
            state.values.code.trim() !== "" ||
            state.values.password !== "" ||
            state.values.confirmPassword !== ""
          }
        >
          {(dirty) => <ReportFormState busy={saving} dirty={dirty} onStateChange={onStateChange} />}
        </form.Subscribe>
        <form.AppField name="contact">
          {(field) => {
            const destination =
              (field.state.value === "email" ? contacts.email : contacts.phone) ?? "";
            return contacts.email && contacts.phone ? (
              <OptionCardGroup
                aria-label={m.login_code_label()}
                value={field.state.value}
                onChange={(value) => field.handleChange(value === "phone" ? "phone" : "email")}
                isDisabled={saving}
              >
                <OptionCard value="email" label={m.settings_email()} description={contacts.email} />
                <OptionCard value="phone" label={m.settings_phone()} description={contacts.phone} />
              </OptionCardGroup>
            ) : (
              <p className="min-w-0 text-md wrap-anywhere text-secondary">
                {m.settings_password_code_goes_to({ destination })}
              </p>
            );
          }}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.contact}>
          {(contact) => {
            const destination = (contact === "email" ? contacts.email : contacts.phone) ?? "";
            return (
              <CodeSendingBridge
                destination={destination}
                request={() => requestCode({ data: { contact } })}
                setProblem={reportProblem}
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
            );
          }}
        </form.Subscribe>
        <form.AppField
          name="password"
          validators={{
            onSubmit: ({ value }) =>
              isNewPassword(value) ? undefined : m.login_password_invalid(),
          }}
        >
          {(field) => (
            <field.Input
              size={size}
              label={m.settings_password_new()}
              placeholder={m.login_reset_password_placeholder()}
              type="password"
              autoComplete="new-password"
              onChange={() => {
                setFormProblem(null);
                clearConfirmPasswordError();
              }}
              onBlur={() => {
                if (form.getFieldValue("confirmPassword") !== "") {
                  form.setFieldMeta("confirmPassword", (prev) => ({ ...prev, isTouched: true }));
                  void form.validateField("confirmPassword", "blur");
                }
              }}
            />
          )}
        </form.AppField>
        <form.AppField
          name="confirmPassword"
          validators={{
            onBlur: ({ value, fieldApi }) => {
              const problem = confirmPasswordProblem(
                fieldApi.form.getFieldValue("password"),
                value,
                "blur",
              );
              return problem ? accountPasswordProblemText(problem) : undefined;
            },
            onSubmit: ({ value, fieldApi }) => {
              const problem = confirmPasswordProblem(
                fieldApi.form.getFieldValue("password"),
                value,
                "submit",
              );
              return problem ? accountPasswordProblemText(problem) : undefined;
            },
          }}
        >
          {(field) => (
            <field.Input
              size={size}
              label={m.settings_password_confirm()}
              placeholder={m.login_reset_again_placeholder()}
              type="password"
              autoComplete="new-password"
              onChange={() => {
                setFormProblem(null);
                clearConfirmPasswordError();
              }}
            />
          )}
        </form.AppField>
        {formProblem ? <ProblemLine problem={formProblem} /> : null}
        <DialogActions>
          <DialogCancel isDisabled={saving} onPress={requestClose}>
            {m.controls_cancel()}
          </DialogCancel>
          <DialogAction type="submit" isDisabled={saving} isLoading={saving} showTextWhileLoading>
            {m.settings_password_save()}
          </DialogAction>
        </DialogActions>
      </form>
    </form.AppForm>
  );
}
