import type { ReactNode } from "react";

import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { m } from "#src/paraglide/messages";
import type { useCodeSending } from "./use-code-sending";

/** What the problems of asking for a code and typing it say, for the forms that do both. */
export const codeProblemText = {
  invalid_destination: () => m.login_invalid_destination(),
  invalid_code: () => m.login_invalid_code(),
  rate_limited: () => m.login_rate_limited(),
  send_failed: () => m.login_send_failed(),
};

/** The field a verification code is typed in. */
export function CodeInput({
  value,
  onChange,
  isInvalid,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  isInvalid: boolean;
  className?: string;
}) {
  return (
    <Input
      label={m.login_code_label()}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      className={className}
      value={value}
      onChange={onChange}
      isInvalid={isInvalid}
    />
  );
}

/** A field with the button that sends a code beside it, counting the minute down before another. */
export function SendCodeRow({
  codeSending: { sending, secondsLeft, onSend },
  children,
}: {
  codeSending: ReturnType<typeof useCodeSending>;
  /** The field, which takes the row's width (`min-w-0 flex-1`). */
  children: ReactNode;
}) {
  return (
    <div className="flex items-end gap-3">
      {children}
      <Button
        type="button"
        color="secondary"
        size="md"
        className="shrink-0"
        isLoading={sending}
        isDisabled={secondsLeft > 0}
        onPress={onSend}
      >
        {secondsLeft > 0 ? m.login_code_resend_in({ seconds: secondsLeft }) : m.login_code_send()}
      </Button>
    </div>
  );
}
