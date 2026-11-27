import { useEffect, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";

import { HintText } from "#src/components/base/input/hint-text";
import { Input } from "#src/components/base/input/input";
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

  useEffect(() => {
    onStateChange({ busy: saving, dirty: destination.trim() !== "" || code.trim() !== "" });
  }, [saving, destination, code, onStateChange]);

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
      <SendCodeRow codeSending={codeSending}>
        <CodeInput size={size} value={code} onChange={setCode} isInvalid={false} />
      </SendCodeRow>
      {problem ? <ProblemLine problem={problem} /> : null}
      <DialogActions>
        <DialogCancel isDisabled={saving} onPress={requestClose}>
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
