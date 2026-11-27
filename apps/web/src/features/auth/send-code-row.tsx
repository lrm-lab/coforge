import type { ReactNode } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";

import { Button } from "#src/components/base/buttons/button";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "#src/components/ui/input-otp";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import type { useCodeSending } from "./use-code-sending";

export const VERIFICATION_CODE_LENGTH = 6;

const FIRST_GROUP = [0, 1, 2] as const;
const SECOND_GROUP = [3, 4, 5] as const;

const stripNonDigits = (pasted: string) => pasted.replace(/\D/g, "");

export const codeProblemText = {
  invalid_destination: () => m.login_invalid_destination(),
  invalid_code: () => m.login_invalid_code(),
  rate_limited: () => m.login_rate_limited(),
  send_failed: () => m.login_send_failed(),
};

export function CodeInput({
  value,
  onChange,
  isInvalid,
  className,
  size = "md",
}: {
  value: string;
  onChange: (value: string) => void;
  isInvalid: boolean;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const slotClass =
    size === "lg"
      ? "h-11 w-9 text-md font-mono sm:h-12 sm:w-11 sm:text-lg"
      : "h-11 w-9 text-md font-mono sm:h-11 sm:w-10";

  return (
    <InputOTP
      name="code"
      maxLength={VERIFICATION_CODE_LENGTH}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={stripNonDigits}
      value={value}
      onChange={onChange}
      aria-label={m.login_code_label()}
      aria-invalid={isInvalid || undefined}
      containerClassName={cn("justify-center gap-2 sm:gap-2.5", className)}
    >
      <InputOTPGroup className="gap-1.5 sm:gap-2">
        {FIRST_GROUP.map((index) => (
          <InputOTPSlot key={index} index={index} className={slotClass} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup className="gap-1.5 sm:gap-2">
        {SECOND_GROUP.map((index) => (
          <InputOTPSlot key={index} index={index} className={slotClass} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

export function SendCodeRow({
  codeSending: { sending, secondsLeft, onSend },
  children,
}: {
  codeSending: ReturnType<typeof useCodeSending>;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-secondary">{m.login_code_label()}</span>
        <Button
          type="button"
          color="secondary"
          size="sm"
          className="shrink-0 pointer-coarse:min-h-11"
          isLoading={sending}
          isDisabled={secondsLeft > 0}
          onPress={onSend}
        >
          {secondsLeft > 0 ? m.login_code_resend_in({ seconds: secondsLeft }) : m.login_code_send()}
        </Button>
      </div>
      {children}
    </div>
  );
}
