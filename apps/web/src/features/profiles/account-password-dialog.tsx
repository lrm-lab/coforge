import { useState, type FormEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { XClose as X } from "@untitledui/icons";
import { Heading } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
import { RadioButton, RadioGroup } from "#src/components/base/radio-buttons/radio-buttons";
import {
  DialogAction,
  DialogActions,
  DialogCancel,
  useDialogControlSize,
} from "#src/components/ui/dialog-actions";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { useAppToast } from "#src/components/ui/toast";
import {
  requestAccountPasswordCode,
  setAccountPasswordFn,
} from "#src/features/auth/account-password.functions";
import { CodeInput, SendCodeRow } from "#src/features/auth/send-code-row";
import { useCodeSending } from "#src/features/auth/use-code-sending";
import {
  bindAccountContactFn,
  requestContactBindCodeFn,
} from "#src/features/auth/contact-binding.functions";
import { isSignInCode, parseCodeDestination } from "#src/features/auth/code-destination";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";

import {
  accountPasswordProblemText,
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
  return (
    <ModalOverlay isOpen={open} onOpenChange={onOpenChange}>
      <Modal className="w-[calc(100vw-2rem)] max-w-md">
        <Dialog className="text-left" data-account-password-dialog>
          {({ close }) => <DialogBody profile={profile} arrival={arrival} close={close} />}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function DialogBody({
  profile,
  arrival,
  close,
}: {
  profile: Profile;
  arrival: BindArrival | undefined;
  close: () => void;
}) {
  const router = useRouter();
  const [start] = useState(() => passwordStart(passwordContacts(profile), arrival));
  const [step, setStep] = useState(start.step);
  const [problem, setProblem] = useState<AccountPasswordProblem | null>(start.problem);
  const [bound, setBound] = useState<PasswordContacts>();
  const contacts = passwordContacts(profile, bound);

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
          onClick={close}
        />
      </div>
      {step === "password" ? (
        <PasswordForm contacts={contacts} close={close} />
      ) : step === "bind" ? (
        <BindForm
          close={close}
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
            <DialogCancel onPress={close}>{m.controls_cancel()}</DialogCancel>
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

function ProblemLine({ problem }: { problem: AccountPasswordProblem }) {
  return (
    <HintText isInvalid role="alert" className="text-sm">
      {accountPasswordProblemText(problem)}
    </HintText>
  );
}

function PasswordForm({ contacts, close }: { contacts: PasswordContacts; close: () => void }) {
  const size = useDialogControlSize();
  const requestCode = useServerFn(requestAccountPasswordCode);
  const setPassword = useServerFn(setAccountPasswordFn);
  const toast = useAppToast();
  const [contact, setContact] = useState(defaultContact(contacts));
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
        close();
      } catch {
        setProblem("failed");
      }
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5 px-6 pt-5 pb-6">
      {contacts.email && contacts.phone ? (
        <RadioGroup
          aria-label={m.login_code_label()}
          value={contact}
          onChange={(value) => setContact(value === "phone" ? "phone" : "email")}
          isDisabled={saving}
          className="gap-3"
        >
          <RadioButton
            value="email"
            label={m.settings_email()}
            hint={<span className="wrap-anywhere">{contacts.email}</span>}
          />
          <RadioButton
            value="phone"
            label={m.settings_phone()}
            hint={<span className="wrap-anywhere">{contacts.phone}</span>}
          />
        </RadioGroup>
      ) : (
        <p className="min-w-0 text-md wrap-anywhere text-secondary">
          {m.settings_password_code_goes_to({ destination })}
        </p>
      )}
      <SendCodeRow codeSending={codeSending} size={size}>
        <CodeInput
          size={size}
          className="min-w-0 flex-1"
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
        <DialogCancel isDisabled={saving} onPress={close}>
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

function BindForm({
  close,
  onBound,
  onSpent,
}: {
  close: () => void;
  onBound: (contacts: PasswordContacts) => void;
  onSpent: (problem: AccountPasswordProblem) => void;
}) {
  const size = useDialogControlSize();
  const requestCode = useServerFn(requestContactBindCodeFn);
  const bind = useServerFn(bindAccountContactFn);
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<AccountPasswordProblem | null>(null);
  const [saving, guard] = useSubmitGuard();
  const codeSending = useCodeSending<AccountPasswordProblem>({
    destination,
    request: (typed) => requestCode({ data: { destination: typed } }),
    setProblem: (next) => {
      if (next === "invalid_bind_token") return onSpent(next);
      setProblem(next);
    },
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseCodeDestination(destination);
    if (!parsed) return setProblem("invalid_destination");
    if (!isSignInCode(code.trim())) return;
    await guard(async () => {
      setProblem(null);
      try {
        const result = await bind({ data: { destination, code: code.trim() } });
        if (result.ok) {
          return onBound(
            parsed.kind === "email" && result.email
              ? { email: result.email }
              : parsed.kind === "phone" && result.phone
                ? { phone: result.phone }
                : {},
          );
        }
        onSpent(result.problem === "invalid_bind_token" ? "invalid_bind_token" : "bind_failed");
      } catch {
        onSpent("bind_failed");
      }
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-5 px-6 pt-5 pb-6">
      <Input
        size={size}
        label={m.settings_password_bind_destination()}
        name="destination"
        autoComplete="off"
        value={destination}
        onChange={(value) => {
          setDestination(value);
          setProblem(null);
        }}
        isInvalid={problem === "invalid_destination"}
      />
      <SendCodeRow codeSending={codeSending} size={size}>
        <CodeInput
          size={size}
          className="min-w-0 flex-1"
          value={code}
          onChange={setCode}
          isInvalid={false}
        />
      </SendCodeRow>
      {problem ? <ProblemLine problem={problem} /> : null}
      <DialogActions>
        <DialogCancel isDisabled={saving} onPress={close}>
          {m.controls_cancel()}
        </DialogCancel>
        <DialogAction
          type="submit"
          isDisabled={!isSignInCode(code.trim()) || saving}
          isLoading={saving}
          showTextWhileLoading
        >
          {m.settings_password_bind_confirm()}
        </DialogAction>
      </DialogActions>
    </form>
  );
}
