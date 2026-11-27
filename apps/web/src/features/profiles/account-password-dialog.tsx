import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Input } from "#src/components/base/input/input";
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
import { CodeInput, SendCodeRow } from "#src/features/auth/send-code-row";
import { useCodeSending } from "#src/features/auth/use-code-sending";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

import { BindForm, ProblemLine } from "./account-password-bind-form";
import {
  canSavePassword,
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
  const requestCode = useServerFn(requestAccountPasswordCode);
  const setPassword = useServerFn(setAccountPasswordFn);
  const toast = useAppToast();
  const [contact, setContact] = useState(() => defaultContact(contacts));
  const [code, setCode] = useState("");
  const [password, setPasswordValue] = useState("");
  const [problem, setProblem] = useState<AccountPasswordProblem | null>(null);
  const [saving, guard] = useSubmitGuard();
  const destination = (contact === "email" ? contacts.email : contacts.phone) ?? "";
  const codeSending = useCodeSending<AccountPasswordProblem>({
    destination,
    request: () => requestCode({ data: { contact } }),
    setProblem,
  });

  useEffect(() => {
    onStateChange({ busy: saving, dirty: code.trim() !== "" || password !== "" });
  }, [saving, code, password, onStateChange]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSavePassword(code, password)) return;
    await guard(async () => {
      setProblem(null);
      try {
        const result = await setPassword({ data: { contact, code: code.trim(), password } });
        if (!result.ok) return setProblem(result.problem);
        if (result.verified) toast.success(m.settings_password_updated());
        else toast.success(m.settings_password_updated_unverified());
        forceClose();
      } catch {
        setProblem("failed");
      }
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5 px-6 pt-5 pb-6">
      {contacts.email && contacts.phone ? (
        <OptionCardGroup
          aria-label={m.login_code_label()}
          value={contact}
          onChange={(value) => setContact(value === "phone" ? "phone" : "email")}
          isDisabled={saving}
        >
          <OptionCard value="email" label={m.settings_email()} description={contacts.email} />
          <OptionCard value="phone" label={m.settings_phone()} description={contacts.phone} />
        </OptionCardGroup>
      ) : (
        <p className="min-w-0 text-md wrap-anywhere text-secondary">
          {m.settings_password_code_goes_to({ destination })}
        </p>
      )}
      <SendCodeRow codeSending={codeSending}>
        <CodeInput
          size={size}
          value={code}
          onChange={(value) => {
            setCode(value);
            setProblem(null);
          }}
          isInvalid={problem === "invalid_code" || problem === "invalid_input"}
        />
      </SendCodeRow>
      <Input
        size={size}
        label={m.settings_password_new()}
        placeholder={m.login_reset_password_placeholder()}
        name="password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(value) => {
          setPasswordValue(value);
          setProblem(null);
        }}
        isInvalid={problem === "password_refused"}
      />
      {problem ? <ProblemLine problem={problem} /> : null}
      <DialogActions>
        <DialogCancel isDisabled={saving} onPress={requestClose}>
          {m.controls_cancel()}
        </DialogCancel>
        <DialogAction
          type="submit"
          isDisabled={!canSavePassword(code, password) || saving}
          isLoading={saving}
          showTextWhileLoading
        >
          {m.settings_password_save()}
        </DialogAction>
      </DialogActions>
    </form>
  );
}
